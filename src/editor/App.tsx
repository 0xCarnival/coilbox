import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { SessionProvider, isTextEntryTarget, useSession, useSessionSnapshot } from './hooks.js';
import { EditorSession } from './state/editor-session.js';
import { ProjectHome } from './panels/ProjectHome.js';
import { Hierarchy } from './panels/Hierarchy.js';
import { Inspector } from './panels/Inspector.js';
import { Toolbar } from './panels/Toolbar.js';
import { BottomPanel } from './panels/BottomPanel.js';
import { Viewport, type PlayState, type ViewportHandle } from './panels/Viewport.js';
import type { SnapSettings, TransformTool } from './viewport/viewport-controller.js';

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

function loadLayout(): Layout {
  try {
    const raw = globalThis.localStorage?.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<Layout>;
    return {
      left: clampNumber(parsed.left, 180, 520, DEFAULT_LAYOUT.left),
      right: clampNumber(parsed.right, 220, 620, DEFAULT_LAYOUT.right),
      bottom: clampNumber(parsed.bottom, 90, 420, DEFAULT_LAYOUT.bottom),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
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
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(layout));
  }, [layout]);

  // Test hook: the browser checks drive the same handle the toolbar buttons use.
  useEffect(() => {
    const studio = (globalThis as unknown as { __STUDIO__?: { viewport?: () => ViewportHandle | null } }).__STUDIO__;
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
      const payload = (await response.json()) as { ok?: boolean; relativeOutDir?: string; message?: string; issues?: unknown[] };
      if (!response.ok) {
        session.log('error', `Export failed: ${payload.message ?? response.statusText}`);
        setStatus(`Export failed: ${payload.message ?? response.statusText}`);
        return;
      }
      session.log('info', `Exported to ${payload.relativeOutDir}`);
      setStatus(`Exported to ${payload.relativeOutDir} — serve it with any static server`);
    } catch (error) {
      session.log('error', 'Export failed', String(error));
      setStatus(`Export failed: ${String(error)}`);
    } finally {
      setExporting(false);
    }
  }, [session, snapshot.project]);

  const openProject = snapshot.project !== null;

  return (
    <div className="studio">
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
            className="studio-body"
            style={{ gridTemplateColumns: `${layout.left}px 1fr ${layout.right}px`, gridTemplateRows: `1fr ${layout.bottom}px` }}
          >
            <div className="panel left-panel">
              <Hierarchy locked={editorLocked} />
            </div>
            <div className="center-panel">
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
            <div className="panel right-panel">
              <Inspector locked={editorLocked} />
            </div>
            <div className="panel bottom-host">
              <BottomPanel onReloadScene={() => void session.reloadScene()} />
            </div>
          </div>
          <footer className="statusbar">
            <span>{status || 'Ready'}</span>
            <span className="toolbar-spacer" />
            <span>{snapshot.sceneId ? `scene ${snapshot.sceneId}` : 'no scene'}</span>
            <span>{snapshot.dirty ? 'unsaved changes' : 'saved'}</span>
            {playState !== 'stopped' && <span className="play-state">{playState}</span>}
          </footer>
        </>
      )}
    </div>
  );
}

export function useViewportHandle(): React.RefObject<ViewportHandle | null> {
  return useMemo(() => ({ current: null }), []);
}
