import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { JsonValue } from '@schema/index.js';
import { color, space } from './styles/tokens.stylex.js';
import { DOM, withDomClass } from './dom-contract.js';
import { SessionProvider, isTextEntryTarget, useSession, useSessionSnapshot } from './hooks.js';
import { EditorSession } from './state/editor-session.js';
import { ProjectHome } from './panels/ProjectHome.js';
import { Hierarchy } from './panels/Hierarchy.js';
import { Inspector } from './panels/Inspector.js';
import { Toolbar } from './panels/Toolbar.js';
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

const LAYOUT_KEY = 'coilbox.layout.v1';

interface Layout {
  left: number;
  right: number;
  bottom: number;
}

const DEFAULT_LAYOUT: Layout = { left: 260, right: 320, bottom: 150 };

/**
 * Shell chrome.
 *
 * `.studio-body` keeps its grid template inline because the tracks come from the stored layout at
 * runtime; everything else here is static. `.left-panel`/`.right-panel` were one rule, so they stay
 * one style applied to two elements rather than two styles that could drift apart.
 */
const styles = stylex.create({
  studio: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  studioBody: {
    flex: 1,
    display: 'grid',
    minHeight: 0,
    gap: '1px',
    backgroundColor: color.line,
  },
  sidePanel: {
    backgroundColor: color.panel,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  centerPanel: {
    backgroundColor: '#101319',
    minHeight: 0,
    position: 'relative',
  },
  bottomHost: {
    gridColumn: '1 / -1',
    backgroundColor: color.panel,
    minHeight: 0,
    overflow: 'hidden',
  },
  statusbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    paddingBlock: space.xs,
    paddingInline: space.md,
    backgroundColor: color['panel-2'],
    borderBlockStartWidth: '1px',
    borderBlockStartStyle: 'solid',
    borderBlockStartColor: color.line,
    color: color.muted,
    fontVariantNumeric: 'tabular-nums',
  },
  statusbarSpacer: {
    flex: 1,
  },
  playState: {
    color: color.ok,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
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
            <div {...stylex.props(styles.sidePanel)}>
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
            <div {...stylex.props(styles.sidePanel)}>
              <Inspector locked={editorLocked} />
            </div>
            <div {...stylex.props(styles.bottomHost)}>
              <BottomPanel onReloadScene={() => void session.reloadScene()} />
            </div>
          </div>
          <footer {...withDomClass(styles.statusbar, DOM.statusbar)}>
            <span>{status || 'Ready'}</span>
            <span {...withDomClass(styles.statusbarSpacer, DOM.toolbarSpacer)} />
            <span>{snapshot.sceneId ? `scene ${snapshot.sceneId}` : 'no scene'}</span>
            <span>{snapshot.dirty ? 'unsaved changes' : 'saved'}</span>
            {playState !== 'stopped' && (
              <span {...stylex.props(styles.playState)}>{playState}</span>
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
