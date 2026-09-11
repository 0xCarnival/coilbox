import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { JSX } from 'react';
import type { SceneDocument, Transform } from '@schema/index.js';
import { RuntimeWorld, RuntimeWorldError } from '@runtime/world.js';
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
  const worldRef = useRef<RuntimeWorld | null>(null);
  const [playState, setPlayState] = useState<PlayState>('stopped');
  const [error, setError] = useState<string | null>(null);

  // Keep the latest callbacks without re-creating the viewport.
  const callbacksRef = useRef({ onPlayStateChange, onStatus });
  callbacksRef.current = { onPlayStateChange, onStatus };
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    const canvas = editorCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const viewport = new EditorViewport({
      canvas,
      container,
      onSelect: (entityId, additive) => sessionRef.current.select(entityId, { additive }),
      onCommitTransform: (entityId, transform: Partial<Transform>) => {
        sessionRef.current.execute({ kind: 'setTransform', entityId, transform }, { label: 'Move' });
      },
      onWarning: (message) => callbacksRef.current.onStatus(message),
    });
    viewportRef.current = viewport;
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
    worldRef.current?.dispose();
    worldRef.current = null;
    viewportRef.current?.resume();
    setPlayState('stopped');
    onPlayStateChange('stopped');
  }, [onPlayStateChange]);

  const play = useCallback(async () => {
    if (worldRef.current) return;
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
      const world = await RuntimeWorld.create({
        canvas,
        game,
        scene: currentScene,
        wasmLocateFile: () => wasmUrl,
        label: 'editor-play',
        onError: (runtimeError: RuntimeWorldError) => {
          setError(`${runtimeError.code}: ${runtimeError.message}`);
          sessionRef.current.log('error', runtimeError.message, runtimeError.code);
        },
      });
      worldRef.current = world;
      for (const warning of world.warnings) sessionRef.current.log('warning', warning);
      world.start();
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
  }, [onPlayStateChange]);

  const pause = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    if (world.getState() === 'paused') {
      world.resume();
      setPlayState('running');
      onPlayStateChange('running');
    } else {
      world.pause();
      setPlayState('paused');
      onPlayStateChange('paused');
    }
  }, [onPlayStateChange]);

  const step = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    world.pause();
    world.step();
    setPlayState('paused');
    onPlayStateChange('paused');
  }, [onPlayStateChange]);

  useEffect(() => () => {
    worldRef.current?.dispose();
    worldRef.current = null;
  }, []);

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
        const world = worldRef.current;
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
      playStats: () => (worldRef.current ? worldRef.current.getStats() : null),
    }),
    [play, pause, step, stopPlay],
  );

  return (
    <div className="viewport" ref={containerRef}>
      <canvas id="editor-canvas" ref={editorCanvasRef} tabIndex={0} />
      <canvas id="play-canvas" ref={playCanvasRef} className={playState === 'stopped' ? 'hidden' : ''} />
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
