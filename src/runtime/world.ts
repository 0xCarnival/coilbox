import * as THREE from 'three';
import type { Component, Entity, GameDocument, JsonValue, Quat, SceneDocument, Vec3 } from '@schema/index.js';
import { buildSceneGraph, RuntimeWorldError, type BuiltEntity, type BuiltScene } from './scene-graph.js';
import { FixedStepLoop, type LoopStats } from './loop.js';
import { RuntimeViewport, disposeSceneResources } from './render/viewport.js';
import { createBox3DBackend } from './physics/box3d-adapter.js';
import { AssetCache, disposeInstance, type ModelInstance } from './assets/loader.js';
import type { AnimationController } from './animation.js';
import { BehaviorRegistry } from './behaviors/registry.js';
import { BehaviorRuntime, type BehaviorHost } from './behaviors/runtime.js';
import { InputSystem } from './input/input.js';
import { GameState } from './game-state.js';
import { Hud } from './hud/hud.js';
import { AudioSystem } from './audio/audio.js';
import { EmptyAssetResolver, type AssetResolver } from './assets/resolver.js';
import type {
  ColliderSpec,
  ContactEvent,
  MoverCapsule,
  PhysicsBackend,
  PhysicsCounters,
  PhysicsWorldHandle,
} from './physics/types.js';

/**
 * The runtime world: one fresh, disposable instance of a scene built from an authored
 * document (plan §8, "Play lifecycle").
 *
 * Play snapshots the authored document and builds a *new* world from it. Nothing here
 * mutates the document, which is why Stop can restore the authored scene simply by
 * throwing this world away: the authored scene was never the simulated one.
 */

export { RuntimeWorldError } from './scene-graph.js';

export type WorldState = 'ready' | 'running' | 'paused' | 'stopped';

export interface RuntimeWorldOptions {
  canvas: HTMLCanvasElement;
  game: GameDocument;
  scene: SceneDocument;
  /** Overrides where `box3d.wasm` is fetched from; set by the bundler entry points. */
  wasmLocateFile?: (path: string) => string;
  /** Reuse an already-loaded backend (tests, or a second world in the same page). */
  physicsBackend?: PhysicsBackend;
  /** Where model and texture assets come from. Defaults to a project with no assets. */
  assets?: AssetResolver;
  /** Reuse a warm asset cache across Play/Stop cycles. */
  assetCache?: AssetCache;
  /** Registered behaviors available to this world. Without one, behavior components error. */
  registry?: BehaviorRegistry;
  /** Where the HUD mounts. Omit to use a fresh overlay in `document.body`. */
  hudRoot?: HTMLElement | null;
  /** Keyboard/pointer target for input. Defaults to the canvas. */
  inputTarget?: EventTarget;
  /** Called when gameplay asks for another scene; the host rebuilds the world. */
  onRequestScene?: (sceneId: string) => void;
  /** Called when gameplay asks to restart; the host rebuilds the world. */
  onRequestRestart?: () => void;
  /** Called for recoverable runtime problems instead of throwing mid-frame. */
  onError?: (error: RuntimeWorldError) => void;
  /** Resize the drawing buffer from the canvas CSS size each frame. */
  autoResize?: boolean;
  label?: string;
}

export interface RuntimeStats {
  state: WorldState;
  frames: number;
  steps: number;
  fps: number;
  frameTimeMs: number;
  physicsTimeMs: number;
  droppedTime: number;
  clampedTime: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  entities: number;
  physicsBodies: number;
  physics: PhysicsCounters;
  /** Physics events observed since the world started. */
  contactEvents: number;
  sensorEvents: number;
  hitEvents: number;
  listeners: number;
  /** Animated entities currently driven by a mixer. */
  animatedEntities: number;
  /** Model assets loaded by this world (or reused from a warm cache). */
  loadedModels: number;
  /** Behavior instances created for this world. */
  behaviors: number;
  /** HUD elements mounted. */
  hudElements: number;
  /** Input listeners owned by the world (released on dispose). */
  inputListeners: number;
  /** Whether audio has been activated by a user gesture. */
  audioActivated: boolean;
}

interface PhysicsBinding {
  entityId: string;
  bodyType: 'static' | 'dynamic' | 'kinematic';
  /** Previous and current physics transforms for render interpolation (x, y, z, qx, qy, qz, qw). */
  previous: Float32Array;
  current: Float32Array;
  /** Kinematic bodies follow their authored / behavior-authored transform. */
  moveWithPhysics: boolean;
}

/**
 * How far a blocked character sweep stays away from the surface it hit. Box3D's mover reports the
 * last few millimetres before a surface as free space, so a smaller skin would let a character
 * resting against a wall creep into it a little on every tick.
 */
const CHARACTER_CONTACT_SKIN = 0.005;
const previousQuat = new THREE.Quaternion();
const currentQuat = new THREE.Quaternion();

