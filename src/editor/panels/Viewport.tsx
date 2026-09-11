import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { JSX } from 'react';
import type { SceneDocument, Transform } from '@schema/index.js';
import { RuntimeWorldError } from '@runtime/world.js';
import { RuntimeSession } from '@runtime/session.js';
import { AssetCache } from '@runtime/assets/loader.js';
import wasmUrl from 'virtual:box3d-wasm-url';
import { EditorViewport, type SnapSettings, type TransformTool } from '../viewport/viewport-controller.js';
import { useSession } from '../hooks.js';

/**
 * The viewport pane: an editor canvas plus a separate play canvas.
 *
 * Two canvases keep the two responsibilities apart (plan §8): the editor view is an
 * authoring projection with grid, handles, and helpers; Play builds a fresh runtime world
 * on its own canvas from a snapshot of the authored document. Stopping throws that world
 * away, which is why the authored scene cannot be left modified by a simulation.
 */

export type PlayState = 'stopped' | 'running' | 'paused';

export interface ViewportHandle {
  play(): Promise<void>;
  pause(): void;
  step(): void;
  stop(): void;
  focusSelection(): void;
  setTool(tool: TransformTool): void;
  setSnap(snap: SnapSettings): void;
  setColliderOutlines(visible: boolean): void;
  /** World position of an entity in the editor projection, for checks and debugging. */
  project(entityId: string): [number, number, number] | null;
  /** Read the play canvas after forcing a render (the drawing buffer is not preserved). */
  samplePlayPixels(): { width: number; height: number; distinctColors: number; nonBackgroundPixels: number } | null;
  /** Runtime statistics of the live play world, or null when stopped. */
  playStats(): unknown;
  /** Whether an entity's model is loading, loaded, or failed. */
  modelStatus(entityId: string): 'none' | 'loading' | 'loaded' | 'failed';
  clipNames(entityId: string): string[] | null;
  animationState(entityId: string): { clip: string | null; time: number; playing: boolean } | null;
  /** Animation state inside the running play world (independent of the editor preview). */
  playAnimationState(entityId: string): { clip: string | null; time: number; playing: boolean } | null;
  /** Game-state values of the running play world. */
  playGameState(): Record<string, unknown> | null;
  /** World position of an entity in the running play world. */
  playEntityTransform(entityId: string): [number, number, number] | null;
  /** Behavior instances of the running play world, for checks and debugging. */
  behaviorRuntime(): { size: number; list(): Array<{ entityId: string; behaviorId: string }> } | null;
}

export interface ViewportProps {
  handleRef?: Ref<ViewportHandle>;
  tool: TransformTool;
  snap: SnapSettings;
  onPlayStateChange(state: PlayState): void;
  onStatus(message: string): void;
}

