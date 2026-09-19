import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AssetCache, MissingAssetError, UnsupportedAssetError } from '@runtime/assets/loader.js';
import type { AssetResolver } from '@runtime/assets/resolver.js';
import type { AssetEntry } from '@schema/index.js';

/**
 * Model loading and instancing (plan §9).
 *
 * These run the real GLTFLoader against real GLB fixtures in Node: skeleton-aware instances,
 * independent animation state, per-instance materials, and understandable failures for files
 * this version cannot read.
 */

const repositoryRoot = new URL('../../', import.meta.url).pathname;

/** Serve fixtures from disk with the same fetch shape the browser uses. */
function fixtureFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const relative = url.replace(/^fixture:\/\//, '');
    try {
      const bytes = await readFile(join(repositoryRoot, 'tests', 'fixtures', relative));
      return new Response(new Uint8Array(bytes), { status: 200 });
    } catch {
      return new Response('not found', { status: 404 });
    }
  }) as typeof fetch;
}

function resolverFor(entries: AssetEntry[]): AssetResolver {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    resolveUrl: (assetId) => (byId.has(assetId) ? `fixture://${byId.get(assetId)!.path}` : null),
    getEntry: (assetId) => byId.get(assetId),
    list: () => [...byId.values()],
  };
}

function entry(id: string, path: string, requires: string[] = []): AssetEntry {
  return { id, kind: 'model', path, hash: 'sha256:test', bytes: 0, note: '', requires, meta: {} };
}

const limbEntry = entry('limb', 'models/animated-limb.glb');
const crateEntry = entry('crate', 'models/spinning-crate.glb');

function cacheFor(entries: AssetEntry[], warnings: string[] = []): AssetCache {
  return new AssetCache({
    resolver: resolverFor(entries),
    describe: (assetId) => entries.find((candidate) => candidate.id === assetId),
    fetchImpl: fixtureFetch(),
    onWarning: (message) => warnings.push(message),
  });
}

describe('model loading', () => {
  it('loads a skinned GLB and exposes its clips', async () => {
    const cache = cacheFor([limbEntry]);
    const model = await cache.loadModel('limb');
    expect(model.skinned).toBe(true);
    expect(model.clipNames).toEqual(['Wave']);
    expect(model.animations[0]?.duration).toBeCloseTo(1, 5);
    expect(model.byteLength).toBeGreaterThan(1000);
    expect(cache.loadedAssetIds).toEqual(['limb']);
    await cache.dispose();
  });

  it('caches by asset id so repeated loads share one fetch', async () => {
    let fetches = 0;
    const cache = new AssetCache({
      resolver: resolverFor([crateEntry]),
      describe: () => crateEntry,
      fetchImpl: (async (input: string | URL | Request) => {
        fetches += 1;
        return fixtureFetch()(input as never);
      }) as typeof fetch,
    });
    const [first, second] = await Promise.all([cache.loadModel('crate'), cache.loadModel('crate')]);
    expect(first).toBe(second);
    await cache.loadModel('crate');
    expect(fetches).toBe(1);
    await cache.dispose();
  });

  it('clones skinned models with independent skeletons and animation state', async () => {
    const cache = cacheFor([limbEntry]);
    const a = await cache.instantiate('limb');
    const b = await cache.instantiate('limb');
    expect(a.object).not.toBe(b.object);

    const boneOf = (root: THREE.Object3D) => {
      let bone: THREE.Object3D | null = null;
      root.traverse((object) => {
        if (object.name === 'forearm') bone = object;
      });
      return bone as THREE.Object3D | null;
    };
    const boneA = boneOf(a.object);
    const boneB = boneOf(b.object);
    expect(boneA).not.toBeNull();
    expect(boneB).not.toBeNull();
    expect(boneA).not.toBe(boneB);

    const mixerA = new THREE.AnimationMixer(a.object);
    mixerA.clipAction(a.clips[0]!).play();
    mixerA.update(0.25);

    expect(Math.abs(boneA!.quaternion.z)).toBeGreaterThan(0.01);
    expect(Math.abs(boneB!.quaternion.z)).toBeLessThan(1e-6);
    await cache.dispose();
  });

  it('gives every instance its own materials', async () => {
    const cache = cacheFor([crateEntry]);
    const a = await cache.instantiate('crate');
    const b = await cache.instantiate('crate');
    expect(a.materials.length).toBeGreaterThan(0);
    expect(a.materials[0]).not.toBe(b.materials[0]);

    const meshA = a.object.getObjectByName('Crate') as THREE.Mesh;
    const meshB = b.object.getObjectByName('Crate') as THREE.Mesh;
    (meshA.material as THREE.MeshStandardMaterial).color.set('#ff0000');
    expect((meshB.material as THREE.MeshStandardMaterial).color.getHexString()).not.toBe('ff0000');
    await cache.dispose();
  });

  it('shares geometry between instances rather than duplicating vertex data', async () => {
    const cache = cacheFor([crateEntry]);
    const a = await cache.instantiate('crate');
    const b = await cache.instantiate('crate');
    const meshA = a.object.getObjectByName('Crate') as THREE.Mesh;
    const meshB = b.object.getObjectByName('Crate') as THREE.Mesh;
    expect(meshA.geometry).toBe(meshB.geometry);
    await cache.dispose();
  });

  it('refuses a model that declares a codec this version cannot decode', async () => {
    const draco = entry('draco', 'models/draco-required.glb', ['KHR_draco_mesh_compression']);
    const cache = cacheFor([draco]);
    await expect(cache.loadModel('draco')).rejects.toThrow(UnsupportedAssetError);
    await expect(cache.loadModel('draco')).rejects.toThrow(/Draco decoder/);
    await cache.dispose();
  });

  it('refuses to load a non-image as a texture', async () => {
    const cache = cacheFor([crateEntry]);
    await expect(cache.loadTexture('crate', { colorSpace: 'srgb' })).rejects.toThrow(UnsupportedAssetError);
    await expect(cache.loadTexture('crate', { colorSpace: 'srgb' })).rejects.toThrow(/not an image/);
    await cache.dispose();
  });

  it('reports a missing asset id distinctly from a broken file', async () => {
    const cache = cacheFor([]);
    await expect(cache.loadModel('ghost')).rejects.toThrow(MissingAssetError);

    const broken = entry('broken', 'models/not-a-model.glb');
    const brokenCache = cacheFor([broken]);
    await expect(brokenCache.loadModel('broken')).rejects.toThrow(/not a glTF binary file/);
    await brokenCache.dispose();
    await cache.dispose();
  });

  it('explains that a .gltf document is not supported instead of failing in the parser', async () => {
    const gltf = entry('scene', 'models/scene.gltf');
    const cache = new AssetCache({
      resolver: resolverFor([gltf]),
      describe: () => gltf,
      fetchImpl: (async () => new Response(new TextEncoder().encode('{ "asset": { "version": "2.0" } }'), { status: 200 })) as typeof fetch,
    });
    await expect(cache.loadModel('scene')).rejects.toThrow(/self-contained \.glb/);
    await cache.dispose();
  });

  it('survives a failed load and can retry it', async () => {
    const cache = cacheFor([crateEntry]);
    await expect(cache.loadModel('missing')).rejects.toThrow(MissingAssetError);
    const loaded = await cache.loadModel('crate');
    expect(loaded.clipNames).toEqual(['Hop']);
    await cache.dispose();
  });
});
