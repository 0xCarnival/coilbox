import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssetService } from '../../server/assets.js';
import { Workspace } from '../../server/workspace.js';
import { parseAssetManifest } from '@schema/index.js';

/**
 * Asset import (plan §9): stable ids, content hashes, a declared supported subset, and
 * explicit replacement. Unsupported imports must be refused with a reason, never accepted
 * and then failing later inside a loader.
 */

const repositoryRoot = new URL('../../', import.meta.url).pathname;
const fixture = (relative: string) => join(repositoryRoot, 'tests', 'fixtures', relative);

let workspaceRoot: string;
let workspace: Workspace;
let assets: AssetService;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'coilbox-assets-'));
  workspace = new Workspace({ root: workspaceRoot, templatesRoot: join(repositoryRoot, 'templates') });
  assets = new AssetService(workspace);
  await workspace.createProject({ id: 'g', name: 'G' });
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

async function importFixture(filename: string, options: { replaceAssetId?: string; assetId?: string } = {}) {
  const bytes = new Uint8Array(await readFile(fixture(filename)));
  return assets.import({ projectId: 'g', filename: filename.split('/').pop() ?? filename, bytes, ...options });
}

describe('asset import', () => {
  it('imports a GLB with a content hash and a stable id', async () => {
    const result = await importFixture('models/spinning-crate.glb');
    expect(result.entry.kind).toBe('model');
    expect(result.entry.id).toBe('spinning-crate');
    expect(result.entry.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.entry.path).toMatch(/^assets\/models\/spinning-crate-[0-9a-f]{8}\.glb$/);
    expect(result.entry.requires).toEqual([]);
    expect(existsSync(join(workspaceRoot, 'g', result.entry.path))).toBe(true);

    const manifest = JSON.parse(await readFile(join(workspaceRoot, 'g', 'assets', 'manifest.json'), 'utf8'));
    expect(parseAssetManifest(manifest).ok).toBe(true);
    expect(manifest.assets).toHaveLength(1);
  });

  it('records the extensions a model requires instead of pretending it will load', async () => {
    const result = await importFixture('models/draco-required.glb');
    expect(result.entry.requires).toContain('KHR_draco_mesh_compression');
  });

  it('refuses formats this version does not support, with a reason', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(assets.import({ projectId: 'g', filename: 'hero.fbx', bytes })).rejects.toThrow(/FBX is not supported/);
    await expect(assets.import({ projectId: 'g', filename: 'skin.blend', bytes })).rejects.toThrow(/Blender files are not supported/);
    await expect(assets.import({ projectId: 'g', filename: 'tex.ktx2', bytes })).rejects.toThrow(/decoder this version does not bundle/);
    await expect(assets.import({ projectId: 'g', filename: 'sound.flac', bytes })).rejects.toThrow(/tested audio set/);
    await expect(assets.import({ projectId: 'g', filename: 'archive.zip', bytes })).rejects.toThrow(/not a supported asset/);
  });

  it('refuses an empty file and an oversized file', async () => {
    await expect(assets.import({ projectId: 'g', filename: 'empty.glb', bytes: new Uint8Array(0) })).rejects.toThrow(/empty/);
    const huge = new Uint8Array(65 * 1024 * 1024);
    await expect(assets.import({ projectId: 'g', filename: 'huge.glb', bytes: huge })).rejects.toThrow(/limited to 64 MiB/);
  });

  it('refuses a file whose kind does not match its extension', async () => {
    const bytes = new Uint8Array(await readFile(fixture('images/swatch.png')));
    await expect(assets.import({ projectId: 'g', filename: 'swatch.png', bytes, kind: 'model' })).rejects.toThrow(
      /not a model this version supports/,
    );
  });

  it('gives a second asset with the same name a distinct id', async () => {
    const first = await importFixture('models/spinning-crate.glb');
    const bytes = new Uint8Array(await readFile(fixture('models/animated-limb.glb')));
    const second = await assets.import({ projectId: 'g', filename: 'spinning-crate.glb', bytes });
    expect(second.entry.id).not.toBe(first.entry.id);
    expect(second.entry.id).toBe('spinning-crate-2');
  });

  it('replaces the bytes behind an asset id without changing its identity', async () => {
    const original = await importFixture('models/spinning-crate.glb');
    const replacement = await importFixture('models/animated-limb.glb', { replaceAssetId: original.entry.id });

    expect(replacement.replaced).toBe(true);
    expect(replacement.entry.id).toBe(original.entry.id);
    expect(replacement.entry.hash).not.toBe(original.entry.hash);
    expect(replacement.entry.path).not.toBe(original.entry.path);
    expect(replacement.manifest.assets).toHaveLength(1);

    // The previous file is archived rather than deleted.
    const archived = join(workspaceRoot, 'g', '.coilbox', 'assets');
    expect(existsSync(archived)).toBe(true);
    expect(existsSync(join(workspaceRoot, 'g', original.entry.path))).toBe(false);
  });

  it('refuses to replace a model with an image', async () => {
    const model = await importFixture('models/spinning-crate.glb');
    const bytes = new Uint8Array(await readFile(fixture('images/swatch.png')));
    await expect(
      assets.import({ projectId: 'g', filename: 'swatch.png', bytes, replaceAssetId: model.entry.id }),
    ).rejects.toThrow(/would break the scenes that use it/);
  });

  it('refuses to replace an asset that does not exist', async () => {
    await expect(importFixture('models/spinning-crate.glb', { replaceAssetId: 'ghost' })).rejects.toThrow(/no asset "ghost"/);
  });

  it('reports where an asset is used and refuses to remove it while scenes reference it', async () => {
    const imported = await importFixture('models/spinning-crate.glb');
    const scene = await workspace.readScene('g', 'main');
    scene.entities.push({
      id: 'crate',
      name: 'Crate',
      parentId: null,
      order: 9,
      enabled: true,
      transform: { position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [{ type: 'model', assetId: imported.entry.id, castShadow: true, receiveShadow: true }],
      editor: { visible: true, locked: false, color: null, helper: false },
    });
    await workspace.writeScene('g', 'main', scene, { expectedRevision: scene.revision });

    const usage = await assets.usageIndex('g');
    expect(usage[imported.entry.id]).toEqual([{ sceneId: 'main', entityId: 'crate', entityName: 'Crate' }]);
    await expect(assets.remove('g', imported.entry.id)).rejects.toThrow(/used by main/);

    // Removing the reference makes the asset removable again.
    const updated = await workspace.readScene('g', 'main');
    updated.entities = updated.entities.filter((entity) => entity.id !== 'crate');
    await workspace.writeScene('g', 'main', updated, { expectedRevision: updated.revision });

    const removed = await assets.remove('g', imported.entry.id);
    expect(removed.manifest.assets).toHaveLength(0);
    expect(removed.removed.id).toBe(imported.entry.id);
  });

  it('serves the stored bytes and reports a missing file distinctly', async () => {
    const imported = await importFixture('images/swatch.png');
    const { path, entry } = await assets.assetFilePath('g', imported.entry.id);
    expect(entry.kind).toBe('image');
    expect(new Uint8Array(await readFile(path)).byteLength).toBe(imported.entry.bytes);

    await rm(path);
    await expect(assets.assetFilePath('g', imported.entry.id)).rejects.toThrow(/listed in the manifest but/);
  });

  it('warns when a model file is not a GLB at all', async () => {
    const result = await importFixture('models/not-a-model.glb');
    expect(result.warnings.join(' ')).toMatch(/too short to be a GLB|does not start with a GLB header/);
  });
});