export function Viewport({ handleRef, tool, snap, onPlayStateChange, onStatus }: ViewportProps): JSX.Element {
  const session = useSession();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<EditorViewport | null>(null);
  const sessionRef2 = useRef<RuntimeSession | null>(null);
  const assetCacheRef = useRef<AssetCache | null>(null);
  const hudRootRef = useRef<HTMLDivElement | null>(null);
  const [playState, setPlayState] = useState<PlayState>('stopped');
  const [error, setError] = useState<string | null>(null);

  // Keep the latest callbacks without re-creating the viewport.
  const callbacksRef = useRef({ onPlayStateChange, onStatus });
  callbacksRef.current = { onPlayStateChange, onStatus };
  const sessionRef = useRef(session);
  sessionRef.current = session;

  /** One asset cache per editor session: models stay loaded across Play/Stop cycles. */
  const assetCache = (() => {
    if (!assetCacheRef.current) {
      assetCacheRef.current = new AssetCache({
        resolver: session.assetResolver,
        describe: (assetId) => session.assetResolver.getEntry(assetId),
        onWarning: (message) => setError((current) => current ?? message),
      });
    }
    return assetCacheRef.current;
  })();

  useEffect(() => {
    const canvas = editorCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const viewport = new EditorViewport({
      onModelLoaded: (entityId, clips) => sessionRef.current.reportModelClips(entityId, clips),
      onModelFailed: (entityId, message) => {
        sessionRef.current.log('error', `Model for "${entityId}" did not load`, message);
      },
      canvas,
      container,
      onSelect: (entityId, additive) => sessionRef.current.select(entityId, { additive }),
      onCommitTransform: (entityId, transform: Partial<Transform>) => {
        sessionRef.current.execute({ kind: 'setTransform', entityId, transform }, { label: 'Move' });
      },
      onWarning: (message) => callbacksRef.current.onStatus(message),
    });
    viewportRef.current = viewport;
    viewport.setAssetProvider({
      instantiate: (assetId) => assetCache.instantiate(assetId),
      clipsFor: (assetId) => null,
    });
    viewport.start();
    viewport.setTool(tool);
    viewport.setSnap(snap);

    const scene = sessionRef.current.scene;
    if (scene) viewport.sync(scene);

    return () => {
      viewport.dispose();
      viewportRef.current = null;
    };
    // The viewport is created once; document changes flow through the sync effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Project the document whenever it changes.
  const scene = session.scene;
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !scene) return;
    viewport.sync(scene);
  }, [scene]);

  useEffect(() => {
    viewportRef.current?.setSelection(session.selection.selectedIds);
  }, [session, session.snapshot().selectedIds]);

  useEffect(() => {
    viewportRef.current?.setTool(tool);
  }, [tool]);

  useEffect(() => {
    viewportRef.current?.setSnap(snap);
  }, [snap]);

  const stopPlay = useCallback(() => {
    void sessionRef2.current?.dispose();
    sessionRef2.current = null;
    viewportRef.current?.resume();
    setPlayState('stopped');
    onPlayStateChange('stopped');
  }, [onPlayStateChange]);

  const play = useCallback(async () => {
    if (sessionRef2.current) return;
    const canvas = playCanvasRef.current;
    const currentScene: SceneDocument | null = sessionRef.current.scene;
    const game = sessionRef.current.game;
    if (!canvas || !currentScene || !game) {
      setError('No scene is open.');
      return;
    }
    setError(null);
    try {
      viewportRef.current?.suspend();
      const runtimeSession = await RuntimeSession.create({
        canvas,
        game,
        // Play always starts from a snapshot of the authored document, never from the live
        // scene the editor is projecting.
        scene: structuredClone(currentScene),
        resolveScene: async (sceneId) => {
          await sessionRef.current.openScene(sceneId);
          const loaded = sessionRef.current.scene;
          if (!loaded) throw new Error(`scene "${sceneId}" could not be loaded`);
          return structuredClone(loaded);
        },
        assets: sessionRef.current.assetResolver,
        assetCache,
        // Play uses the compiled behavior library — the same code an export ships. The
        // project's registry.json is metadata for the inspector and the validator, not the
        // executable registration.
        hudRoot: hudRootRef.current,
        wasmLocateFile: () => wasmUrl,
        label: 'editor-play',
        onLog: (level, message) => sessionRef.current.log(level, message),
        onError: (runtimeError: RuntimeWorldError) => {
          setError(`${runtimeError.code}: ${runtimeError.message}`);
          sessionRef.current.log('error', runtimeError.message, runtimeError.code);
        },
      });
      sessionRef2.current = runtimeSession;
      void runtimeSession.current?.activateAudio();
      setPlayState('running');
      onPlayStateChange('running');
    } catch (cause) {
      viewportRef.current?.resume();
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      sessionRef.current.log('error', 'Play failed', message);
      setPlayState('stopped');
      onPlayStateChange('stopped');
    }
  }, [assetCache, onPlayStateChange]);

  const pause = useCallback(() => {
    const runtimeSession = sessionRef2.current;
    if (!runtimeSession) return;
    if (runtimeSession.state === 'paused') {
      runtimeSession.resume();
      setPlayState('running');
      onPlayStateChange('running');
    } else {
      runtimeSession.pause();
      setPlayState('paused');
      onPlayStateChange('paused');
    }
  }, [onPlayStateChange]);

  const step = useCallback(() => {
    const runtimeSession = sessionRef2.current;
    if (!runtimeSession) return;
    runtimeSession.pause();
    runtimeSession.step();
    setPlayState('paused');
    onPlayStateChange('paused');
  }, [onPlayStateChange]);

  useEffect(() => () => {
    void sessionRef2.current?.dispose();
    sessionRef2.current = null;
  }, []);

  // Audio cannot start before a user gesture; the first click or key press activates it.
  useEffect(() => {
    if (playState === 'stopped') return;
    const activate = () => void sessionRef2.current?.current?.activateAudio();
    window.addEventListener('pointerdown', activate);
    window.addEventListener('keydown', activate);
    return () => {
      window.removeEventListener('pointerdown', activate);
      window.removeEventListener('keydown', activate);
    };
  }, [playState]);

  useImperativeHandle(
    handleRef,
    () => ({
      play,
      pause,
      step,
      stop: stopPlay,
      focusSelection: () => viewportRef.current?.focusSelection(),
      setTool: (next: TransformTool) => viewportRef.current?.setTool(next),
      setSnap: (next: SnapSettings) => viewportRef.current?.setSnap(next),
      setColliderOutlines: (visible: boolean) => viewportRef.current?.setColliderOutlinesVisible(visible),
      project: (entityId: string) => {
        const position = viewportRef.current?.entityWorldPosition(entityId);
        return position ? [position.x, position.y, position.z] : null;
      },
      samplePlayPixels: () => {
        const canvas = playCanvasRef.current;
        const world = sessionRef2.current?.current ?? null;
        if (!canvas || !world) return null;
        world.renderNow(1);
        const gl = canvas.getContext('webgl2');
        if (!gl) return null;
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const counts = new Map<number, number>();
        for (let index = 0; index < width * height; index += 1) {
          const offset = index * 4;
          const key = (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2];
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        let background = -1;
        for (const count of counts.values()) if (count > background) background = count;
        return { width, height, distinctColors: counts.size, nonBackgroundPixels: width * height - background };
      },
      playStats: () => sessionRef2.current?.stats() ?? null,
      modelStatus: (entityId: string) => viewportRef.current?.modelStatus(entityId) ?? 'none',
      clipNames: (entityId: string) => viewportRef.current?.clipNames(entityId) ?? null,
      animationState: (entityId: string) => viewportRef.current?.animationState(entityId) ?? null,
      playAnimationState: (entityId: string) => sessionRef2.current?.current?.getAnimationState(entityId) ?? null,
      playGameState: () => sessionRef2.current?.current?.getGameState().snapshot() ?? null,
      playEntityTransform: (entityId: string) => {
        const world = sessionRef2.current?.current;
        if (!world) return null;
        const sample = new Float32Array(7);
        if (!world.readEntityTransform(entityId, sample)) return null;
        return [sample[0]!, sample[1]!, sample[2]!];
      },
      behaviorRuntime: () => sessionRef2.current?.current?.getBehaviorRuntime() ?? null,
    }),
    [play, pause, step, stopPlay],
  );

  return (
    <div className="viewport" ref={containerRef}>
      <canvas id="editor-canvas" ref={editorCanvasRef} tabIndex={0} />
      <canvas id="play-canvas" ref={playCanvasRef} className={playState === 'stopped' ? 'hidden' : ''} />
      <div className="hud-host" ref={hudRootRef} />
      {playState !== 'stopped' && <div className="viewport-badge">Play mode — authoring is paused</div>}
      {error && (
        <div className="viewport-error" role="alert">
          {error}
          <button type="button" onClick={stopPlay}>
            Stop
          </button>
        </div>
      )}
    </div>
  );
}
