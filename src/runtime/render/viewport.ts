import * as THREE from 'three';
import type { RenderSettings, SceneDocument } from '@schema/index.js';
import { EnvironmentProjection } from './environment.js';

/**
 * Runtime viewport: owns the WebGL renderer, the scene, and the active camera.
 *
 * Only Three.js WebGLRenderer is used in v1 (plan §5). WebGPU is not a requirement and
 * switching renderers later must not change the saved project format, so nothing here
 * reads or writes project documents.
 */

export interface ViewportOptions {
  canvas: HTMLCanvasElement;
  render: RenderSettings;
  environment: SceneDocument['environment'];
  /** Label used in error messages, e.g. `play` or `probe`. */
  label?: string;
}

export interface WebGL2Capability {
  supported: boolean;
  /** Reason the capability check failed, when it did. */
  reason?: string;
  renderer?: string;
  vendor?: string;
}

/** Renderer counters read from `renderer.info`, refreshed by `RuntimeViewport.getStats`. */
export interface ViewportStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
}

/**
 * True for a three.js texture, tested by the library's own duck-type flag. Materials store `null`
 * in unused slots, so this is only ever asked about values that survived a truthiness check.
 */
const isTextureValue = (value: unknown): value is THREE.Texture =>
  typeof value === 'object' && value !== null && 'isTexture' in value && value.isTexture === true;

/** Probe WebGL2 support without constructing the full renderer. */
export function checkWebGL2Capability(): WebGL2Capability {
  if (typeof document === 'undefined') {
    return { supported: false, reason: 'no DOM: WebGL2 requires a browser environment' };
  }
  const canvas = document.createElement('canvas');
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
  } catch (cause) {
    return { supported: false, reason: `WebGL2 context creation threw: ${String(cause)}` };
  }
  if (!gl) {
    return { supported: false, reason: 'this browser or GPU does not provide a WebGL2 context' };
  }
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const result: WebGL2Capability = {
    supported: true,
    renderer: debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : undefined,
    vendor: debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)) : undefined,
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return result;
}

export class RuntimeViewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly label: string;

  private readonly canvas: HTMLCanvasElement;
  private readonly pixelRatioCap: number;
  private readonly environment: EnvironmentProjection;
  private disposed = false;

  constructor(options: ViewportOptions) {
    const { canvas, render, environment } = options;
    this.canvas = canvas;
    this.label = options.label ?? 'runtime';
    this.pixelRatioCap = render.pixelRatioCap;

    const capability = checkWebGL2Capability();
    if (!capability.supported) {
      throw new Error(`WebGL2 is required to run games: ${capability.reason ?? 'unsupported'}`);
    }

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: render.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, render.pixelRatioCap));
    this.renderer.shadowMap.enabled = render.shadows;
    // PCFSoftShadowMap is deprecated in three r185; PCF is the supported soft-ish default.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    switch (render.toneMapping) {
      case 'aces':
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        break;
      case 'neutral':
        this.renderer.toneMapping = THREE.NeutralToneMapping;
        break;
      default:
        this.renderer.toneMapping = THREE.NoToneMapping;
        break;
    }
    this.renderer.toneMappingExposure = render.exposure;

    this.scene = new THREE.Scene();
    this.environment = new EnvironmentProjection(this.renderer, this.scene);
    this.applyEnvironment(environment);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    this.camera.position.set(6, 5, 8);
    this.camera.lookAt(0, 0, 0);
  }

  applyEnvironment(environment: SceneDocument['environment']): void {
    this.environment.apply(environment);
  }

  /** Size the drawing buffer from CSS pixels; returns the applied device pixel ratio. */
  resize(cssWidth: number, cssHeight: number): number {
    const width = Math.max(1, Math.floor(cssWidth));
    const height = Math.max(1, Math.floor(cssHeight));
    const ratio = Math.min(globalThis.devicePixelRatio || 1, this.pixelRatioCap);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    return ratio;
  }

  render(camera: THREE.Camera = this.camera): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, camera);
  }

  getStats(): ViewportStats {
    const info = this.renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
    };
  }

  /**
   * Release everything this viewport owns.
   *
   * The WebGL context is deliberately *not* force-lost by default: a canvas can host
   * another world afterwards (Play, Stop, Play again in the editor). Losing the context
   * would leave the canvas unusable for the next world. Pass `releaseContext: true` only
   * when the canvas is being thrown away.
   */
  dispose(options: { releaseContext?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    this.environment.dispose();
    disposeSceneResources(this.scene);
    this.scene.clear();
    this.renderer.dispose();
    if (options.releaseContext) this.renderer.forceContextLoss();
  }
}

/**
 * Dispose every geometry, material, and texture reachable from a scene graph.
 * Materials/geometries shared between objects are disposed once thanks to the sets.
 */
export function disposeSceneResources(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();

  root.traverse((object) => {
    // SAFETY: the traversal sees every object in the scene; the three fields read here are
    // optional on purpose — a plain Object3D has none of them and each read is guarded below.
    const mesh = object as THREE.Mesh & { skeleton?: THREE.Skeleton };
    if (mesh.geometry) geometries.add(mesh.geometry);
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const entry of material) materials.add(entry);
    } else if (material) {
      materials.add(material);
    }
    if (mesh.skeleton) skeletons.add(mesh.skeleton);
  });

  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (isTextureValue(value)) textures.add(value);
    }
    material.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}
