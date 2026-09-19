import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { JsonValue, SceneDocument, Transform } from '@schema/index.js';
import { RuntimeWorldError, type RuntimeStats } from '@runtime/world.js';
import { RuntimeSession } from '@runtime/session.js';
import { AssetCache, disposeInstance } from '@runtime/assets/loader.js';
import wasmUrl from 'virtual:box3d-wasm-url';
import { color, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { DOM, DOM_ID, withDomClass } from '../dom-contract.js';
import {
  EditorViewport,
  type CameraBasis,
  type CameraPlanes,
  type CanvasSize,
  type ScreenPoint,
  type SnapSettings,
  type TransformTool,
  type ViewFace,
} from '../viewport/viewport-controller.js';
import { useSession } from '../hooks.js';
import { applyAssetDrop, hasAssetDrag, readAssetDrag } from '../assets/asset-drop.js';

/**
 * The viewport pane: an editor canvas plus a separate play canvas.
 *
 * Two canvases keep the two responsibilities apart (plan §8): the editor view is an
 * authoring projection with grid, handles, and helpers; Play builds a fresh runtime world
 * on its own canvas from a snapshot of the authored document. Stopping throws that world
 * away, which is why the authored scene cannot be left modified by a simulation.
 */

/**
 * Viewport chrome.
 *
 * `.hud-host .coilbox-hud` is deliberately absent: the HUD is created by the runtime through
 * `document.createElement`, so it renders no `stylex` class and its positioning stays in
 * `base.css` where a descendant selector can reach it.
 */
const styles = stylex.create({
  viewport: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
  },
  dragging: {
    outlineWidth: '2px',
    outlineStyle: 'dashed',
    outlineColor: color.primary,
    outlineOffset: '-4px',
  },
  editorCanvas: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    display: 'block',
  },
  playCanvas: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    display: 'block',
  },
  canvasHidden: {
    visibility: 'hidden',
  },
  hudHost: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    overflow: 'hidden',
  },
  /**
   * The mode badge.
   *
   * It floats over the render, so it keeps a translucent surface rather than a solid one — a solid
   * chip in the corner of a viewport reads as part of the scene. The dot plus word is the same
   * treatment the status bar uses for the same fact, so "the editor is live" looks like one idea
   * in two places instead of two ideas.
   */
  badge: {
    position: 'absolute',
    top: space.sm,
    left: space.sm,
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: 'rgba(10, 11, 13, 0.72)',
    backdropFilter: 'blur(6px)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color['border-strong'],
    borderRadius: radius.pill,
    paddingBlock: '3px',
    paddingInline: space.sm,
    color: color.text,
    fontSize: fontSize.xs,
    fontWeight: 600,
    letterSpacing: '0.04em',
  },
  badgeDot: {
    width: '6px',
    height: '6px',
    borderRadius: radius.pill,
    backgroundColor: color.primary,
  },
  /**
   * A load failure is the one thing in the viewport that must not be missable, so it is the only
   * surface in the editor that gets a full semantic fill rather than a tint.
   */
  error: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    bottom: space.md,
    backgroundColor: 'rgba(46, 20, 18, 0.94)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.danger,
    color: '#f6ddd9',
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: radius.lg,
    display: 'flex',
    gap: space.md,
    alignItems: 'center',
    fontSize: fontSize.sm,
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5)',
  },
});

export type PlayState = 'stopped' | 'running' | 'paused';

/**
 * The editor view's display settings, as an overlay reads them back.
 *
 * A plain record rather than component state: the values live in Three objects, and this is the
 * snapshot shape a control compares against. The view mode used to be here as well; it is gone with
 * the 2D view, and the camera's orientation is now read as a basis instead — see `cameraBasis`.
 */
export interface ViewportDisplay {
  projection: 'perspective' | 'orthographic';
  grid: boolean;
  shadows: boolean;
}

