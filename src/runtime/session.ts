import type { GameDocument, SceneDocument } from '@schema/index.js';
import { RuntimeWorld, type RuntimeStats, type RuntimeWorldOptions, type WorldState } from './world.js';
import { BehaviorRegistry } from './behaviors/registry.js';
import { BEHAVIOR_LIBRARY } from './behaviors/library.js';
import type { AssetResolver } from './assets/resolver.js';
import { EmptyAssetResolver } from './assets/resolver.js';
import type { AssetCache } from './assets/loader.js';

/**
 * Runtime session: the host helper that owns one world at a time and rebuilds it for scene
 * transitions and restarts (plan §8, §10).
 *
 * Scene switching deliberately throws the world away and builds a new one from the scene
 * document. Nothing from the previous scene can leak into the next, and "restart" is the
 * same operation as "load the start scene again" — there is no partial-reset code path to
 * get wrong.
 */

export interface RuntimeSessionOptions {
  canvas: HTMLCanvasElement;
  game: GameDocument;
  scene: SceneDocument;
  /** Load another scene of the same game. */
  resolveScene(sceneId: string): Promise<SceneDocument> | SceneDocument;
  assets?: AssetResolver;
  /** Reuse loaded models across scene changes. */
  assetCache?: AssetCache;
  registry?: BehaviorRegistry;
  hudRoot?: HTMLElement | null;
  inputTarget?: EventTarget;
  wasmLocateFile?: (path: string) => string;
  autoStart?: boolean;
  label?: string;
  onError?: RuntimeWorldOptions['onError'];
  onLog?: (level: 'info' | 'warning' | 'error', message: string) => void;
  onSceneChanged?: (sceneId: string) => void;
}

export class RuntimeSession {
  private readonly options: RuntimeSessionOptions;
  private readonly registry: BehaviorRegistry;
  private world: RuntimeWorld | null = null;
  private currentSceneId: string;
  private disposed = false;
  private switching = false;
  private readonly pendingLogs: Array<{ level: 'info' | 'warning' | 'error'; message: string }> = [];

  private constructor(options: RuntimeSessionOptions) {
    this.options = options;
    this.registry = options.registry ?? BehaviorRegistry.fromDefinitions(BEHAVIOR_LIBRARY);
    this.currentSceneId = options.scene.id;
  }

  static async create(options: RuntimeSessionOptions): Promise<RuntimeSession> {
    const session = new RuntimeSession(options);
    session.world = await session.buildWorld(options.scene);
    if (options.autoStart !== false) session.world.start();
    return session;
  }

  get current(): RuntimeWorld | null {
    return this.world;
  }

  get sceneId(): string {
    return this.currentSceneId;
  }

  get behaviorRegistry(): BehaviorRegistry {
    return this.registry;
  }

  get state(): WorldState {
    return this.world?.getState() ?? 'stopped';
  }

  stats(): RuntimeStats | null {
    return this.world?.getStats() ?? null;
  }

  start(): void {
    this.world?.start();
  }

  pause(): void {
    this.world?.pause();
  }

  resume(): void {
    this.world?.resume();
  }

  step(): void {
    this.world?.step();
  }

  async stop(): Promise<void> {
    const world = this.world;
    this.world = null;
    world?.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stop();
  }

  /** Load a scene by id, replacing the running world. */
  async loadScene(sceneId: string): Promise<boolean> {
    if (this.disposed || this.switching) return false;
    this.switching = true;
    try {
      const scene = await this.options.resolveScene(sceneId);
      const wasRunning = this.world?.getState() === 'running' || this.world === null;
      await this.stop();
      this.world = await this.buildWorld(scene);
      this.currentSceneId = scene.id;
      this.options.onSceneChanged?.(scene.id);
      if (wasRunning) this.world.start();
      return true;
    } catch (error) {
      this.options.onLog?.('error', `could not load scene "${sceneId}": ${String(error)}`);
      return false;
    } finally {
      this.switching = false;
    }
  }

  /** Restart the current scene (or the game's start scene with `toStart`). */
  async restart(toStart = false): Promise<boolean> {
    const target = toStart ? this.options.game.startScene : this.currentSceneId;
    return this.loadScene(target);
  }

  private async buildWorld(scene: SceneDocument): Promise<RuntimeWorld> {
    const world = await RuntimeWorld.create({
      canvas: this.options.canvas,
      game: this.options.game,
      scene,
      assets: this.options.assets ?? new EmptyAssetResolver(),
      assetCache: this.options.assetCache,
      registry: this.registry,
      hudRoot: this.options.hudRoot,
      inputTarget: this.options.inputTarget,
      wasmLocateFile: this.options.wasmLocateFile,
      autoResize: true,
      label: this.options.label ?? 'play',
      onError: this.options.onError,
      onRequestScene: (sceneId) => {
        void this.loadScene(sceneId);
      },
      onRequestRestart: () => {
        void this.restart();
      },
    });
    for (const warning of world.warnings) this.options.onLog?.('warning', warning);
    return world;
  }
}
