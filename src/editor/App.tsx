import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { JsonValue } from '@schema/index.js';
import { color, fontSize, radius, space, surface } from './styles/tokens.stylex.js';
import { DOM, withDomClass } from './dom-contract.js';
import { SessionProvider, isTextEntryTarget, useSession, useSessionSnapshot } from './hooks.js';
import { EditorSession } from './state/editor-session.js';
import { ProjectHome } from './panels/ProjectHome.js';
import { Hierarchy } from './panels/Hierarchy.js';
import { Inspector } from './panels/Inspector.js';
import { Toolbar, SaveIndicator } from './panels/Toolbar.js';
import { BottomPanel } from './panels/BottomPanel.js';
import { Viewport, type PlayState, type ViewportHandle } from './panels/Viewport.js';
import type { SnapSettings, TransformTool } from './viewport/viewport-controller.js';
import { isFiniteJsonNumber, isJsonString, jsonField } from './json-values.js';

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
const LAYOUT_KEY = 'coilbox.layout.v4';

interface Layout {
  left: number;
  right: number;
  bottom: number;
}

const DEFAULT_LAYOUT: Layout = { left: 256, right: 320, bottom: 132 };

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
    gridColumn: '1 / -1',
    minHeight: 0,
    minWidth: 0,
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

/** Panel sizes from browser storage: this module wrote them, and every field is range-checked. */
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
  const [layout] = useState<Layout>(() => loadLayout());
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
      if (editorLocked || isTextEntryTarget(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
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
            style={{ gridTemplateColumns: `${layout.left}px 1fr ${layout.right}px`, gridTemplateRows: `1fr ${layout.bottom}px` }}
          >
            <div {...stylex.props(surface.panel, surface.edgeEnd, surface.edgeBottom)}>
              <Hierarchy locked={editorLocked} />
            </div>
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
            </div>
            <div {...stylex.props(surface.panel, surface.edgeStart, surface.edgeBottom)}>
              <Inspector locked={editorLocked} />
            </div>
            <div {...stylex.props(styles.bottomHost, surface.panel, surface.edgeBottom)}>
              <BottomPanel onReloadScene={() => void session.reloadScene()} />
            </div>
          </div>
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
