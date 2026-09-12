import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { JsonValue } from '@schema/index.js';
import { color, controlSize, fontSize, radius, space, surface } from './styles/tokens.stylex.js';
import { DOM, withDomClass } from './dom-contract.js';
import { SessionProvider, isTextEntryTarget, useSession, useSessionSnapshot } from './hooks.js';
import { EditorSession } from './state/editor-session.js';
import { ProjectHome } from './panels/ProjectHome.js';
import { Hierarchy } from './panels/Hierarchy.js';
import { Inspector } from './panels/Inspector.js';
import { Toolbar, SaveIndicator } from './panels/Toolbar.js';
import { BottomPanel, type BottomTab } from './panels/BottomPanel.js';
import { Viewport, type PlayState, type ViewportHandle } from './panels/Viewport.js';
import type { SnapSettings, TransformTool } from './viewport/viewport-controller.js';
import { isFiniteJsonNumber, isJsonString, jsonField } from './json-values.js';
import { IconRail } from './ui/IconRail.js';
import { ResizeHandle } from './ui/ResizeHandle.js';
import { HintCard } from './ui/HintCard.js';
import { DisplayPanel } from './ui/DisplayPanel.js';
import { MeasurementOverlay } from './ui/MeasurementOverlay.js';
/**
 * The command palette is loaded on demand.
 *
 * It is the only consumer of Radix's Dialog and it opens on a keystroke, so bundling it with the
 * shell means every session pays for a modal most never open. `lazy` splits it into its own chunk,
 * which the browser fetches the first time someone presses the shortcut.
 */
const CommandPalette = lazy(() =>
  import('./ui/CommandPalette.js').then((module) => ({ default: module.CommandPalette })),
);
import { Toasts } from './ui/Toasts.js';
import { ToolDock } from './ui/ToolDock.js';

/**
 * Editor shell: one fixed, resizable layout instead of a window manager (plan §3).
 *
 * Panel sizes are remembered in browser storage, which is allowed to remember layout but is
 * never the authoritative project store.
 */

/**
 * The key is versioned because a stored layout outlives the design that chose its defaults: the
 * bottom panel's default shrank with the new density, and anyone who had already opened the editor
 * would otherwise keep the old, taller console forever. Bumping the version is what makes a new
 * default actually reach an existing install.
 */
const LAYOUT_KEY = 'coilbox.layout.v5';

interface Layout {
  left: number;
  right: number;
  bottom: number;
}

const DEFAULT_LAYOUT: Layout = { left: 300, right: 320, bottom: 132 };

/**
 * Shell chrome.
 *
 * The layout is the reference editor's: a **flush** workspace of bordered columns meeting at hard
 * 1px edges, not a set of rounded cards on a gutter. The previous version's insets and radii were
 * an invention of this editor's, and they are what made the workspace read as four unrelated boxes
 * — the reference's panels are a single continuous surface divided by hairlines, so the eye reads
 * the stage as the content and the panels as its frame.
 *
 * `.studio-body` keeps its grid template inline because the tracks come from the stored layout at
 * runtime; everything else here is static. Panels spread `surface.panel`, so "what is a panel" has
 * one definition.
 */
