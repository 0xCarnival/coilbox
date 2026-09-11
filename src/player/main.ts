import wasmUrl from 'virtual:box3d-wasm-url';
import { RuntimeWorld } from '@runtime/world.js';
import { describeIssues, loadProjectFromUrl, ProjectLoadError } from '@runtime/project/loader.js';

/**
 * Standalone game entry point (`player.html`).
 *
 * This is the same runtime the editor previews with; it must not import editor code
 * (plan §6). The project is served as plain files next to the build, which is also how
 * an exported game runs:
 *
 *   player.html?project=./my-game/
 *
 * Exported games call `startPlayer()` with a fixed base URL so the query parameter is
 * an authoring convenience rather than part of the export contract.
 */

export interface PlayerOptions {
  /** Base URL the project documents are served from. Must be same-origin in exports. */
  projectBaseUrl: string;
  canvas: HTMLCanvasElement;
  hudRoot?: HTMLElement | null;
  /** Start the simulation immediately (exports do). */
  autoStart?: boolean;
}

export interface PlayerHandle {
  ready: Promise<void>;
  world: RuntimeWorld | null;
  start(): void;
  stop(): void;
  state(): { state: string; projectName: string; sceneName: string; errors: string[] };
}

export async function startPlayer(options: PlayerOptions): Promise<PlayerHandle> {
  const errors: string[] = [];
  let world: RuntimeWorld | null = null;
  let projectName = '';
  let sceneName = '';

  const ready = (async () => {
    try {
      const project = await loadProjectFromUrl(options.projectBaseUrl);
      projectName = project.game.name;
      sceneName = project.scene.name;
      if (project.issues.length > 0) {
        errors.push(...project.issues.map((issue) => `${issue.path}: ${issue.message}`));
      }
      world = await RuntimeWorld.create({
        canvas: options.canvas,
        game: project.game,
        scene: project.scene,
        wasmLocateFile: () => wasmUrl,
        label: 'player',
      });
      if (options.autoStart !== false) world.start();
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
    get world() {
      return world;
    },
    start() {
      world?.start();
    },
    stop() {
      world?.dispose();
      world = null;
    },
    state: () => ({
      state: world ? world.getState() : 'stopped',
      projectName,
      sceneName,
      errors,
    }),
  };
}

const params = new URLSearchParams(globalThis.location.search);
const canvasElement = document.getElementById('game-canvas');
const canvas = canvasElement instanceof HTMLCanvasElement ? canvasElement : null;
const statusLine = document.getElementById('player-status');

declare global {
  interface Window {
    __PLAYER__?: PlayerHandle & { samplePixels: () => unknown; projectBaseUrl: string };
  }
}

if (canvas) {
  const projectBaseUrl = params.get('project') ?? './probe-project/';
  const handle = await startPlayer({ projectBaseUrl, canvas });
  await handle.ready;
  const state = handle.state();
  if (statusLine) {
    statusLine.textContent =
      state.errors.length > 0 ? `load errors: ${describeIssues([]) || state.errors.join(' | ')}` : `${state.projectName} — ${state.sceneName}`;
  }
  window.__PLAYER__ = {
    ...handle,
    projectBaseUrl,
    samplePixels: () => {
      const world = handle.world;
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
}