export class RuntimeWorld {
  readonly game: GameDocument;
  readonly scene: SceneDocument;
  readonly label: string;
  readonly warnings: string[];

  private readonly canvas: HTMLCanvasElement;
  private readonly viewport: RuntimeViewport;
  private readonly graph: BuiltScene;
  private readonly physics: PhysicsWorldHandle;
  private readonly loop: FixedStepLoop;
  private readonly bindings = new Map<string, PhysicsBinding>();
  private readonly autoResize: boolean;
  private readonly assetCache: AssetCache;
  private readonly ownsAssetCache: boolean;
  private readonly input: InputSystem;
  private readonly gameState: GameState;
  private readonly hud: Hud | null;
  private readonly audio: AudioSystem;
  /** Created after physics bodies exist, so behaviors can see them in start(). */
  private behaviors: BehaviorRuntime | null = null;
  private readonly behaviorSpecs: Map<string, Array<{ behaviorId: string; properties: Record<string, JsonValue> }>>;
  private readonly behaviorRegistry: BehaviorRegistry;
  private readonly entityNames = new Map<string, string>();
  private frameDeltaSeconds = 0;
  private modelInstances: Map<string, ModelInstance>;
  private readonly assets: AssetResolver;
  private readonly onErrorCallback: ((error: RuntimeWorldError) => void) | undefined;
  private readonly onRequestScene: ((sceneId: string) => void) | undefined;
  private readonly onRequestRestart: (() => void) | undefined;

  private readonly listeners: Array<{ target: EventTarget; type: string; handler: EventListener }> = [];
  private readonly eventCounts = { contact: 0, sensor: 0, hit: 0 };
  private readonly transformSample = new Float32Array(7);
  private readonly velocitySample = new Float32Array(3);

  private state: WorldState = 'ready';
  private disposed = false;
  private audioArmed = false;
  private audioListeners: Array<{ target: EventTarget; type: string; handler: EventListener }> = [];
  private physicsTimeMs = 0;
  private frameTimeMs = 0;
  private lastCanvasWidth = 0;
  private lastCanvasHeight = 0;
  private fallbackCamera: THREE.PerspectiveCamera | null = null;

  private constructor(
    options: RuntimeWorldOptions,
    viewport: RuntimeViewport,
    graph: BuiltScene,
    physics: PhysicsWorldHandle,
    assetCache: AssetCache,
    modelInstances: Map<string, ModelInstance>,
    assets: AssetResolver,
  ) {
    this.game = options.game;
    this.scene = options.scene;
    this.label = options.label ?? 'play';
    this.canvas = options.canvas;
    this.viewport = viewport;
    this.graph = graph;
    this.physics = physics;
    this.assetCache = assetCache;
    this.ownsAssetCache = options.assetCache === undefined;
    this.modelInstances = modelInstances;
    this.assets = assets;
    this.onErrorCallback = options.onError;
    this.onRequestScene = options.onRequestScene;
    this.onRequestRestart = options.onRequestRestart;
    this.autoResize = options.autoResize ?? true;
    this.warnings = [...graph.warnings];
    this.gameState = new GameState(options.game.settings.initialGameState as Record<string, never>);
    // Keyboard events go to whatever has focus, so they are captured at the window; pointer
    // events belong to the canvas. Listening for keys on the canvas alone would silently
    // ignore input whenever the canvas was not focused.
    this.input = new InputSystem({
      target: options.inputTarget ?? globalThis.window ?? options.canvas,
      canvas: options.canvas,
      bindings: options.game.settings.inputBindings,
    });
    this.audio = new AudioSystem({
      resolver: assets,
      onWarning: (message) => this.warnings.push(message),
    });
    this.hud =
      options.game.settings.hud.length > 0 && typeof document !== 'undefined'
        ? new Hud({
            elements: options.game.settings.hud,
            state: this.gameState,
            root: options.hudRoot ?? undefined,
            callbacks: { onAction: (action) => this.handleHudAction(action) },
          })
        : null;

    for (const built of graph.entities.values()) {
      this.entityNames.set(built.entity.name, built.entity.id);
    }

    // Behaviors are constructed in `startBehaviors()`, after the physics world knows its bodies:
    // a behavior's start() may legitimately need the body it belongs to.
    this.behaviorRegistry = options.registry ?? new BehaviorRegistry();
    this.behaviorSpecs = collectBehaviorComponents(options.scene);

    this.loop = new FixedStepLoop({
      fixedTimeStep: options.game.settings.physics.fixedTimeStep,
      maxSubSteps: options.game.settings.physics.maxSubSteps,
      onFixedStep: (dt) => this.fixedStep(dt),
      onRender: (alpha, frameDelta) => this.renderFrame(alpha, frameDelta),
      isBackgrounded: () => (typeof document !== 'undefined' ? document.visibilityState === 'hidden' : false),
    });
  }