const styles = stylex.create({
  studio: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: color.bg,
  },
  studioBody: {
    flex: 1,
    display: 'grid',
    minHeight: 0,
    backgroundColor: color.bg,
  },
  centerPanel: {
    minHeight: 0,
    minWidth: 0,
    position: 'relative',
    backgroundColor: color.bg,
    overflow: 'hidden',
  },
  bottomHost: {
    gridColumn: '2 / -1',
    minHeight: 0,
    minWidth: 0,
  },
  /** The left column anchors the resize handle to its leading edge. */
  leftColumn: {
    position: 'relative',
    minHeight: 0,
  },
  /** The rail spans both rows, so it is a full-height spine down the left edge. */
  railHost: {
    gridRow: '1 / -1',
    display: 'flex',
    minHeight: 0,
  },
  /**
   * The status bar: 28px of quiet text at the bottom of the window, separated by a hairline. Their
   * editor has no status bar at all, so this keeps the previous placement but drops to their
   * `text-xs` on `muted` rather than the near-invisible tier it was using.
   */
  statusbar: {
    display: 'flex',
    alignItems: 'center',
    gap: space.lg,
    height: '28px',
    paddingInline: space.lg,
    backgroundColor: color.bg,
    borderBlockStartWidth: '1px',
    borderBlockStartStyle: 'solid',
    borderBlockStartColor: color.border,
    color: color.muted,
    fontSize: fontSize.xs,
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  },
  statusbarSpacer: {
    flex: 1,
  },
  /**
   * The live play state. A small filled dot and a word: the one place the status bar is allowed to
   * be brighter than its neighbours, so a running simulation is visible at a glance.
   */
  playState: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    color: color.text,
    fontWeight: 500,
  },
  playDot: {
    width: '6px',
    height: '6px',
    borderRadius: radius.pill,
    backgroundColor: color.ok,
  },
});

/**
 * Whether a rail panel id names a bottom tab.
 *
 * A type predicate rather than a cast: the rail's ids are strings, the bottom panel's tabs are a
 * union, and the narrowing has to be a runtime check rather than an assertion about a value that
 * arrived from a click handler.
 */
function isBottomTab(id: string): id is BottomTab {
  return id === 'assets' || id === 'scenes' || id === 'console';
}


