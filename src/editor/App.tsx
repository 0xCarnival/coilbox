import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { JsonValue } from '@schema/index.js';
import { activeCameraEntityId } from '@runtime/scene-graph.js';
import { color, controlSize, fontSize, radius, space, surface } from './styles/tokens.stylex.js';
import { DOM, withDomClass } from './dom-contract.js';
import { SessionProvider, isTextEntryTarget, useSession, useSessionSnapshot } from './hooks.js';
import { EditorSession } from './state/editor-session.js';
import { ProjectHome } from './panels/ProjectHome.js';
import { Hierarchy } from './panels/Hierarchy.js';
import { Inspector } from './panels/Inspector.js';
import { Toolbar, SaveIndicator } from './panels/Toolbar.js';
import { BottomPanel, type BottomTab } from './panels/BottomPanel.js';
import { Viewport, type PlayState, type ViewportDisplay, type ViewportHandle } from './panels/Viewport.js';
import type { CameraPlanes, SnapSettings, TransformTool, ViewFace } from './viewport/viewport-controller.js';
import { isFiniteJsonNumber, isJsonString, jsonField } from './json-values.js';
import { IconRail } from './ui/IconRail.js';
import { ResizeHandle } from './ui/ResizeHandle.js';
import { HintCard } from './ui/HintCard.js';
import { ViewGizmo } from './ui/ViewGizmo.js';
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

/** How far one numpad turn moves the view. Blender's own step is 15°. */
const VIEW_STEP_RADIANS = Math.PI / 12;

/**
 * Which view digit a key press is, from the numpad or the top row.
 *
 * `event.code` rather than `event.key`, because with Num Lock off a numpad digit reports "End" or
 * "ArrowLeft" as its key and the shortcut would quietly stop working for anyone who has it off. Both
 * layouts are accepted because most laptops have no numpad at all, and no other editor shortcut uses
 * a bare digit — so there is nothing for them to collide with.
 */
function numpadDigit(code: string): string | null {
  const match = /^(?:Numpad|Digit)([0-9])$/u.exec(code);
  return match ? (match[1] ?? null) : null;
}

/**
 * The scene's active game camera, resolved by the runtime's own rule.
 *
 * This used to pick `activeCameraId` if it existed and otherwise the first camera in raw array order,
 * which is not what the runtime does: the runtime drops disabled entities and the children of a
 * disabled parent, sorts by `order` then id, and skips editor helpers. So key 0 could show a camera
 * the game would never use — a disabled one, or a different one from the same scene. Asking the
 * runtime for the id is the only way the preview and the game cannot disagree.
 */
