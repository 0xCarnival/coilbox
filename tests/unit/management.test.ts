import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTarGz, readTarGz, ArchiveError } from '../../server/archive.js';
import { ProjectManager } from '../../server/management.js';
import { Workspace } from '../../server/workspace.js';
import { ProjectWatcher, type SceneChangeEvent } from '../../server/watcher.js';

/**
 * Project management and external-change handling (plan §11, §13, §14).
 *
 * These cover the failure modes the plan calls out: source archives that must not carry caches
 * or credentials, imports that must validate before writing and never execute project code,
 * archiving that stays recoverable, and external edits that must never silently replace what the
 * editor holds.
 */

const repositoryRoot = new URL('../../', import.meta.url).pathname;

let workspaceRoot: string;
let workspace: Workspace;
let manager: ProjectManager;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'coilbox-manage-'));
  workspace = new Workspace({ root: workspaceRoot, templatesRoot: join(repositoryRoot, 'templates') });
  manager = new ProjectManager(workspace);
  await workspace.createProject({ id: 'alpha', name: 'Alpha', template: 'blank' });
  await workspace.createProject({ id: 'beta', name: 'Beta', template: 'blank' });
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('tar archives', () => {
  it('round-trips files and directories', () => {
    const entries = [
      { path: 'game.json', bytes: new TextEncoder().encode('{"a":1}') },
      { path: 'scenes/main.scene.json', bytes: new TextEncoder().encode('{"b":2}') },
      { path: 'assets/models/thing.glb', bytes: new Uint8Array([1, 2, 3, 4, 5]) },
    ];
    const archive = createTarGz(entries);
    expect(archive.byteLength).toBeGreaterThan(0);
    const read = readTarGz(archive);
    expect(read.map((entry) => entry.path)).toEqual(entries.map((entry) => entry.path));
    expect(new TextDecoder().decode(read[0]!.bytes)).toBe('{"a":1}');
    expect(Array.from(read[2]!.bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it('refuses to write unsafe paths and to read non-archives', () => {
    expect(() => createTarGz([{ path: '../escape.json', bytes: new Uint8Array() }])).toThrow(ArchiveError);
    expect(() => createTarGz([{ path: '/etc/passwd', bytes: new Uint8Array() }])).toThrow(ArchiveError);
    expect(() => readTarGz(new Uint8Array([1, 2, 3]))).toThrow(/not a gzipped tar/);
  });

  it('enforces entry limits', () => {
    const archive = createTarGz([{ path: 'big.bin', bytes: new Uint8Array(2048) }]);
    expect(() => readTarGz(archive, { maxEntries: 10, maxEntryBytes: 100, maxTotalBytes: 10_000 })).toThrow(/over the per-file limit/);
    expect(() => readTarGz(archive, { maxEntries: 10, maxEntryBytes: 10_000, maxTotalBytes: 100 })).toThrow(
      /more data than the limit|over the limit/,
    );
  });
});

describe('duplicate', () => {
  it('copies a project with a new id and name and leaves the original alone', async () => {
    const scene = await workspace.readScene('alpha', 'main');
    scene.entities[1]!.transform.position = [4, 1, 0];
    await workspace.writeScene('alpha', 'main', scene, { expectedRevision: scene.revision });

    const result = await manager.duplicate('alpha', { newId: 'alpha-copy', newName: 'Alpha Copy' });
    expect(result.projectId).toBe('alpha-copy');

    const copy = await workspace.readProject('alpha-copy');
    expect(copy.name).toBe('Alpha Copy');
    expect(copy.game.id).toBe('alpha-copy');
    const copiedScene = await workspace.readScene('alpha-copy', 'main');
    expect(copiedScene.entities[1]!.transform.position).toEqual([4, 1, 0]);

    // Editing the copy must not touch the original.
    copiedScene.entities[1]!.transform.position = [9, 1, 0];
    await workspace.writeScene('alpha-copy', 'main', copiedScene, { expectedRevision: copiedScene.revision });
    expect((await workspace.readScene('alpha', 'main')).entities[1]!.transform.position).toEqual([4, 1, 0]);
  });

  it('excludes caches and build output from the copy', async () => {
    await mkdir(join(workspaceRoot, 'alpha', '.coilbox', 'export'), { recursive: true });
    await writeFile(join(workspaceRoot, 'alpha', '.coilbox', 'export', 'big.js'), 'x');
    await mkdir(join(workspaceRoot, 'alpha', 'node_modules'), { recursive: true });
    await writeFile(join(workspaceRoot, 'alpha', 'node_modules', 'dep.js'), 'x');

    await manager.duplicate('alpha', { newId: 'alpha-copy' });
    expect(existsSync(join(workspaceRoot, 'alpha-copy', '.coilbox'))).toBe(false);
    expect(existsSync(join(workspaceRoot, 'alpha-copy', 'node_modules'))).toBe(false);
  });

  it('refuses an id that is already taken', async () => {
    await expect(manager.duplicate('alpha', { newId: 'beta' })).rejects.toThrow(/already exists/);
  });
});

describe('archive and restore', () => {
  it('moves a project into a recoverable archive and restores it', async () => {
    const result = await manager.archive('alpha', { reason: 'test' });
    // The returned name is what `restore()` takes back; the detail line shows where it went.
    expect(result.directory).toMatch(/^alpha-/);
    expect(result.detail).toContain('.archive/');
    expect(existsSync(join(workspaceRoot, 'alpha'))).toBe(false);

    const archived = await manager.listArchived();
    expect(archived).toHaveLength(1);
    expect(archived[0]!.projectId).toBe('alpha');
    expect(archived[0]!.reason).toBe('test');

    const restored = await manager.restore(archived[0]!.directory);
    expect(restored.projectId).toBe('alpha');
    const scene = await workspace.readScene('alpha', 'main');
    expect(scene.entities.length).toBeGreaterThan(0);
    expect((await manager.listArchived()).length).toBe(0);
  });

  it('refuses to restore into a name that is in use', async () => {
    const archived = await manager.archive('alpha');
    await workspace.createProject({ id: 'alpha', name: 'Alpha again', template: 'blank' });
    await expect(manager.restore(archived.directory)).rejects.toThrow(/already exists/);
  });
});

describe('source export and import', () => {
  it('exports the documents and excludes caches, then imports them into a new project', async () => {
    await mkdir(join(workspaceRoot, 'alpha', '.coilbox', 'export'), { recursive: true });
    await writeFile(join(workspaceRoot, 'alpha', '.coilbox', 'export', 'bundle.js'), 'should not travel');
    await writeFile(join(workspaceRoot, 'alpha', 'scenes', 'main.scene.json.tmp-123'), '{}');

    const exported = await manager.exportSource('alpha');
    const paths = exported.entries.map((entry) => entry.path);
    expect(paths).toContain('game.json');
    expect(paths).toContain('scenes/main.scene.json');
    expect(paths).toContain('COMPATIBILITY.json');
    expect(paths.some((path) => path.includes('.coilbox'))).toBe(false);
    expect(paths.some((path) => path.includes('.tmp-'))).toBe(false);

    const imported = await manager.importSource(exported.bytes, { projectId: 'alpha-restored', name: 'Alpha Restored' });
    expect(imported.projectId).toBe('alpha-restored');
    expect(imported.warnings).toEqual([]);
    expect(imported.detail).toMatch(/imported/);

    const project = await workspace.readProject('alpha-restored');
    expect(project.name).toBe('Alpha Restored');
    expect(project.game.id).toBe('alpha-restored');
    expect(existsSync(join(workspaceRoot, 'alpha-restored', '.coilbox'))).toBe(false);
  });

  it('refuses an archive without game.json and one with an unsafe path', async () => {
    const noGame = createTarGz([{ path: 'README.md', bytes: new TextEncoder().encode('hi') }]);
    await expect(manager.importSource(noGame, { projectId: 'x' })).rejects.toThrow(/does not contain game.json/);

    const scene = await readFile(join(workspaceRoot, 'alpha', 'scenes', 'main.scene.json'));
    const game = await readFile(join(workspaceRoot, 'alpha', 'game.json'));
    const sneaky = createTarGz([
      { path: 'game.json', bytes: new Uint8Array(game) },
      { path: 'scenes/main.scene.json', bytes: new Uint8Array(scene) },
    ]);
    // A tampered archive is caught by the same reader used for well-formed ones.
    await expect(manager.importSource(sneaky.subarray(0, 20), { projectId: 'y' })).rejects.toThrow();
  });

  it('refuses a scene that does not validate, without writing anything', async () => {
    const game = await readFile(join(workspaceRoot, 'alpha', 'game.json'));
    const archive = createTarGz([
      { path: 'game.json', bytes: new Uint8Array(game) },
      { path: 'scenes/main.scene.json', bytes: new TextEncoder().encode('{"schemaVersion":1,"id":"main","name":"Main","entities":[{"id":"a","name":"A","parentId":"missing"}]}') },
    ]);
    await expect(manager.importSource(archive, { projectId: 'broken' })).rejects.toThrow(/not a valid scene document/);
    expect(existsSync(join(workspaceRoot, 'broken'))).toBe(false);
  });

  it('refuses a newer schema version with an explanation', async () => {
    const game = JSON.parse(await readFile(join(workspaceRoot, 'alpha', 'game.json'), 'utf8')) as Record<string, unknown>;
    const scene = await readFile(join(workspaceRoot, 'alpha', 'scenes', 'main.scene.json'));
    const archive = createTarGz([
      { path: 'game.json', bytes: new TextEncoder().encode(JSON.stringify(game)) },
      { path: 'scenes/main.scene.json', bytes: new Uint8Array(scene) },
      { path: 'COMPATIBILITY.json', bytes: new TextEncoder().encode(JSON.stringify({ schemaVersion: 99, engineCompat: '9.9.9' })) },
    ]);
    await expect(manager.importSource(archive, { projectId: 'future' })).rejects.toThrow(/schema version 99/);
    expect(existsSync(join(workspaceRoot, 'future'))).toBe(false);
  });

  it('warns when a newer engine wrote the archive but still imports it', async () => {
    const game = await readFile(join(workspaceRoot, 'alpha', 'game.json'));
    const scene = await readFile(join(workspaceRoot, 'alpha', 'scenes', 'main.scene.json'));
    const archive = createTarGz([
      { path: 'game.json', bytes: new Uint8Array(game) },
      { path: 'scenes/main.scene.json', bytes: new Uint8Array(scene) },
      { path: 'COMPATIBILITY.json', bytes: new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, engineCompat: '0.0.9' })) },
    ]);
    const result = await manager.importSource(archive, { projectId: 'older' });
    expect(result.warnings.join(' ')).toMatch(/engine 0.0.9/);
  });

  it('warns about a missing registry but imports the project', async () => {
    const game = await readFile(join(workspaceRoot, 'alpha', 'game.json'));
    const scene = await readFile(join(workspaceRoot, 'alpha', 'scenes', 'main.scene.json'));
    const archive = createTarGz([
      { path: 'game.json', bytes: new Uint8Array(game) },
      { path: 'scenes/main.scene.json', bytes: new Uint8Array(scene) },
    ]);
    const result = await manager.importSource(archive, { projectId: 'no-registry' });
    expect(result.warnings.join(' ')).toMatch(/registry.json is missing/);
  });
});

describe('validation catches behavior mistakes', () => {
  it('reports an unregistered behavior id', async () => {
    // Written straight to disk, the way an agent or a hand edit would: validation is exactly what
    // has to catch this, because the write path would have refused it.
    const path = join(workspaceRoot, 'alpha', 'scenes', 'main.scene.json');
    const raw = JSON.parse(await readFile(path, 'utf8')) as { entities: unknown[] };
    raw.entities.push({
      id: 'gem',
      name: 'Gem',
      parentId: null,
      order: 9,
      enabled: true,
      transform: { position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [{ type: 'behavior', behaviorId: 'game.does-not-exist', properties: {} }],
      editor: { visible: true, locked: false, color: null, helper: false },
    });
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const report = await workspace.validateProject('alpha');
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain('unknown-behavior');
  });

  it('reports a behavior property with the wrong type', async () => {
    await workspace.createProject({ id: 'gamma', name: 'Gamma', template: 'collect-room' });
    const scene = await workspace.readScene('gamma', 'main');
    const player = scene.entities.find((entity) => entity.id === 'player')!;
    const behaviorComponent = player.components.find((component) => component.type === 'behavior') as Extract<
      (typeof player.components)[number],
      { type: 'behavior' }
    >;
    behaviorComponent.properties.moveSpeed = 'fast' as never;
    await expect(
      workspace.writeScene('gamma', 'main', scene, { expectedRevision: scene.revision }),
    ).rejects.toThrow(/refusing to write an invalid scene document/);
  });
});

describe('external change watching', () => {
  it('reports a valid external edit with its revision', async () => {
    const events: SceneChangeEvent[] = [];
    const watcher = new ProjectWatcher({ workspace, projectId: 'alpha', debounceMs: 30, onEvent: (event) => events.push(event) });
    await watcher.start();
    try {
      const scene = await workspace.readScene('alpha', 'main');
      scene.entities[1]!.transform.position = [3, 1, 0];
      await workspace.writeScene('alpha', 'main', scene, { expectedRevision: scene.revision });
      await waitFor(() => events.some((event) => event.kind === 'scene-updated'));

      const event = events.find((candidate) => candidate.kind === 'scene-updated')!;
      expect(event.sceneId).toBe('main');
      expect(event.revision).toBe(1);
    } finally {
      watcher.close();
    }
  });

  it('reports an invalid external write instead of loading it', async () => {
    const events: SceneChangeEvent[] = [];
    const watcher = new ProjectWatcher({ workspace, projectId: 'alpha', debounceMs: 30, onEvent: (event) => events.push(event) });
    await watcher.start();
    try {
      await writeFile(join(workspaceRoot, 'alpha', 'scenes', 'main.scene.json'), '{ this is not json');
      await waitFor(() => events.some((event) => event.kind === 'invalid'));
      const event = events.find((candidate) => candidate.kind === 'invalid')!;
      expect(event.message).toMatch(/not valid JSON/);
      expect(event.message).toMatch(/keeps its last known-good document/);
    } finally {
      watcher.close();
    }
  });

  it('debounces a burst of writes into one event', async () => {
    const events: SceneChangeEvent[] = [];
    const watcher = new ProjectWatcher({ workspace, projectId: 'alpha', debounceMs: 80, onEvent: (event) => events.push(event) });
    await watcher.start();
    try {
      const path = join(workspaceRoot, 'alpha', 'scenes', 'main.scene.json');
      const scene = await workspace.readScene('alpha', 'main');
      for (let index = 0; index < 5; index += 1) {
        scene.entities[1]!.transform.position = [index, 1, 0];
        await writeFile(path, `${JSON.stringify(scene, null, 2)}\n`, 'utf8');
      }
      await waitFor(() => events.some((event) => event.kind === 'scene-updated'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(events.filter((event) => event.kind === 'scene-updated').length).toBe(1);
    } finally {
      watcher.close();
    }
  });

  it('reports asset folder changes without pretending a scene changed', async () => {
    const events: SceneChangeEvent[] = [];
    const watcher = new ProjectWatcher({ workspace, projectId: 'alpha', debounceMs: 30, onEvent: (event) => events.push(event) });
    await watcher.start();
    try {
      await mkdir(join(workspaceRoot, 'alpha', 'assets', 'models'), { recursive: true });
      await writeFile(join(workspaceRoot, 'alpha', 'assets', 'models', 'thing.glb'), 'x');
      await waitFor(() => events.some((event) => event.kind === 'assets-changed'));
      expect(events.some((event) => event.kind === 'scene-updated')).toBe(false);
    } finally {
      watcher.close();
    }
  });
});

/**
 * `fs.watch` delivery is asynchronous and can lag well behind the write when the machine is busy
 * (the gates run this suite next to a production build). The bound is generous on purpose: it only
 * decides how long a *failing* wait takes, never how long a passing one does.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the expected event');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