  static async create(options: RuntimeWorldOptions): Promise<RuntimeWorld> {
    const backend =
      options.physicsBackend ??
      (await createBox3DBackend(options.wasmLocateFile ? { locateFile: options.wasmLocateFile } : undefined));

    const assets = options.assets ?? new EmptyAssetResolver();
    // Per-world: warnings from one world must never appear in another's report.
    const assetWarnings: string[] = [];
    const assetCache =
      options.assetCache ??
      new AssetCache({
        resolver: assets,
        describe: (assetId) => assets.getEntry(assetId),
        onWarning: (message) => assetWarnings.push(message),
      });

    // Load every referenced model before building the graph, so a missing or unsupported
    // asset produces one clear error instead of half a scene.
    const modelInstances = new Map<string, ModelInstance>();
    const assetErrors: RuntimeWorldError[] = [];
    for (const entity of options.scene.entities) {
      const model = entity.components.find((component) => component.type === 'model');
      if (!model || model.type !== 'model') continue;
      if (!entity.enabled) continue;
      try {
        modelInstances.set(entity.id, await assetCache.instantiate(model.assetId));
      } catch (cause) {
        assetErrors.push(
          new RuntimeWorldError(
            'asset-load-failed',
            cause instanceof Error ? cause.message : String(cause),
            entity.id,
          ),
        );
      }
    }

    const graph = buildSceneGraph(options.scene, { models: modelInstances });
    const viewport = new RuntimeViewport({
      canvas: options.canvas,
      render: options.game.settings.render,
      environment: options.scene.environment,
      label: options.label ?? 'play',
    });
    viewport.scene.add(graph.root);

    const physics = backend.createWorld({
      gravity: options.scene.environment.gravity,
      fixedTimeStep: options.game.settings.physics.fixedTimeStep,
      subStepCount: options.game.settings.physics.subStepCount,
      enableSleep: options.game.settings.physics.enableSleep,
      hitEventThreshold: options.game.settings.physics.hitEventThreshold,
    });

    const world = new RuntimeWorld(options, viewport, graph, physics, assetCache, modelInstances, assets);
    world.warnings.push(...assetWarnings);
    try {
      world.createPhysicsBodies();
      world.startBehaviors();
      world.attachResizeHandling();
      world.syncActiveCamera();
    } catch (cause) {
      world.dispose();
      throw cause;
    }
    // Asset problems are reported after the world exists, so the caller can show them next
    // to a running scene instead of a blank failure.
    for (const error of assetErrors) {
      world.warnings.push(error.message);
      world.onErrorCallback?.(error);
    }
    return world;
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    this.assertLive();
    if (this.state === 'running') return;
    this.state = 'running';
    this.armAudioActivation();
    this.loop.start();
  }

  /**
   * Browsers refuse to start an AudioContext before a user gesture, so the world arms one-shot
   * listeners for the first interaction. Doing it here means the editor, the player, and an
   * export all get working audio without their host remembering to ask.
   */
  private armAudioActivation(): void {
    if (this.audioArmed || typeof globalThis.window === 'undefined') return;
    this.audioArmed = true;
    const activate = () => {
      void this.activateAudio();
      globalThis.window.removeEventListener('pointerdown', activate);
      globalThis.window.removeEventListener('keydown', activate);
      this.audioListeners = [];
    };
    globalThis.window.addEventListener('pointerdown', activate);
    globalThis.window.addEventListener('keydown', activate);
    this.audioListeners = [
      { target: globalThis.window, type: 'pointerdown', handler: activate },
      { target: globalThis.window, type: 'keydown', handler: activate },
    ];
  }

  pause(): void {
    this.assertLive();
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.loop.pause();
  }

  resume(): void {
    this.assertLive();
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.loop.start();
  }

  /** Advance exactly one fixed simulation step while paused (plan §8). */
  step(): void {
    this.assertLive();
    if (this.state === 'running') throw new RuntimeWorldError('invalid-state', 'pause the world before stepping it');
    if (this.state === 'ready') this.state = 'paused';
    this.loop.stepOnce();
  }