function loadLayout(): Layout {
  try {
    const raw = globalThis.localStorage?.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const stored: JsonValue = JSON.parse(raw);
    return {
      left: clampNumber(jsonField(stored, 'left'), 180, 520, DEFAULT_LAYOUT.left),
      right: clampNumber(jsonField(stored, 'right'), 220, 620, DEFAULT_LAYOUT.right),
      bottom: clampNumber(jsonField(stored, 'bottom'), 90, 420, DEFAULT_LAYOUT.bottom),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function clampNumber(value: JsonValue, min: number, max: number, fallback: number): number {
  if (!isFiniteJsonNumber(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** The `/build` response: where the export landed, or what went wrong. */
interface ExportResult {
  message: string | null;
  relativeOutDir: string | null;
}

function readExportResult(payload: JsonValue): ExportResult {
  const message = jsonField(payload, 'message');
  const relativeOutDir = jsonField(payload, 'relativeOutDir');
  return {
    message: isJsonString(message) ? message : null,
    relativeOutDir: isJsonString(relativeOutDir) ? relativeOutDir : null,
  };
}

export function App({ session }: { session: EditorSession }): JSX.Element {
  return (
    <SessionProvider session={session}>
      <StudioShell />
    </SessionProvider>
  );
}

function StudioShell(): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const viewportRef = useRef<ViewportHandle | null>(null);
  const [playState, setPlayState] = useState<PlayState>('stopped');
  const [tool, setTool] = useState<TransformTool>('translate');
  const [snap, setSnap] = useState<SnapSettings>({ enabled: false, translate: 0.5, rotateDegrees: 15, scale: 0.25 });
  const [status, setStatus] = useState<string>('');
  const [layout, setLayout] = useState<Layout>(() => loadLayout());
  /**
   * The rail drives two things at once: which panel column is showing, and which bottom tab.
   *
   * `objects` is the hierarchy column; the other three are tabs in the bottom panel. Collapsing is
   * tracked separately from the width so that reopening restores the width the user had, rather
   * than snapping back to the default.
   */
  const [railPanel, setRailPanel] = useState('objects');
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTab>('console');
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Whether the dimension overlay is drawn. An editor preference, like the unit system. */
  const [measurements, setMeasurements] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(layout));
  }, [layout]);

  // Test hook: the browser checks drive the same handle the toolbar buttons use.
  useEffect(() => {
    const studio = window.__STUDIO__;
    if (studio) studio.viewport = () => viewportRef.current;
    return () => {
      if (studio) delete studio.viewport;
    };
  }, []);

  const editorLocked = playState !== 'stopped';

  // Editor shortcuts only fire while the viewport owns the keyboard (plan §3). Text fields
  // and Play mode never trigger them.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      /**
       * The palette opens from anywhere, including from inside a text field.
       *
       * That is why it is checked before the text-entry guard below: a palette that refuses to open
       * while the search box has focus is a palette you cannot reach at the moment you most want it.
       */
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (editorLocked || isTextEntryTarget(event.target)) return;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) session.redo();
        else session.undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void session.save();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const selection = session.selection.selectedIds;
        if (selection.length === 0) return;
        event.preventDefault();
        session.execute({ kind: 'deleteEntities', entityIds: [...selection] });
        return;
      }
      if (event.key === 'Escape') {
        // A drag in progress is abandoned instead of committed (plan §16 "drag cancellation");
        // otherwise Escape recentres the view on the selection.
        if (viewportRef.current?.cancelDrag()) return;
        const primary = session.selection.primary;
        if (primary && session.scene) viewportRef.current?.focusSelection();
        return;
      }
      if (event.key === 'f' || event.key === 'F') {
        viewportRef.current?.focusSelection();
        return;
      }
      if (event.key === 'w' || event.key === 'W') setTool('translate');
      if (event.key === 'e' || event.key === 'E') setTool('rotate');
      if (event.key === 'r' || event.key === 'R') setTool('scale');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editorLocked, session]);

  /**
   * A rail click selects a panel. Selecting the hierarchy toggles its column; selecting one of the
   * project panels also brings the bottom panel to the matching tab, so the icon and the visible
   * content can never disagree.
   */
  const selectRailPanel = useCallback((id: string) => {
    setRailPanel(id);
    if (id === 'objects') {
      setLeftCollapsed((collapsed) => !collapsed);
      return;
    }
    setLeftCollapsed(false);
    if (isBottomTab(id)) setBottomTab(id);
  }, []);

  const exportGame = useCallback(async () => {
    if (!snapshot.project) return;
    setExporting(true);
    setStatus('Exporting…');
    try {
      // Save first: an export of stale content would be a silent lie.
      if (session.document?.isDirty) await session.save();
      const response = await fetch(`/api/projects/${encodeURIComponent(snapshot.project.id)}/build`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-coilbox-token': await session.client.sessionToken(),
        },
        body: '{}',
      });
      const payload: JsonValue = await response.json();
      const result = readExportResult(payload);
      if (!response.ok) {
        session.log('error', `Export failed: ${result.message ?? response.statusText}`);
        setStatus(`Export failed: ${result.message ?? response.statusText}`);
        return;
      }
      session.log('info', `Exported to ${result.relativeOutDir}`);
      setStatus(`Exported to ${result.relativeOutDir} — serve it with any static server`);
    } catch (error) {
      session.log('error', 'Export failed', String(error));
      setStatus(`Export failed: ${String(error)}`);
    } finally {
      setExporting(false);
    }
  }, [session, snapshot.project]);

  const openProject = snapshot.project !== null;

  return (
    <div {...withDomClass(styles.studio, DOM.studio)}>
      {!openProject ? (
        <ProjectHome />
      ) : (
        <>
          <Toolbar
            viewport={viewportRef}
            playState={playState}
            tool={tool}
            snap={snap}
            onToolChange={setTool}
            onSnapChange={setSnap}
            onExport={() => void exportGame()}
            exporting={exporting}
          />
          <div
            {...withDomClass(styles.studioBody, DOM.studioBody)}
            style={{
              gridTemplateColumns: `${controlSize.rail} ${leftCollapsed ? 0 : layout.left}px 1fr ${layout.right}px`,
              gridTemplateRows: `1fr ${layout.bottom}px`,
            }}
          >
            <div {...stylex.props(styles.railHost)}>
              <IconRail active={railPanel} onSelect={selectRailPanel} />
            </div>
            {/**
             * The hierarchy column collapses to zero rather than to a minimum. A panel shrunk to a
             * sliver is worse than no panel: the rail stays, so the way back is always visible.
             */}
            {!leftCollapsed && (
              <div {...stylex.props(styles.leftColumn, surface.panel, surface.edgeEnd, surface.edgeBottom)}>
                <Hierarchy locked={editorLocked} />
                {/**
                 * The resize handle is absolutely positioned into the boundary between the rail and
                 * the column rather than given a grid track. A track would add its width to the
                 * layout; this overlays the seam that is already there, so the handle is draggable
                 * without the workspace gaining a permanent 7px of nothing.
                 */}
                <ResizeHandle
                  label="Resize the scene panel"
                  width={layout.left}
                  min={220}
                  max={520}
                  collapseBelow={200}
                  onCollapse={() => setLeftCollapsed(true)}
                  onResize={(next) => setLayout((current) => ({ ...current, left: next }))}
                />
              </div>
            )}
            <div {...stylex.props(styles.centerPanel)}>
              <Viewport
                handleRef={viewportRef}
                tool={tool}
                snap={snap}
                onPlayStateChange={setPlayState}
                onStatus={(message) => {
                  setStatus(message);
                  session.log('warning', message);
                }}
              />
              {/**
               * The selection's own verbs, floating over the stage rather than living in the
               * inspector footer. The viewport owns the focus action, so the bar is mounted beside
               * it rather than inside the inspector.
               */}
              {/**
               * One card, not two. The badge above the stage named the selection and the hint card
               * explains it; two floating overlays over one canvas is one too many, and the card
               * carries both facts.
               */}
              <HintCard tool={tool} visible={!editorLocked} />
              <DisplayPanel
                viewport={viewportRef}
                snap={snap}
                onSnapChange={setSnap}
                measurements={measurements}
                onMeasurementsChange={setMeasurements}
              />
              <MeasurementOverlay viewport={viewportRef} visible={!editorLocked && measurements} />
              <ToolDock
                tool={tool}
                onToolChange={setTool}
                onFocus={() => viewportRef.current?.focusSelection()}
                snap={snap}
                onSnapChange={setSnap}
                visible={!editorLocked}
              />
            </div>
            <div {...stylex.props(surface.panel, surface.edgeStart, surface.edgeBottom)}>
              <Inspector locked={editorLocked} />
            </div>
            <div {...stylex.props(styles.bottomHost, surface.panel, surface.edgeBottom)}>
              <BottomPanel
                onReloadScene={() => void session.reloadScene()}
                tab={bottomTab}
                onTabChange={setBottomTab}
              />
            </div>
          </div>
          {/**
           * Toasts float over the workspace and are suppressed while the console tab is showing:
           * repeating the line the user is already looking at is noise, not a notification.
           */}
          <Toasts enabled={bottomTab !== 'console'} />
          <Suspense fallback={null}>
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            onToolChange={setTool}
            onFocusSelection={() => viewportRef.current?.focusSelection()}
            playback={{
              play: () => void viewportRef.current?.play(),
              pause: () => viewportRef.current?.pause(),
              step: () => viewportRef.current?.step(),
              stop: () => viewportRef.current?.stop(),
              state: playState,
            }}
            onExport={() => void exportGame()}
          />
          </Suspense>
          <footer {...withDomClass(styles.statusbar, DOM.statusbar)}>
            <span>{status || 'Ready'}</span>
            <span {...withDomClass(styles.statusbarSpacer, DOM.toolbarSpacer)} />
            <span>{snapshot.sceneId ? `scene ${snapshot.sceneId}` : 'no scene'}</span>
            <SaveIndicator state={snapshot.saveState} lastSavedAt={snapshot.lastSavedAt} />
            {playState !== 'stopped' && (
              <span {...stylex.props(styles.playState)}>
                <span {...stylex.props(styles.playDot)} />
                {playState}
              </span>
            )}
          </footer>
        </>
      )}
    </div>
  );
}

export function useViewportHandle(): React.RefObject<ViewportHandle | null> {
  return useMemo(() => ({ current: null }), []);
}
