import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeletonAware } from 'three/addons/utils/SkeletonUtils.js';
import type { AssetEntry, AssetId } from '@schema/index.js';
import type { AssetResolver } from './resolver.js';

/**
 * Runtime asset loading (plan §9).
 *
 * - GLTFLoader already loads glTF and exposes imported animation clips; this module
 *   composes it rather than writing a new importer.
 * - Instances are cloned skeleton-aware, so two copies of a skinned model have independent
 *   skeletons and independent animation state.
 * - Materials are cloned per instance, so recolouring one object does not recolour every
 *   instance.
 * - A model whose manifest entry declares an unsupported codec fails with the recorded
 *   message instead of a loader stack trace.
 */

export class UnsupportedAssetError extends Error {
  readonly code = 'unsupported-asset';
  readonly assetId: AssetId;

  constructor(assetId: AssetId, message: string) {
    super(message);
    this.name = 'UnsupportedAssetError';
    this.assetId = assetId;
  }
}

export class MissingAssetError extends Error {
  readonly code = 'missing-asset';
  readonly assetId: AssetId;

  constructor(assetId: AssetId, message: string) {
    super(message);
    this.name = 'MissingAssetError';
    this.assetId = assetId;
  }
}

export interface LoadedModel {
  assetId: AssetId;
  /** The loaded scene as it came out of the loader; never handed to the scene graph directly. */
  source: THREE.Object3D;
  animations: THREE.AnimationClip[];
  clipNames: string[];
  byteLength: number;
  /** False when the source contains no SkinnedMesh, which selects plain cloning. */
  skinned: boolean;
}

export interface ModelInstance {
  object: THREE.Object3D;
  /** Per-instance materials, cloned from the source so instances can differ. */
  materials: THREE.Material[];
  clips: THREE.AnimationClip[];
  source: LoadedModel;
}

export interface AssetCacheOptions {
  resolver: AssetResolver;
  /** Read the manifest entry for an asset id (supplies `requires` and hashes). */
  describe?: (assetId: AssetId) => AssetEntry | undefined;
  fetchImpl?: typeof fetch;
  onWarning?: (message: string) => void;
}

/** glTF extensions this version cannot decode, with the message the user is shown. */
const UNSUPPORTED_EXTENSION_MESSAGES = {
  KHR_draco_mesh_compression:
    'Draco-compressed geometry needs the Draco decoder, which this version does not bundle. Re-export without Draco compression.',
  EXT_meshopt_compression:
    'meshopt-compressed geometry needs the meshopt decoder, which this version does not bundle. Re-export without meshopt compression.',
  KHR_texture_basisu:
    'Basis Universal textures need the KTX2 decoder, which this version does not bundle. Re-export with PNG or JPEG textures.',
};

type UnsupportedExtension = keyof typeof UNSUPPORTED_EXTENSION_MESSAGES;

/** Own keys only: a manifest value like `toString` must not resolve to an inherited function. */
const isUnsupportedExtension = (extension: string): extension is UnsupportedExtension =>
  Object.hasOwn(UNSUPPORTED_EXTENSION_MESSAGES, extension);

/**
 * True for a three.js texture, tested by the library's own duck-type flag. Materials store
 * `null` in unused slots, so this is only ever asked about values that survived a truthiness check.
 */
const isTextureValue = (value: unknown): value is THREE.Texture =>
  typeof value === 'object' && value !== null && 'isTexture' in value && value.isTexture === true;

export class AssetCache {
  private readonly resolver: AssetResolver;
  private readonly describeEntry: ((assetId: AssetId) => AssetEntry | undefined) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly onWarning: (message: string) => void;
  private readonly models = new Map<AssetId, Promise<LoadedModel>>();
  private readonly textures = new Map<AssetId, Promise<THREE.Texture>>();

  constructor(options: AssetCacheOptions) {
    this.resolver = options.resolver;
    this.describeEntry = options.describe;
    // The global `fetch` must be called with `window` as its receiver: storing it and
    // invoking it later as `this.fetchImpl(...)` throws "Illegal invocation" in browsers.
    // A supplied implementation is used as-is so tests can inject their own.
    this.fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    this.onWarning = options.onWarning ?? (() => {});
  }

  /** Load (once) and cache a model asset. Concurrent callers share one load. */
  loadModel(assetId: AssetId): Promise<LoadedModel> {
    const cached = this.models.get(assetId);
    if (cached) return cached;
    const promise = this.loadModelUncached(assetId).catch((cause: unknown) => {
      this.models.delete(assetId);
      throw cause;
    });
    this.models.set(assetId, promise);
    return promise;
  }