  /** Tear the world down. Idempotent; safe to call from Stop at any time. */
  stop(): void {
    this.dispose();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  getState(): WorldState {
    return this.state;
  }

  getLoopStats(): LoopStats {
    return this.loop.getStats();
  }

  getListenerCount(): number {
    return this.listeners.length;
  }

  getPhysics(): PhysicsWorldHandle {
    return this.physics;
  }

  /** The runtime's Three.js scene. Editor tooling must not mutate this directly. */
  getScene(): THREE.Scene {
    return this.viewport.scene;
  }

  /** The renderer used by this world, for diagnostics and tests. */
  getRenderer(): THREE.WebGLRenderer {
    return this.viewport.renderer;
  }

  getEntityObject(entityId: string): THREE.Object3D | null {
    return this.graph.entities.get(entityId)?.object ?? null;
  }

  getEntityIds(): string[] {
    return [...this.graph.entities.keys()];
  }

  /** The active game camera, or an internal fallback when the scene has none. */
  getCamera(): THREE.PerspectiveCamera {
    if (this.graph.camera) return this.graph.camera;
    if (!this.fallbackCamera) {
      this.fallbackCamera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
      this.fallbackCamera.position.set(6, 5, 8);
      this.fallbackCamera.lookAt(0, 0, 0);
      this.fallbackCamera.updateMatrixWorld(true);
    }
    return this.fallbackCamera;
  }

  resize(width: number, height: number): void {
    this.viewport.resize(width, height);
    const camera = this.getCamera();
    camera.aspect = Math.max(1, Math.floor(width)) / Math.max(1, Math.floor(height));
    camera.updateProjectionMatrix();
    this.lastCanvasWidth = width;
    this.lastCanvasHeight = height;
  }

  /** Read an entity's current world transform into `out` (x, y, z, qx, qy, qz, qw). */
  readEntityTransform(entityId: string, out: Float32Array): boolean {
    const built = this.graph.entities.get(entityId);
    if (!built) return false;
    const binding = this.bindings.get(entityId);
    if (binding && binding.bodyType === 'dynamic') {
      if (!this.physics.readTransform(entityId, this.transformSample)) return false;
    } else {
      built.object.updateWorldMatrix(true, false);
      matrixPosition.setFromMatrixPosition(built.object.matrixWorld);
      matrixQuaternion.setFromRotationMatrix(built.object.matrixWorld);
      this.transformSample[0] = matrixPosition.x;
      this.transformSample[1] = matrixPosition.y;
      this.transformSample[2] = matrixPosition.z;
      this.transformSample[3] = matrixQuaternion.x;
      this.transformSample[4] = matrixQuaternion.y;
      this.transformSample[5] = matrixQuaternion.z;
      this.transformSample[6] = matrixQuaternion.w;
    }
    out.set(this.transformSample);
    return true;
  }

  /**
   * Move a kinematic character to `position` without walking through walls (plan §16).
   *
   * The horizontal axes are swept one at a time against the world with the character's own
   * collider, so a blocked axis stops at the contact while the free axis still moves — which is
   * what makes a character slide along a wall instead of sticking to it. Vertical movement is left
   * to the caller's ground probe, so landing behaviour does not change.
   *
   * `position` is rewritten with the resolved position.
   */
  moveCharacter(entityId: string, position: [number, number, number], rotation: Quat): void {
    const capsule = this.moverCapsuleFor(entityId);
    if (!capsule || !this.physics.readTransform(entityId, this.transformSample)) {
      this.setKinematicTransform(entityId, position, rotation);
      return;
    }
    const resolved: [number, number, number] = [this.transformSample[0], this.transformSample[1], this.transformSample[2]];
    const desired: [number, number, number] = [position[0], position[1], position[2]];
    // X then Z: a wall facing one axis leaves the other free, so the character keeps sliding.
    for (const axis of [0, 2] as const) {
      const amount = desired[axis] - resolved[axis];
      if (Math.abs(amount) < 1e-6) continue;
      const translation: [number, number, number] = [0, 0, 0];
      translation[axis] = amount;
      const { fraction } = this.physics.castMover({ origin: [...resolved], capsule, translation, excludeKey: entityId });
      if (fraction >= 1) {
        resolved[axis] = desired[axis];
        continue;
      }
      // A blocked sweep still reports the last few millimetres before the surface as free space
      // (Box3D allows a small contact slop). Subtracting that slop and clamping at zero is what
      // stops a character resting against a wall from creeping into it one tick at a time.
      const travelled = Math.abs(amount) * fraction;
      const advance = Math.max(0, travelled - CHARACTER_CONTACT_SKIN);
      resolved[axis] += Math.sign(amount) * advance;
    }
    // Vertical intent is applied as written; the caller already resolved it against the ground.
    resolved[1] = desired[1];
    this.setKinematicTransform(entityId, resolved, rotation);
    position[0] = resolved[0];
    position[1] = resolved[1];
    position[2] = resolved[2];
  }

  /** Write a kinematic body's transform through the adapter and keep the projection in step. */
  setKinematicTransform(entityId: string, position: [number, number, number], rotation: Quat): void {
    this.physics.setTransform(entityId, position, rotation);
    // Kinematic bodies are driven by gameplay, so the projected object follows the adapter
    // rather than the render interpolation.
    const built = this.graph.entities.get(entityId);
    if (built) {
      built.object.position.set(position[0], position[1], position[2]);
      built.object.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);
    }
    const binding = this.bindings.get(entityId);
    if (binding) {
      binding.previous.set([position[0], position[1], position[2], rotation[0], rotation[1], rotation[2], rotation[3]]);
      binding.current.set(binding.previous);
    }
  }

