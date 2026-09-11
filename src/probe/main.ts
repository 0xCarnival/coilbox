import wasmUrl from 'virtual:box3d-wasm-url';
import { RuntimeWorld, RuntimeWorldError, type RuntimeStats } from '@runtime/world.js';
import { createBox3DBackend } from '@runtime/physics/box3d-adapter.js';
import type { PhysicsBackend } from '@runtime/physics/types.js';
import { probeGame, probeScene, PROBE_BOX_ID, PROBE_DROP_Y, PROBE_RESTING_Y } from '@runtime/probe/scene.js';
import { Quaternion as THREEQuaternion, Vector3 } from 'three';

/**
 * Stage 0 probe page.
 *
 * Not a game and not the editor: it exists to prove that the blank runtime renders a
 * box, that Box3D actually simulates it, that Stop releases everything it owns, and
 * that the same code runs from a production build on a static server.
 *
 * `window.__STAGE0__` is the machine-readable surface the automated checks drive. The
 * physics backend is deliberately created once and shared across Play/Stop cycles so
 * the live world count is observable after a world has been disposed.
 */

interface PixelStats {
  width: number;
  height: number;
  /** Pixels differing from the most common pixel colour. */
  nonBackgroundPixels: number;
  /** Distinct colours seen in the sampled frame. */
  distinctColors: number;
  meanLuminance: number;
}

interface ProbeState {
  state: string;
  boxY: number;
  boxDroppedFrom: number;
  expectedRestingY: number;
  physicsWorldCount: number;
  wasmBytes: number;
  wasmUrl: string;
  binding: string;
  bindingVersion: string;
  doublePrecision: boolean;
  warnings: string[];
  rendererInfo: { geometries: number; textures: number; programs: number } | null;
  listenerCount: number;
  worldsCreated: number;
  /** The canvas still has a usable WebGL2 context after Stop, ready for the next world. */
  contextAlive: boolean;
}

interface SceneInspection {
  camera: {
    localPosition: number[];
    worldPosition: number[];
    worldQuaternion: number[];
    aspect: number;
    near: number;
    far: number;
    parent: string | null;
    inScene: boolean;
  };
  entities: Array<{ id: string; position: number[]; visible: boolean; children: number }>;
  renderer: { width: number; height: number; pixelRatio: number };
}

interface ProbeHandle {
  /** Human-readable snapshot of the live scene, used by the checks and for debugging. */
  inspect(): SceneInspection;
  play(): Promise<void>;
  pause(): void;
  step(): void;
  stop(): void;
  reset(): Promise<void>;
  stats(): RuntimeStats | null;
  samplePixels(): PixelStats;
  readState(): ProbeState;
  error(): string | null;
  ready: Promise<void>;
}

declare global {
  interface Window {
    __STAGE0__?: ProbeHandle;
  }
}

const canvasElement = document.getElementById('probe-canvas');
if (!(canvasElement instanceof HTMLCanvasElement)) throw new Error('probe page is missing #probe-canvas');
const canvas: HTMLCanvasElement = canvasElement;
const statusLine = document.getElementById('probe-status');
const statsLine = document.getElementById('probe-stats');
const errorLine = document.getElementById('probe-error');
const infoLine = document.getElementById('probe-info');

let backend: PhysicsBackend | null = null;
let world: RuntimeWorld | null = null;
let lastError: string | null = null;
let worldsCreated = 0;

const boxSample = new Float32Array(7);

function setStatus(text: string): void {
  if (statusLine) statusLine.textContent = text;
}

function setError(text: string | null): void {
  lastError = text;
  if (errorLine) {
    errorLine.textContent = text ?? '';
    errorLine.style.display = text ? 'block' : 'none';
  }
}

async function ensureBackend(): Promise<PhysicsBackend> {
  if (!backend) {
    backend = await createBox3DBackend({ locateFile: () => wasmUrl });
    if (infoLine) {
      infoLine.textContent = `${backend.name} (engine ${backend.version}, doublePrecision=${backend.doublePrecision})`;
    }
  }
  return backend;
}

async function createWorld(): Promise<RuntimeWorld> {
  const shared = await ensureBackend();
  const created = await RuntimeWorld.create({
    canvas,
    game: probeGame,
    scene: probeScene,
    physicsBackend: shared,
    label: 'stage0-probe',
    onError: (error: RuntimeWorldError) => setError(`${error.code}: ${error.message}`),
  });
  worldsCreated += 1;
  return created;
}

async function reset(): Promise<void> {
  world?.dispose();
  world = null;
  world = await createWorld();
  setError(null);
  setStatus('ready — press Play');
  updateStats();
}

async function play(): Promise<void> {
  if (!world || world.isDisposed) world = await createWorld();
  world.start();
  setStatus('running');
}

