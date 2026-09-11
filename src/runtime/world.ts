import * as THREE from 'three';
import type { Component, Entity, GameDocument, Quat, SceneDocument, Vec3 } from '@schema/index.js';
import { buildSceneGraph, RuntimeWorldError, type BuiltEntity, type BuiltScene } from './scene-graph.js';
import { FixedStepLoop, type LoopStats } from './loop.js';
import { RuntimeViewport, disposeSceneResources } from './render/viewport.js';
import { createBox3DBackend } from './physics/box3d-adapter.js';
import { AssetCache, disposeInstance, type ModelInstance } from './assets/loader.js';
import type { AnimationController } from './animation.js';
import { EmptyAssetResolver, type AssetResolver } from './assets/resolver.js';
import type { ColliderSpec, ContactEvent, PhysicsBackend, PhysicsCounters, PhysicsWorldHandle } from './physics/types.js';

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
  private modelInstances: Map<string, ModelInstance>;
  private readonly assets: AssetResolver;
  private readonly onErrorCallback: ((error: RuntimeWorldError) => void) | undefined;

  private readonly listeners: Array<{ target: EventTarget; type: string; handler: EventListener }> = [];
  private readonly eventCounts = { contact: 0, sensor: 0, hit: 0 };
  private readonly transformSample = new Float32Array(7);
  private readonly velocitySample = new Float32Array(3);

  private state: WorldState = 'ready';
  private disposed = false;
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
    this.autoResize = options.autoResize ?? true;
    this.warnings = [...graph.warnings];

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
    this.loop.start();
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

  readEntityVelocity(entityId: string, out: Float32Array): boolean {
    if (!this.bindings.has(entityId)) {
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
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.state = 'stopped';
    this.loop.stop();
    this.removeAllListeners();
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
    // Behavior dispatch arrives with the gameplay layer (stage 3); counts are already
    // tracked so physics tests can assert that events genuinely fire.
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
    this.viewport.render(this.getCamera());
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

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