  /** The upright capsule a character controller sweeps, in body-local space. */
  private moverCapsuleFor(entityId: string): MoverCapsule | null {
    const built = this.graph.entities.get(entityId);
    if (!built) return null;
    const collider = findComponent(built.entity, 'collider');
    if (!collider) return null;
    const scale = built.entity.transform.scale;
    const uniformScale = Math.max(1e-6, Math.min(Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2])));
    const size = collider.size;
    const radius = (size[0] / 2) * uniformScale;
    const halfHeight = (Math.max(0, size[1] - size[0]) / 2) * uniformScale;
    const offset = collider.offset;
    const centerY = offset[1] * uniformScale;
    return {
      center1: [offset[0] * uniformScale, centerY - halfHeight, offset[2] * uniformScale],
      center2: [offset[0] * uniformScale, centerY + halfHeight, offset[2] * uniformScale],
      radius,
    };
  }

  readEntityVelocity(entityId: string, out: Float32Array): boolean {    if (!this.bindings.has(entityId)) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      return false;
    }
    return this.physics.readVelocity(entityId, out);
  }

  /** Apply an impulse to a physics entity (used by gameplay code and tests). */
  applyImpulse(entityId: string, impulse: Vec3, point?: Vec3): void {
    this.physics.applyImpulse(entityId, impulse, point);
  }

  isPhysicsBody(entityId: string): boolean {
    return this.bindings.has(entityId);
  }

  /** Animation state of an entity, for the editor preview and for tests. */
  getAnimationState(entityId: string): ReturnType<AnimationController['getState']> | null {
    return this.graph.entities.get(entityId)?.animation?.getState() ?? null;
  }

  getAnimationController(entityId: string): AnimationController | null {
    return this.graph.entities.get(entityId)?.animation ?? null;
  }

  getLoadedModel(entityId: string): ModelInstance | null {
    return this.modelInstances.get(entityId) ?? null;
  }

  /** Clip names available to an entity's model, once loaded. */
  getClipNames(entityId: string): string[] {
    return this.modelInstances.get(entityId)?.clips.map((clip, index) => clip.name || `clip-${index}`) ?? [];
  }

  /** Instantiate registered behaviors. Called once the physics bodies exist. */
  private startBehaviors(): void {
    if (this.behaviors) return;
    this.behaviors = new BehaviorRuntime({
      registry: this.behaviorRegistry,
      host: this.createBehaviorHost({} as RuntimeWorldOptions),
      behaviorsByEntity: this.behaviorSpecs,
    });
  }

  getBehaviorRuntime(): BehaviorRuntime | null {
    return this.behaviors;
  }

  getGameState(): GameState {
    return this.gameState;
  }

  getInput(): InputSystem {
    return this.input;
  }

  getAudio(): AudioSystem {
    return this.audio;
  }

  /**
   * Activate audio from a user gesture. Browsers refuse to start an AudioContext without
   * one, so the host calls this on the first click or key press.
   */
  async activateAudio(): Promise<boolean> {
    return this.audio.activate();
  }

  private handleHudAction(action: 'restart' | 'nextScene' | 'resume' | 'none'): void {
    switch (action) {
      case 'restart':
        this.hud?.showOnlyOverlay(null);
        this.onRequestRestart?.();
        break;
      case 'nextScene': {
        const next = this.gameState.get<string>('nextScene');
        if (typeof next === 'string' && next.length > 0) this.onRequestScene?.(next);
        else this.onRequestRestart?.();
        break;
      }
      case 'resume':
        this.gameState.set('paused', false);
        // Dismissing the start overlay is what starts the round: timers that wait for it must not
        // run down while the player is still reading.
        this.gameState.set('started', true);
        this.hud?.showOnlyOverlay(null);
        this.resume();
        break;
      default:
        break;
    }
  }

  private createBehaviorHost(options: RuntimeWorldOptions): BehaviorHost {
    const world = this;
    return {
      input: {
        isActionDown: (action) => this.input.isActionDown(action),
        wasActionPressed: (action) => this.input.wasActionPressed(action),
        wasActionReleased: (action) => this.input.wasActionReleased(action),
        moveAxis: () => this.input.moveAxis(),
        pointer: () => this.input.pointer,
      },
      state: this.gameState,
      physics: this.physics,
      hud: this.hud,
      entityIds: () => [...world.graph.entities.keys()],
      entityName: (entityId) => world.graph.entities.get(entityId)?.entity.name ?? null,
      findByName: (name) => world.entityNames.get(name) ?? null,
      findById: (entityId) => (world.graph.entities.has(entityId) ? entityId : null),
      readTransform: (entityId, out) => world.readEntityTransform(entityId, out),
      readVelocity: (entityId, out) => world.readEntityVelocity(entityId, out),
      setKinematicTransform: (entityId, position, rotation) => world.setKinematicTransform(entityId, position, rotation),
      setBodyEnabled: (entityId, enabled) => {
        world.physics.setBodyEnabled(entityId, enabled);
        const built = world.graph.entities.get(entityId);
        if (built) built.object.visible = enabled && built.entity.editor.visible;
      },
      moveCharacter: (entityId, position, rotation) => world.moveCharacter(entityId, position, rotation),
      setBodyType: (entityId, type) => world.physics.setBodyType(entityId, type),
      isPhysicsBody: (entityId) => world.physics.hasBody(entityId),
      requestScene: (sceneId) => options.onRequestScene?.(sceneId),
      requestRestart: () => options.onRequestRestart?.(),
      log: (level, message, entityId) => {
        const prefix = entityId ? `${world.graph.entities.get(entityId)?.entity.name ?? entityId}: ` : '';
        world.warnings.push(`${level}: ${prefix}${message}`);
      },
      requestAction: (action) => world.handleHudAction(action),
      playClip: (entityId, clip, clipOptions) => {
        const controller = world.graph.entities.get(entityId)?.animation ?? null;
        if (!controller) return false;
        controller.play(clip, clipOptions);
        return true;
      },
      playSound: (entityId, soundOptions) => {
        const assetId = world.audioAssetFor(entityId);
        if (!assetId) return false;
        return world.audio.play(assetId, { volume: soundOptions?.volume ?? 1, loop: soundOptions?.loop ?? false });
      },
      prepareAudio: (entityId) => {
        const assetId = world.audioAssetFor(entityId);
        if (assetId) world.audio.prepare(assetId);
      },
    };
  }

  /** Asset id referenced by an entity's audio component, if any. */
  private audioAssetFor(entityId: string): string | null {
    const entity = this.graph.entities.get(entityId)?.entity;
    const component = entity?.components.find((candidate) => candidate.type === 'audio');
    return component && component.type === 'audio' ? component.assetId : null;
  }

  /** Frame delta of the most recent rendered frame, for diagnostics. */
  getFrameDelta(): number {
    return this.frameDeltaSeconds;
  }

  /** Render one frame immediately at the given interpolation factor. */
  renderNow(alpha = 1): void {
    if (this.disposed) return;
    this.renderFrame(alpha, 0);
  }

  getStats(): RuntimeStats {
    const viewportStats = this.viewport.getStats();
    const loopStats = this.loop.getStats();
    return {
      state: this.state,
      frames: loopStats.frames,
      steps: loopStats.steps,
      fps: this.frameTimeMs > 0 ? 1000 / this.frameTimeMs : 0,
      frameTimeMs: this.frameTimeMs,
      physicsTimeMs: this.physicsTimeMs,
      droppedTime: loopStats.droppedTime,
      clampedTime: loopStats.clampedTime,
      drawCalls: viewportStats.drawCalls,
      triangles: viewportStats.triangles,
      geometries: viewportStats.geometries,
      textures: viewportStats.textures,
      programs: viewportStats.programs,
      entities: this.graph.entities.size,
      physicsBodies: this.bindings.size,
      physics: this.physics.getCounters(),
      contactEvents: this.eventCounts.contact,
      sensorEvents: this.eventCounts.sensor,
      hitEvents: this.eventCounts.hit,
      listeners: this.listeners.length,
      animatedEntities: [...this.graph.entities.values()].filter((built) => built.animation !== null).length,
      loadedModels: this.modelInstances.size,
      behaviors: this.behaviors?.size ?? 0,
      hudElements: this.hud ? this.game.settings.hud.length : 0,
      inputListeners: this.input.listenerCount,
      audioActivated: this.audio.isActivated,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.state = 'stopped';
    this.loop.stop();
    this.removeAllListeners();
    for (const { target, type, handler } of this.audioListeners) target.removeEventListener(type, handler);
    this.audioListeners = [];
    this.behaviors?.dispose();
    this.input.dispose();
    this.hud?.dispose();
    this.audio.dispose();
    this.physics.dispose();
    this.bindings.clear();
    for (const built of this.graph.entities.values()) built.animation?.dispose();
    // Model instances are clones: dispose them per instance, then let the cache release the
    // source assets when this world owns it.
    for (const instance of this.modelInstances.values()) disposeInstance(instance);
    this.modelInstances.clear();
    this.viewport.scene.remove(this.graph.root);
    disposeSceneResources(this.graph.root);
    this.graph.entities.clear();
    this.viewport.dispose();
    if (this.ownsAssetCache) void this.assetCache.dispose();
  }

  // ---------------------------------------------------------------- internals

  private createPhysicsBodies(): void {
    for (const built of this.graph.entities.values()) {
      const entity = built.entity;
      const rigidBody = findComponent(entity, 'rigidBody');
      if (!rigidBody) {
        if (findComponent(entity, 'collider')) {
          throw new RuntimeWorldError(
            'collider-without-body',
            `entity "${entity.name}" has a collider but no rigid body; add a rigid body or remove the collider`,
            entity.id,
          );
        }
        continue;
      }
      if (entity.parentId !== null) {
        throw new RuntimeWorldError(
          'physics-body-not-root',
          `entity "${entity.name}" has a rigid body but is not a scene root; physics bodies must be roots in this version`,
          entity.id,
        );
      }
      const scale = entity.transform.scale;
      if (scale[0] <= 0 || scale[1] <= 0 || scale[2] <= 0) {
        throw new RuntimeWorldError(
          'unsupported-physics-scale',
          `entity "${entity.name}" has a non-positive scale; physics colliders require positive scale`,
          entity.id,
        );
      }
      if (Math.abs(scale[0] - scale[1]) > 1e-4 || Math.abs(scale[1] - scale[2]) > 1e-4) {
        throw new RuntimeWorldError(
          'unsupported-physics-scale',
          `entity "${entity.name}" has non-uniform scale; set the collider size explicitly instead`,
          entity.id,
        );
      }

      this.physics.createBody({
        key: entity.id,
        bodyType: rigidBody.bodyType,
        position: [...entity.transform.position] as Vec3,
        rotation: [...entity.transform.rotation] as Quat,
        gravityScale: rigidBody.gravityScale,
        linearDamping: rigidBody.linearDamping,
        angularDamping: rigidBody.angularDamping,
        continuous: rigidBody.continuous,
        lockRotation: rigidBody.lockRotation,
        colliders: this.colliderSpecsFor(built, scale[0]),
      });

      const binding: PhysicsBinding = {
        entityId: entity.id,
        bodyType: rigidBody.bodyType,
        previous: new Float32Array(7),
        current: new Float32Array(7),
        moveWithPhysics: rigidBody.moveWithPhysics,
      };
      this.physics.readTransform(entity.id, binding.current);
      binding.previous.set(binding.current);
      this.bindings.set(entity.id, binding);

      if (rigidBody.bodyType === 'dynamic') {
        // Physics owns dynamic transforms: seed the render object from the body so the
        // render loop never fights the simulation.
        applySampleToObject(built.object, binding.current);
      }
    }
  }

  private colliderSpecsFor(built: BuiltEntity, uniformScale: number): ColliderSpec[] {
    const entity = built.entity;
    const collider = findComponent(entity, 'collider');
    if (!collider) {
      const primitive = findComponent(entity, 'primitive');
      const size: Vec3 = primitive ? ([...primitive.size] as Vec3) : [1, 1, 1];
      this.warnings.push(
        `entity "${entity.name}" has a rigid body but no collider; using a bounds-fitted box of ${size.join(' x ')} m`,
      );
      return [
        baseCollider(
          { kind: 'box', halfExtents: [size[0] / 2, size[1] / 2, size[2] / 2] },
          [0, 0, 0],
          uniformScale,
        ),
      ];
    }
    const size = collider.size;
    const shape: ColliderSpec['shape'] =
      collider.shape === 'sphere'
        ? { kind: 'sphere', radius: (size[0] / 2) * uniformScale }
        : collider.shape === 'capsule'
          ? {
              kind: 'capsule',
              radius: (size[0] / 2) * uniformScale,
              halfHeight: (Math.max(0, size[1] - size[0]) / 2) * uniformScale,
            }
          : {
              kind: 'box',
              halfExtents: [(size[0] / 2) * uniformScale, (size[1] / 2) * uniformScale, (size[2] / 2) * uniformScale],
            };
    const spec = baseCollider(shape, collider.offset, uniformScale);
    spec.friction = collider.friction;
    spec.restitution = collider.restitution;
    spec.density = collider.density;
    spec.isSensor = collider.isSensor;
    spec.reportContacts = collider.reportContacts;
    spec.reportHits = true;
    spec.rotation = [...collider.localRotation] as Quat;
    return [spec];
  }

  private fixedStep(fixedDelta: number): void {
    const started = nowMs();

    for (const binding of this.bindings.values()) {
      if (binding.bodyType !== 'kinematic' || !binding.moveWithPhysics) continue;
      const built = this.graph.entities.get(binding.entityId);
      if (!built) continue;
      const { position, quaternion } = built.object;
      this.physics.setTransform(
        binding.entityId,
        [position.x, position.y, position.z],
        [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      );
    }

    this.physics.step();

    for (const binding of this.bindings.values()) {
      if (binding.bodyType !== 'dynamic') continue;
      binding.previous.set(binding.current);
      this.physics.readTransform(binding.entityId, binding.current);
    }

    // Animation advances on the fixed step as well, so Pause/Step advance clips exactly as
    // they advance physics instead of freezing them between frames.
    for (const built of this.graph.entities.values()) {
      built.animation?.update(fixedDelta);
    }

    this.behaviors?.fixedUpdate(fixedDelta);
    this.handlePhysicsEvents(this.physics.drainEvents());
    this.physicsTimeMs = this.physicsTimeMs * 0.9 + (nowMs() - started) * 0.1;
  }

  private handlePhysicsEvents(events: ContactEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case 'begin':
        case 'end':
          this.eventCounts.contact += 1;
          break;
        case 'hit':
          this.eventCounts.hit += 1;
          break;
        case 'sensorBegin':
        case 'sensorEnd':
          this.eventCounts.sensor += 1;
          break;
      }
    }
    for (const event of events) this.behaviors?.dispatchPhysicsEvent(event);
  }

  private renderFrame(alpha: number, frameDelta: number): void {
    if (this.autoResize) this.resizeToCanvas();
    for (const binding of this.bindings.values()) {
      if (binding.bodyType !== 'dynamic') continue;
      const built = this.graph.entities.get(binding.entityId);
      if (!built) continue;
      const { previous, current } = binding;
      built.object.position.set(
        previous[0] + (current[0] - previous[0]) * alpha,
        previous[1] + (current[1] - previous[1]) * alpha,
        previous[2] + (current[2] - previous[2]) * alpha,
      );
      previousQuat.set(previous[3], previous[4], previous[5], previous[6]);
      currentQuat.set(current[3], current[4], current[5], current[6]);
      built.object.quaternion.slerpQuaternions(previousQuat, currentQuat, alpha);
    }
    this.frameDeltaSeconds = frameDelta;
    this.behaviors?.update(frameDelta);
    this.viewport.render(this.getCamera());
    // Edge state is per frame: consume it after behaviors have seen it.
    this.input.endFrame();
    if (frameDelta > 0) {
      this.frameTimeMs = this.frameTimeMs === 0 ? frameDelta * 1000 : this.frameTimeMs * 0.9 + frameDelta * 1000 * 0.1;
    }
  }

  private resizeToCanvas(): void {
    const width = this.canvas.clientWidth || this.canvas.width;
    const height = this.canvas.clientHeight || this.canvas.height;
    if (width <= 0 || height <= 0) return;
    if (width === this.lastCanvasWidth && height === this.lastCanvasHeight) return;
    this.resize(width, height);
  }

  /** Keep the active camera's aspect in sync with the viewport. */
  private syncActiveCamera(): void {
    this.resizeToCanvas();
    const camera = this.getCamera();
    const width = this.canvas.clientWidth || this.canvas.width || 1;
    const height = this.canvas.clientHeight || this.canvas.height || 1;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  private attachResizeHandling(): void {
    if (typeof window === 'undefined') return;
    this.addListener(window, 'resize', () => this.resizeToCanvas());
    if (typeof document !== 'undefined') {
      this.addListener(document, 'visibilitychange', () => {
        // Reset accumulated time instead of replaying the hidden interval.
        if (document.visibilityState === 'visible') this.loop.resetAccumulator();
      });
    }
  }

  private addListener(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.listeners.push({ target, type, handler });
  }

  private removeAllListeners(): void {
    for (const { target, type, handler } of this.listeners) {
      target.removeEventListener(type, handler);
    }
    this.listeners.length = 0;
  }

  private assertLive(): void {
    if (this.disposed) throw new RuntimeWorldError('disposed', 'this runtime world has been disposed');
  }
}