export interface ViewportHandle {
  play(): Promise<void>;
  pause(): void;
  step(): void;
  stop(): void;
  focusSelection(): void;
  setTool(tool: TransformTool): void;
  setSnap(snap: SnapSettings): void;
  setColliderOutlines(visible: boolean): void;
  /**
   * The editor view's display settings.
   *
   * They live on the viewport rather than in React state because each one mutates a Three object —
   * a camera, a grid helper, the renderer's shadow map — and a re-render would not touch any of
   * them. The control reads the current value back from here so the two cannot disagree.
  */
  display(): ViewportDisplay;
  setDisplay(next: Partial<ViewportDisplay>): void;
  /**
   * The view gizmo's half of the camera API.
   *
   * `cameraBasis` is polled every frame while the gizmo is mounted, so it returns three vectors
   * rather than reading back through `display()`: the gizmo needs the orientation continuously, not
   * just when a switch is flipped.
   */
  cameraBasis(): CameraBasis;
  faceView(face: ViewFace): void;
  orbitBy(deltaX: number, deltaY: number): void;
  /** A camera turn in radians, which is what the numpad steps use. */
  orbitAround(azimuth: number, polar: number): void;
  /** Swap perspective and orthographic, returning whichever is now in force. */
  toggleProjection(): 'perspective' | 'orthographic';
  /** Half a turn about the vertical axis. */
  oppositeView(): void;
  /**
   * Look through the scene's active game camera; false when there is nothing to look through.
   *
   * The authored field of view and clipping planes travel together: the preview is only honest if it
   * clips what the game camera clips.
   */
  enterCameraView(entityId: string, planes: CameraPlanes): boolean;
  exitCameraView(): void;
  inCameraView(): boolean;
  /** The editor camera's fov and clipping planes, for checking a camera-view preview against the document. */
  cameraPlanes(): CameraPlanes;
  /** Frame the whole scene. */
  frameAll(): void;
  /**
   * Geometry for the measurement overlay.
   *
   * The overlay is a DOM layer over the canvas, so it needs the box in world units *and* the box in
   * canvas coordinates. Both come from the viewport because both need the camera; the projection is
   * done there and the layout is done here.
   */
  worldBounds(entityId: string): { min: [number, number, number]; max: [number, number, number] } | null;
  toScreen(point: [number, number, number]): ScreenPoint | null;
  cameraDistance(): number;
  /** The stage's size in CSS pixels, so an overlay can keep itself inside it. */
  canvasSize(): CanvasSize;
  /** World position of an entity in the editor projection, for checks and debugging. */
  project(entityId: string): [number, number, number] | null;
  /** Whether a transform drag is in progress in the editor viewport. */
  isDragging(): boolean;
  /** Cancel the drag in progress, restoring the authored transform. False when nothing is dragged. */
  cancelDrag(): boolean;
  /** Read the play canvas after forcing a render (the drawing buffer is not preserved). */
  samplePlayPixels(): { width: number; height: number; distinctColors: number; nonBackgroundPixels: number } | null;
  /** Runtime statistics of the live play world, or null when stopped. */
  playStats(): RuntimeStats | null;
  /** Whether an entity's model is loading, loaded, or failed. */
  modelStatus(entityId: string): 'none' | 'loading' | 'loaded' | 'failed';
  clipNames(entityId: string): string[] | null;
  animationState(entityId: string): { clip: string | null; time: number; playing: boolean } | null;
  /** Animation state inside the running play world (independent of the editor preview). */
  playAnimationState(entityId: string): { clip: string | null; time: number; playing: boolean } | null;
  /** Game-state values of the running play world. */
  playGameState(): Record<string, JsonValue> | null;
  /** World position of an entity in the running play world. */
  playEntityTransform(entityId: string): [number, number, number] | null;
  /** PNG data URL of the current editor view, for the project thumbnail. */
  captureThumbnail(width?: number): string | null;
  /** PNG data URL for a model asset thumbnail. */
  thumbnail(assetId: string): Promise<string | null>;
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
  const [dragging, setDragging] = useState(false);

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
      clipsFor: () => null,
      loadTexture: (assetId, options) => assetCache.loadTexture(assetId, options),
    });
    sessionRef.current.setThumbnailRenderer(async (assetId) => {
      const instance = await assetCache.instantiate(assetId);
      try {
        return viewport.renderThumbnail(instance.object);
      } finally {
        disposeInstance(instance);
      }
    });
    viewport.start();
    viewport.setTool(tool);
    viewport.setSnap(snap);

    const scene = sessionRef.current.scene;
    if (scene) viewport.sync(scene);

    return () => {
      viewport.dispose();
      sessionRef.current.setThumbnailRenderer(null);
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
      display: () =>
        viewportRef.current
          ? {
              projection: viewportRef.current.projection(),
              grid: viewportRef.current.gridVisible(),
              shadows: viewportRef.current.shadowsVisible(),
            }
          : { projection: 'perspective', grid: true, shadows: true },
      worldBounds: (entityId: string) => viewportRef.current?.worldBounds(entityId) ?? null,
      toScreen: (point: [number, number, number]) => viewportRef.current?.toScreen(point) ?? null,
      cameraDistance: () => viewportRef.current?.cameraDistance() ?? 0,
      canvasSize: () => viewportRef.current?.canvasSize() ?? { width: 0, height: 0 },
      setDisplay: (next: Partial<ViewportDisplay>) => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        if (next.projection !== undefined) viewport.setProjection(next.projection);
        if (next.grid !== undefined) viewport.setGridVisible(next.grid);
        if (next.shadows !== undefined) viewport.setShadowsVisible(next.shadows);
      },
      cameraBasis: () =>
        viewportRef.current?.cameraBasis() ?? {
          right: [1, 0, 0],
          up: [0, 1, 0],
          forward: [0, 0, -1],
        },
      faceView: (face: ViewFace) => viewportRef.current?.faceView(face),
      orbitBy: (deltaX: number, deltaY: number) => viewportRef.current?.orbitBy(deltaX, deltaY),
      orbitAround: (azimuth: number, polar: number) => viewportRef.current?.orbitAround(azimuth, polar),
      toggleProjection: () => viewportRef.current?.toggleProjection() ?? 'perspective',
      oppositeView: () => viewportRef.current?.oppositeView(),
      enterCameraView: (entityId: string, planes: CameraPlanes) =>
        viewportRef.current?.enterCameraView(entityId, planes) ?? false,
      exitCameraView: () => viewportRef.current?.exitCameraView(),
      inCameraView: () => viewportRef.current?.inCameraView() ?? false,
      cameraPlanes: () => viewportRef.current?.cameraPlanes() ?? { fov: 0, near: 0, far: 0 },
      frameAll: () => viewportRef.current?.frameAll(),
      project: (entityId: string) => {
        const position = viewportRef.current?.entityWorldPosition(entityId);
        return position ? [position.x, position.y, position.z] : null;
      },
      isDragging: () => viewportRef.current?.isDragging() ?? false,
      cancelDrag: () => viewportRef.current?.cancelDrag(session.scene) ?? false,
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
      captureThumbnail: (width = 480) => {
        const canvas = editorCanvasRef.current;
        const viewport = viewportRef.current;
        if (!canvas || !viewport) return null;
        // Render, then read in the same task: the drawing buffer is not preserved between frames.
        viewport.renderNow();
        const target = document.createElement('canvas');
        target.width = width;
        target.height = Math.round((canvas.height / Math.max(1, canvas.width)) * width);
        const context = target.getContext('2d');
        if (!context) return null;
        context.drawImage(canvas, 0, 0, target.width, target.height);
        return target.toDataURL('image/png');
      },
      thumbnail: async (assetId: string) => {
        const viewport = viewportRef.current;
        if (!viewport) return null;
        const instance = await assetCache.instantiate(assetId);
        try {
          return viewport.renderThumbnail(instance.object);
        } finally {
          disposeInstance(instance);
        }
      },
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
    <div
      {...stylex.props(styles.viewport, dragging && styles.dragging)}
      ref={containerRef}
      onDragOver={(event) => {
        if (playState !== 'stopped' || !hasAssetDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (playState !== 'stopped') return;
        const payload = readAssetDrag(event.dataTransfer);
        if (!payload) return;
        const result = viewportRef.current?.pickDrop(event.clientX, event.clientY);
        if (!result) return;
        const applied = applyAssetDrop(sessionRef.current, payload, result);
        onStatus(applied.message);
      }}
    >
      <canvas {...stylex.props(styles.editorCanvas)} id={DOM_ID.editorCanvas} ref={editorCanvasRef} tabIndex={0} />
      <canvas
        {...stylex.props(styles.playCanvas, playState === 'stopped' && styles.canvasHidden)}
        id={DOM_ID.playCanvas}
        ref={playCanvasRef}
      />
      <div {...withDomClass(styles.hudHost, DOM.hudHost)} ref={hudRootRef} />
      {playState !== 'stopped' && (
        <div {...withDomClass(styles.badge, DOM.viewportBadge)}>
          <span {...stylex.props(styles.badgeDot)} />
          {playState === 'paused' ? 'Paused' : 'Play mode'}
        </div>
      )}
      {error && (
        <div {...stylex.props(styles.error)} role="alert">
          {error}
          <button type="button" onClick={stopPlay}>
            Stop
          </button>
        </div>
      )}
    </div>
  );
}
