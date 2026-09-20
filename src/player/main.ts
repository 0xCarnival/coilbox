import wasmUrl from 'virtual:box3d-wasm-url';
import { RuntimeSession } from '@runtime/session.js';
import { GltfDecoders } from '@runtime/assets/decoders.js';
import { loadProjectFromUrl, ProjectLoadError } from '@runtime/project/loader.js';
import { formatIssues, parseScene, type GameDocument, type JsonValue, type SceneDocument } from '@schema/index.js';
import type { RuntimeStats } from '@runtime/world.js';

/**
 * Standalone game entry point (`player.html`).
 *
 * This is the same runtime the editor previews with; it must not import editor code (plan §6).
 * The project is served as plain files next to the build, which is also how an exported game
 * runs:
 *
 *   player.html?project=./my-game/
 *
 * Exported games bake the project location in at build time, so the query parameter is an
 * authoring convenience rather than part of the export contract.
 */

export interface PlayerOptions {
  /** Base URL the project documents are served from. Must be same-origin in exports. */
  projectBaseUrl: string;
  canvas: HTMLCanvasElement;
  /** Where the HUD mounts; defaults to the document body. */
  hudRoot?: HTMLElement | null;
  /** Start the simulation immediately (exports do); the start overlay still gates input. */
  autoStart?: boolean;
}

export interface PlayerHandle {
  ready: Promise<void>;
  session: RuntimeSession | null;
  game: GameDocument | null;
  scene: SceneDocument | null;
  start(): void;
  stop(): Promise<void>;
  restart(): Promise<void>;
  state(): { state: string; projectName: string; sceneName: string; errors: string[]; warnings: string[] };
}

export async function startPlayer(options: PlayerOptions): Promise<PlayerHandle> {
  const errors: string[] = [];
  // Warnings are collected separately from errors on purpose. A model asset that is perfectly
  // valid but carries no animation clips is a documented, supported case — `project-format.md`
  // puts no animation requirement on a model — and the editor's own gates already treat warnings
  // as non-fatal. Folding them into `errors` made `studio test`'s `loads` check impossible to pass
  // for any project that used a static model, which is why the two are no longer conflated.
  const warnings: string[] = [];
  let session: RuntimeSession | null = null;
  let game: GameDocument | null = null;
  let scene: SceneDocument | null = null;
  let projectName = '';
  let sceneName = '';
  const sceneCache = new Map<string, SceneDocument>();

  const ready = (async () => {
    try {
      const project = await loadProjectFromUrl(options.projectBaseUrl);
      projectName = project.game.name;
      game = project.game;
      scene = project.scene;
      sceneCache.set(project.scene.id, project.scene);
      if (project.issues.length > 0) errors.push(...project.issues.map((issue) => `${issue.path}: ${issue.message}`));

      const base = project.baseUrl;
      session = await RuntimeSession.create({
        canvas: options.canvas,
        game: project.game,
        scene: project.scene,
        resolveScene: async (sceneId) => {
          const cached = sceneCache.get(sceneId);
          if (cached) return cached;
          const entry = project.game.scenes.find((candidate) => candidate.id === sceneId);
          if (!entry) throw new Error(`game.json does not list a scene "${sceneId}"`);
          const response = await fetch(new URL(entry.path, base).href);
          if (!response.ok) throw new Error(`scene "${sceneId}" returned HTTP ${response.status}`);
          const raw: JsonValue = await response.json();
          // The scene a running game switches to is parsed like any other document: a file that is
          // not a scene must fail loudly here rather than half-load as a world with missing fields.
          const parsed = parseScene(raw);
          if (!parsed.value) throw new Error(`scene "${sceneId}" is not a valid scene document: ${formatIssues(parsed.issues)}`);
          sceneCache.set(sceneId, parsed.value);
          return parsed.value;
        },
        assets: project.resolver,
        decoders: new GltfDecoders(),
        wasmLocateFile: () => wasmUrl,
        hudRoot: options.hudRoot ?? null,
        autoStart: options.autoStart !== false,
        label: 'player',
        onLog: (level, message) => {
          if (level === 'error') errors.push(message);
          else if (level === 'warning') warnings.push(message);
        },
      });
      sceneName = scene.name;
    } catch (cause) {
      if (cause instanceof ProjectLoadError) {
        errors.push(cause.message, ...cause.issues.map((issue) => `${issue.path}: ${issue.message}`));
      } else {
        errors.push(String(cause));
      }
    }
  })();

  return {
    ready,
    get session() {
      return session;
    },
    get game() {
      return game;
    },
    get scene() {
      return scene;
    },
    start() {
      session?.start();
    },
    async stop() {
      await session?.dispose();
      session = null;
    },
    async restart() {
      await session?.restart(true);
    },
    state: () => ({
      state: session?.state ?? 'stopped',
      projectName,
      sceneName,
      errors,
      warnings,
    }),
  };
}