const matrixPosition = new THREE.Vector3();
const matrixQuaternion = new THREE.Quaternion();

function baseCollider(
  shape: ColliderSpec['shape'],
  offset: Vec3,
  uniformScale: number,
): ColliderSpec {
  return {
    shape,
    offset: [offset[0] * uniformScale, offset[1] * uniformScale, offset[2] * uniformScale] as Vec3,
    rotation: [0, 0, 0, 1] as Quat,
    density: 1,
    friction: 0.6,
    restitution: 0,
    isSensor: false,
    reportContacts: false,
    reportHits: true,
  };
}

function applySampleToObject(object: THREE.Object3D, sample: Float32Array): void {
  object.position.set(sample[0], sample[1], sample[2]);
  object.quaternion.set(sample[3], sample[4], sample[5], sample[6]);
}

function findComponent<T extends Component['type']>(
  entity: Entity,
  type: T,
): Extract<Component, { type: T }> | undefined {
  return entity.components.find((component): component is Extract<Component, { type: T }> => component.type === type);
}

/** Behavior components per entity, in document order. */
function collectBehaviorComponents(
  scene: SceneDocument,
): Map<string, Array<{ behaviorId: string; properties: Record<string, JsonValue> }>> {
  const result = new Map<string, Array<{ behaviorId: string; properties: Record<string, JsonValue> }>>();
  for (const entity of scene.entities) {
    if (!entity.enabled) continue;
    const behaviors = entity.components
      .filter((component) => component.type === 'behavior')
      .map((component) => ({
        behaviorId: (component as Extract<typeof component, { type: 'behavior' }>).behaviorId,
        properties: (component as Extract<typeof component, { type: 'behavior' }>).properties as Record<string, JsonValue>,
      }));
    if (behaviors.length > 0) result.set(entity.id, behaviors);
  }
  return result;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