function pause(): void {
  world?.pause();
  setStatus('paused');
}

function step(): void {
  if (!world || world.isDisposed) return;
  if (world.getState() === 'running') world.pause();
  world.step();
  setStatus('stepped one fixed tick');
  updateStats();
}

function stop(): void {
  world?.dispose();
  setStatus('stopped — runtime resources released');
  updateStats();
}

/**
 * Read the framebuffer straight after an explicit render. The drawing buffer is not
 * preserved between frames, so sampling has to happen in the same task as the draw.
 */
function samplePixels(): PixelStats {
  if (!world || world.isDisposed) throw new Error('no runtime world to sample');
  world.renderNow(1);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('no WebGL2 context to sample');
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  const counts = new Map<number, number>();
  let luminanceSum = 0;
  const total = width * height;
  for (let i = 0; i < total; i += 1) {
    const offset = i * 4;
    const key = (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
    luminanceSum += 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
  }
  let backgroundCount = -1;
  for (const count of counts.values()) {
    if (count > backgroundCount) backgroundCount = count;
  }
  return {
    width,
    height,
    nonBackgroundPixels: total - backgroundCount,
    distinctColors: counts.size,
    meanLuminance: luminanceSum / total,
  };
}

function readBoxY(): number {
  if (!world || world.isDisposed) return Number.NaN;
  return world.readEntityTransform(PROBE_BOX_ID, boxSample) ? boxSample[1] : Number.NaN;
}

function readState(): ProbeState {
  const live = world && !world.isDisposed ? world : null;
  const stats = live?.getStats() ?? null;
  return {
    state: live ? live.getState() : 'stopped',
    boxY: readBoxY(),
    boxDroppedFrom: PROBE_DROP_Y,
    expectedRestingY: PROBE_RESTING_Y,
    physicsWorldCount: backend ? backend.getWorldCount() : 0,
    wasmBytes: backend ? backend.getByteCount() : 0,
    wasmUrl,
    binding: backend?.name ?? 'unloaded',
    bindingVersion: backend?.version ?? '',
    doublePrecision: backend?.doublePrecision ?? false,
    warnings: live ? [...live.warnings] : [],
    rendererInfo: stats ? { geometries: stats.geometries, textures: stats.textures, programs: stats.programs } : null,
    listenerCount: live ? live.getListenerCount() : 0,
    worldsCreated,
    contextAlive: canvas.getContext('webgl2') !== null,
  };
}

function updateStats(): void {
  if (!statsLine) return;
  const state = readState();
  statsLine.textContent = [
    `state=${state.state}`,
    `worlds=${state.physicsWorldCount}`,
    `boxY=${Number.isFinite(state.boxY) ? state.boxY.toFixed(3) : 'n/a'}`,
    `geometries=${state.rendererInfo?.geometries ?? 'n/a'}`,
    `listeners=${state.listenerCount}`,
  ].join('  ');
}

const newVector3 = (): Vector3 => new Vector3();

function inspect(): SceneInspection {
  if (!world || world.isDisposed) throw new Error('no world to inspect');
  const camera = world.getCamera();
  return {
    camera: {
      localPosition: camera.position.toArray(),
      worldPosition: camera.getWorldPosition(new Vector3()).toArray(),
      worldQuaternion: camera.getWorldQuaternion(new THREEQuaternion()).toArray(),
      aspect: camera.aspect,
      near: camera.near,
      far: camera.far,
      parent: camera.parent ? String(camera.parent.name || camera.parent.type) : null,
      inScene: Boolean(camera.parent),
    },
    entities: world.getEntityIds().map((id) => {
      const object = world!.getEntityObject(id);
      return {
        id,
        position: object ? object.getWorldPosition(newVector3()).toArray() : [],
        visible: object?.visible ?? false,
        children: object?.children.length ?? 0,
      };
    }),
    renderer: {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      pixelRatio: globalThis.devicePixelRatio,
    },
  };
}

const ready = (async () => {
  await reset();
})();

const handle: ProbeHandle = {
  inspect,
  async play() {
    await play();
  },
  pause,
  step,
  stop,
  reset,
  stats: () => (world && !world.isDisposed ? world.getStats() : null),
  samplePixels,
  readState,
  error: () => lastError,
  ready,
};

window.__STAGE0__ = handle;

document.getElementById('btn-play')?.addEventListener('click', () => void play());
document.getElementById('btn-pause')?.addEventListener('click', pause);
document.getElementById('btn-step')?.addEventListener('click', step);
document.getElementById('btn-stop')?.addEventListener('click', stop);
document.getElementById('btn-reset')?.addEventListener('click', () => void reset());

window.addEventListener('error', (event) => setError(String(event.error ?? event.message)));

setInterval(() => {
  if (world && !world.isDisposed && world.getState() === 'running') updateStats();
}, 250);