declare const __COILBOX_PROJECT__: string | undefined;

/**
 * Exported games bake the project location in at build time.
 *
 * The probe tests for absence, not for a string: the dev player build never injects the identifier,
 * and `typeof` is the one form that can ask about a binding that may not exist at all.
 */
const bakedProjectBase = typeof __COILBOX_PROJECT__ === 'undefined' ? undefined : __COILBOX_PROJECT__;

const params = new URLSearchParams(globalThis.location.search);
const canvasElement = document.getElementById('game-canvas');
const canvas = canvasElement instanceof HTMLCanvasElement ? canvasElement : null;
const statusLine = document.getElementById('player-status');

/** Framebuffer sample the exported player reports for automated checks. */
interface PlayerPixelSample {
  width: number;
  height: number;
  nonBackgroundPixels: number;
  distinctColors: number;
}

declare global {
  interface Window {
    __PLAYER__?: PlayerHandle & {
      samplePixels: () => PlayerPixelSample;
      gameState: () => Record<string, JsonValue> | null;
      behaviorList: () => Array<{ entityId: string; behaviorId: string }>;
      stats: () => RuntimeStats | null;
      projectBaseUrl: string;
    };
  }
}

if (canvas) {
  const projectBaseUrl = params.get('project') ?? bakedProjectBase ?? './probe-project/';
  const handle = await startPlayer({ projectBaseUrl, canvas });
  await handle.ready;
  const state = handle.state();
  if (statusLine) {
    // The warning count is deliberately not surfaced here: this line is player-facing chrome, and
    // warnings are available programmatically through `state().warnings` for anything that cares.
    statusLine.textContent =
      state.errors.length > 0 ? `load errors: ${state.errors.join(' | ')}` : `${state.projectName} — ${state.sceneName}`;
  }
  // Spread would freeze `session`, `game`, and `scene` at their start-up values (null, because the
  // project is still loading), so the live ones are getters.
  const exposed: NonNullable<Window['__PLAYER__']> = {
    ready: handle.ready,
    get session() {
      return handle.session;
    },
    get game() {
      return handle.game;
    },
    get scene() {
      return handle.scene;
    },
    start: () => handle.start(),
    stop: () => handle.stop(),
    restart: () => handle.restart(),
    state: () => handle.state(),
    projectBaseUrl,
    gameState: () => handle.session?.current?.getGameState().snapshot() ?? null,
    behaviorList: () => handle.session?.current?.getBehaviorRuntime()?.list() ?? [],
    stats: () => handle.session?.stats() ?? null,
    samplePixels: () => {
      const world = handle.session?.current;
      if (!world) throw new Error('no world');
      world.renderNow(1);
      const gl = canvas.getContext('webgl2');
      if (!gl) throw new Error('no WebGL2 context');
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const counts = new Map<number, number>();
      for (let i = 0; i < width * height; i += 1) {
        const offset = i * 4;
        const key = (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2];
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      let backgroundCount = -1;
      for (const count of counts.values()) if (count > backgroundCount) backgroundCount = count;
      return { width, height, nonBackgroundPixels: width * height - backgroundCount, distinctColors: counts.size };
    },
  };
  window.__PLAYER__ = exposed;
}