  private async loadModelUncached(assetId: AssetId): Promise<LoadedModel> {
    const entry = this.describeEntry?.(assetId);
    if (entry) {
      for (const extension of entry.requires) {
        if (isUnsupportedExtension(extension)) {
          throw new UnsupportedAssetError(assetId, `"${assetId}": ${UNSUPPORTED_EXTENSION_MESSAGES[extension]}`);
        }
      }
    }
    const url = this.resolver.resolveUrl(assetId);
    if (!url) throw new MissingAssetError(assetId, `asset "${assetId}" is not in this project's asset manifest`);

    const response = await this.fetchImpl(url).catch((cause: unknown) => {
      throw new MissingAssetError(assetId, `asset "${assetId}" could not be fetched from ${url}: ${String(cause)}`);
    });
    if (!response.ok) {
      throw new MissingAssetError(assetId, `asset "${assetId}" returned HTTP ${response.status} from ${url}`);
    }
    const buffer = await response.arrayBuffer();

    // A file that is not a GLB never reaches the loader: the message users get names the
    // problem instead of quoting a parser error.
    const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength)));
    if (magic !== 'glTF') {
      const looksLikeText = magic.startsWith('{');
      throw new UnsupportedAssetError(
        assetId,
        looksLikeText
          ? `"${assetId}" is a .gltf document. This version loads self-contained .glb files; export a .glb instead.`
          : `"${assetId}" is not a glTF binary file (expected a GLB header).`,
      );
    }

    const loader = new GLTFLoader();
    // `GLTF` carries the two fields the runtime keeps (a scene root and its clips) plus loader
    // internals this module never touches, so the promise asks for exactly the part it uses.
    const gltf = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((resolve, reject) => {
      loader.parse(buffer, '', (result) => resolve(result), (error) => reject(error));
    }).catch((cause: unknown) => {
      throw new UnsupportedAssetError(assetId, `"${assetId}" could not be parsed as glTF: ${String(cause)}`);
    });

    let skinned = false;
    gltf.scene.traverse((object) => {
      // SAFETY: three.js tags every SkinnedMesh — and only a SkinnedMesh — with `isSkinnedMesh`,
      // and the loader builds the graph with this module's own three.js classes.
      if ((object as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
    });
    if (gltf.animations.length === 0) {
      this.onWarning(`"${assetId}" contains no animation clips`);
    }

    return {
      assetId,
      source: gltf.scene,
      animations: gltf.animations,
      clipNames: gltf.animations.map((clip, index) => clip.name || `clip-${index}`),
      byteLength: buffer.byteLength,
      skinned,
    };
  }

  /**
   * Create an instance of a model.
   *
   * Skinned sources are cloned with SkeletonUtils so the copy owns its bones; all sources
   * get per-instance materials.
   */
  async instantiate(assetId: AssetId): Promise<ModelInstance> {
    const loaded = await this.loadModel(assetId);
    const object = loaded.skinned ? cloneSkeletonAware(loaded.source) : loaded.source.clone(true);
    const materials = cloneMaterialsForInstance(object);
    object.name = `${loaded.source.name || assetId}-instance`;
    return { object, materials, clips: loaded.animations, source: loaded };
  }

  loadTexture(assetId: AssetId): Promise<THREE.Texture> {
    const cached = this.textures.get(assetId);
    if (cached) return cached;
    const promise = (async () => {
      const url = this.resolver.resolveUrl(assetId);
      if (!url) throw new MissingAssetError(assetId, `image asset "${assetId}" is not in this project's asset manifest`);
      const texture = await new THREE.TextureLoader().loadAsync(url);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    })().catch((cause: unknown) => {
      this.textures.delete(assetId);
      throw cause;
    });
    this.textures.set(assetId, promise);
    return promise;
  }

  /** Release cached data and per-instance resources. */
  async dispose(): Promise<void> {
    const models = [...this.models.values()];
    this.models.clear();
    this.textures.clear();
    for (const promise of models) {
      const model = await promise.catch(() => null);
      if (!model) continue;
      disposeObject(model.source);
    }
  }

  get loadedAssetIds(): AssetId[] {
    return [...this.models.keys()];
  }
}

function cloneMaterialsForInstance(root: THREE.Object3D): THREE.Material[] {
  const cloned: THREE.Material[] = [];
  root.traverse((object) => {
    // SAFETY: three.js tags every Mesh — and only a Mesh — with `isMesh`; the flag is an exact
    // runtime test for the `material` slot this reads.
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material;
    if (Array.isArray(material)) {
      mesh.material = material.map((entry) => {
        const copy = entry.clone();
        cloned.push(copy);
        return copy;
      });
    } else if (material) {
      const copy = material.clone();
      mesh.material = copy;
      cloned.push(copy);
    }
  });
  return cloned;
}

/**
 * Release one instance.
 *
 * An instance shares geometry and textures with its source model (clone(true) and
 * SkeletonUtils.clone both share them on purpose — duplicating megabytes of vertex data per
 * copy would be worse). Only the per-instance materials and the cloned skeleton are owned
 * here; geometry and textures are released once, by the cache.
 */
export function disposeInstance(instance: ModelInstance): void {
  for (const material of instance.materials) material.dispose();
  instance.object.traverse((object) => {
    // SAFETY: only a SkinnedMesh carries a `skeleton`, so the duck-type read is undefined for
    // every other object and the guard below skips it.
    const skeleton = (object as THREE.SkinnedMesh).skeleton;
    if (skeleton) skeleton.dispose();
  });
  instance.object.removeFromParent();
}

/** Dispose geometries, materials, and textures of a *source* asset. */
export function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    // SAFETY: the traversal sees every object in the asset; the three fields read here are
    // optional on purpose — a plain Object3D has none of them and each read is guarded below.
    const mesh = object as THREE.Mesh & { skeleton?: THREE.Skeleton };
    if (mesh.geometry) geometries.add(mesh.geometry);
    const material = mesh.material;
    if (Array.isArray(material)) for (const entry of material) materials.add(entry);
    else if (material) materials.add(material);
    if (mesh.skeleton) mesh.skeleton.dispose();
  });
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (isTextureValue(value)) textures.add(value);
    }
    material.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
}