function activeGameCamera(
  scene: EditorSession['scene'],
): ({ id: string; name: string } & CameraPlanes) | null {
  if (!scene) return null;
  const id = activeCameraEntityId(scene);
  const entity = id === null ? undefined : scene.entities.find((candidate) => candidate.id === id);
  const component = entity?.components.find((candidate) => candidate.type === 'camera');
  if (!entity || !component || component.type !== 'camera') return null;
  return { id: entity.id, name: entity.name, fov: component.fov, near: component.near, far: component.far };
}

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
  /**
   * The two view overlays the gizmo's menu switches, mirrored from the viewport.
   *
   * They live on Three objects — a grid helper and the renderer's shadow map — so the viewport owns
   * them and this is a copy for the menu's ticks. The Display panel used to hold them the same way;
   * the copy is re-read from the viewport below rather than trusted, because a re-render never touches
   * the objects themselves.
   */
  const [grid, setGrid] = useState(true);
  const [shadows, setShadows] = useState(true);
  /** Whether the stage is currently showing the game camera's view, for the palette's label. */
  const [cameraView, setCameraView] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(layout));
  }, [layout]);

  /**
   * Read the live overlay values back once the viewport exists.
   *
   * Deferred by a frame for the same reason the panel deferred it: the handle is assigned in an effect
   * below this one, so on the first render it exists but the Three objects behind it may not, and
   * reading through it would report defaults that are not what is on screen.
   */
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const display = viewportRef.current?.display();
      if (!display) return;
      setGrid(display.grid);
      setShadows(display.shadows);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // Test hook: the browser checks drive the same handle the toolbar buttons use.
  useEffect(() => {
    const studio = window.__STUDIO__;
    if (studio) studio.viewport = () => viewportRef.current;
    return () => {
      if (studio) delete studio.viewport;
    };
  }, []);

  const editorLocked = playState !== 'stopped';

  /**
   * Apply an overlay switch, then read both back.
   *
   * The read-back is the point: the ticks in the gizmo's menu describe Three objects this component
   * does not own, and setting React state from the requested value instead of the applied one is how
   * a tick comes to disagree with the grid it claims to describe.
   */
  const setOverlay = (next: Partial<ViewportDisplay>) => {
    viewportRef.current?.setDisplay(next);
    const display = viewportRef.current?.display();
    if (!display) return;
    setGrid(display.grid);
    setShadows(display.shadows);
  };

  /**
   * Look through the scene's game camera, or leave it.
   *
   * Its own callback because two callers need it — numpad 0 and the command palette — and the
   * alternative was the palette synthesising a keyboard event to reach the key handler, which is a
   * lie about what happened and needed a `SAFETY:` comment to tell it.
   */
  const toggleCameraView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (viewport.inCameraView()) {
      viewport.exitCameraView();
      setCameraView(false);
      setStatus('Left the game camera');
      return;
    }
    const camera = activeGameCamera(session.scene);
    /**
     * A key that does nothing is a bug report waiting to happen, so a scene without a camera says so
     * in the console as well as the status line.
     */
    if (!camera) {
      setStatus('This scene has no camera to look through');
      session.log('warning', 'Numpad 0: this scene has no camera to look through.');
      return;
    }
    const entered = viewport.enterCameraView(camera.id, {
      fov: camera.fov,
      near: camera.near,
      far: camera.far,
    });
    setCameraView(entered);
    setStatus(entered ? `Looking through “${camera.name}”` : `“${camera.name}” is not in the viewport`);
  }, [session]);

  /**
   * Numpad view navigation, following Blender.
   *
   * 1/3/7 look along Z, X and Y; Ctrl takes the opposite side, which is where Blender puts Back,
   * Left and Bottom. 2/4/6/8 turn the view in 15° steps, 9 turns it half way round, 5 swaps
   * perspective and orthographic, and 0 looks through the scene's own camera.
   *
   * Returns whether the key was a view command, so the caller can stop looking — the view keys are
   * the only editor shortcuts that are bare digits, and claiming one that is not ours would be worse
   * than not handling it at all.
   */
  const handleViewKey = useCallback(
    (event: KeyboardEvent): boolean => {
      const digit = numpadDigit(event.code);
      const viewport = viewportRef.current;
      if (digit === null || !viewport) return false;
      /** Ctrl is Blender's "the other side of this axis", not a modifier on the same view. */
      const sign: 1 | -1 = event.ctrlKey || event.metaKey ? -1 : 1;
      /**
       * Every command below except 0 calls something that leaves the game camera's view, so the
       * shell's copy of that state is re-read from the viewport rather than assumed. Without this,
       * Numpad 0 then Numpad 1 left the palette offering "Leave the game camera" for a view that had
       * already been left.
       */
      const finish = (): true => {
        setCameraView(viewport.inCameraView());
        return true;
      };

      switch (digit) {
        case '1':
          viewport.faceView({ axis: 'z', sign });
          return finish();
        case '3':
          viewport.faceView({ axis: 'x', sign });
          return finish();
        case '7':
          viewport.faceView({ axis: 'y', sign });
          return finish();
        case '9':
          viewport.oppositeView();
          return finish();
        case '5':
          setStatus(
            viewport.toggleProjection() === 'orthographic' ? 'Orthographic view' : 'Perspective view',
          );
          return finish();
        case '4':
          viewport.orbitAround(-VIEW_STEP_RADIANS, 0);
          return finish();
        case '6':
          viewport.orbitAround(VIEW_STEP_RADIANS, 0);
          return finish();
        case '2':
          viewport.orbitAround(0, -VIEW_STEP_RADIANS);
          return finish();
        case '8':
          viewport.orbitAround(0, VIEW_STEP_RADIANS);
          return finish();
        case '0':
          toggleCameraView();
          return true;
        default:
          return false;
      }
    },
    [toggleCameraView],
  );

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
      /**
       * The view keys are read from `code`, and before anything that reads `key`.
       *
       * With Num Lock off a numpad digit reports "Home", "End", "ArrowLeft" as its `key`, so Numpad 7
       * was being taken by the frame-everything branch below and the top view was unreachable for
       * anyone with Num Lock off — which is most of the time. `code` is the only field that says which
       * physical key was pressed.
       */
      if (handleViewKey(event)) {
        /**
         * Ctrl/Cmd + a digit is a tab switch in every mainstream browser, and Ctrl/Cmd + 1/3/7 is
         * exactly how the opposite faces are reached — so without this the editor changes view and
         * the browser changes tab, or the browser wins and the editor does nothing.
         */
        event.preventDefault();
        return;
      }
      if (event.code === 'Home') {
        viewportRef.current?.frameAll();
        return;
      }
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
      if (meta && event.key.toLowerCase() === 'd') {
        if (session.duplicateSelection()) event.preventDefault();
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
  }, [editorLocked, session, handleViewKey]);

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
              <IconRail active={railPanel} onSelect={selectRailPanel} declared={snapshot.panels} />
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
              <ViewGizmo
                viewport={viewportRef}
                visible={!editorLocked}
                grid={grid}
                onGridChange={(next) => setOverlay({ grid: next })}
                shadows={shadows}
                onShadowsChange={(next) => setOverlay({ shadows: next })}
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
            view={{
              face: (face: ViewFace) => viewportRef.current?.faceView(face),
              opposite: () => viewportRef.current?.oppositeView(),
              toggleProjection: () => void viewportRef.current?.toggleProjection(),
              /** The same callback numpad 0 uses, so the two cannot come to mean different things. */
              cameraView: toggleCameraView,
              frameAll: () => viewportRef.current?.frameAll(),
              inCameraView: cameraView,
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
