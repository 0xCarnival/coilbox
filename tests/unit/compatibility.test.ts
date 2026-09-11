import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace, PROJECT_FILES, writeFileAtomic } from '../../server/workspace.js';
import { parseGame, parseScene } from '@schema/index.js';

/**
 * Compatibility and recovery fixtures (plan §7, §15 stage 5, §16).
 *
 * The plan asks for compatibility fixtures and a fixture test for anything that migrates, plus a
 * guarantee that a document this build cannot read is never rewritten. These tests exercise the
 * three fixture projects and the recovery paths around them.
 */

const repositoryRoot = new URL('../../', import.meta.url).pathname;
const fixtures = join(repositoryRoot, 'tests', 'fixtures', 'projects');

let workspaceRoot: string;
let workspace: Workspace;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'coilbox-compat-'));
  workspace = new Workspace({ root: workspaceRoot, templatesRoot: join(repositoryRoot, 'templates') });
  await workspace.ensureRoot();
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

async function install(fixture: string, as: string): Promise<void> {
  await cp(join(fixtures, fixture), join(workspaceRoot, as), { recursive: true });
}

describe('compatibility fixtures', () => {
  it('reads a document written at the current schema version', async () => {
    await install('compat-current', 'current');
    const project = await workspace.readProject('compat-current');
    expect(project.game.schemaVersion).toBe(1);
    const scene = await workspace.readScene('compat-current', 'main');
    expect(scene.revision).toBe(3);
    expect(scene.entities.map((entity) => entity.id)).toEqual(['floor', 'camera']);
    expect(scene.activeCameraId).toBe('camera');
  });

  it('refuses a newer schema version without touching the file', async () => {
    await install('compat-future', 'future');
    const before = await readFile(join(workspaceRoot, 'future', PROJECT_FILES.game), 'utf8');

    // Reading is the point of the fixture: the manifest parses structurally, but the version is
    // what a real loader must check before trusting it.
    const raw = JSON.parse(before) as { schemaVersion: number };
    expect(raw.schemaVersion).toBeGreaterThan(1);

    const report = await workspace.validateProject('compat-future');
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.message).join(' ')).toMatch(/schema version 99/);

    // Opening it is refused too, with the same explanation, and the file is untouched.
    await expect(workspace.readProject('compat-future')).rejects.toThrow(/schema version 99/);

    const after = await readFile(join(workspaceRoot, 'future', PROJECT_FILES.game), 'utf8');
    expect(after).toBe(before);
  });

  it('reports duplicate ids and parent cycles in an invalid fixture and leaves it alone', async () => {
    await install('compat-invalid', 'invalid');
    const path = join(workspaceRoot, 'invalid', 'scenes', 'main.scene.json');
    const before = await readFile(path, 'utf8');

    const report = await workspace.validateProject('compat-invalid');
    const codes = report.issues.map((issue) => issue.code);
    expect(report.ok).toBe(false);
    expect(codes).toContain('duplicate-entity-id');
    expect(codes).toContain('parent-cycle');
    expect(await readFile(path, 'utf8')).toBe(before);

    // The same document is refused by the write path rather than being persisted.
    const scene = JSON.parse(before) as unknown;
    await expect(workspace.writeScene('compat-invalid', 'main', scene, { expectedRevision: 0 })).rejects.toThrow(
      /refusing to write an invalid scene document/,
    );
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});

describe('recovery', () => {
  it('keeps a bounded recovery copy of every replaced document', async () => {
    await install('compat-current', 'current');
    for (let index = 0; index < 4; index += 1) {
      const scene = await workspace.readScene('compat-current', 'main');
      scene.entities[0]!.transform.position = [index, -0.25, 0];
      await workspace.writeScene('compat-current', 'main', scene, { expectedRevision: scene.revision });
    }
    const recovery = join(workspaceRoot, 'current', PROJECT_FILES.internal, 'recovery');
    const copies = await readdir(recovery);
    expect(copies.length).toBeGreaterThan(0);
    for (const name of copies) {
      const parsed = parseScene(JSON.parse(await readFile(join(recovery, name), 'utf8')));
      expect(parsed.ok).toBe(true);
    }
  });

  it('an interrupted save leaves the previous document intact and no temporary file behind', async () => {
    await install('compat-current', 'current');
    const path = join(workspaceRoot, 'current', 'scenes', 'main.scene.json');
    const before = await readFile(path, 'utf8');

    // Simulate an interruption: a temp file is written but never renamed into place.
    await writeFile(`${path}.tmp-999-abc`, '{ "half written":', 'utf8');
    expect(await readFile(path, 'utf8')).toBe(before);

    // The next successful write cleans up after itself.
    const scene = await workspace.readScene('compat-current', 'main');
    await workspace.writeScene('compat-current', 'main', scene, { expectedRevision: scene.revision });
    const entries = await readdir(join(workspaceRoot, 'current', 'scenes'));
    expect(entries.filter((name) => name.includes('.tmp-'))).toHaveLength(1); // only the simulated one
    expect(parseScene(JSON.parse(await readFile(path, 'utf8'))).ok).toBe(true);

    // The half-written temp file is not picked up as a scene: the manifest lists scene paths.
    const project = await workspace.readProject('compat-current');
    expect(project.scenes.map((entry) => entry.path)).toEqual(['scenes/main.scene.json']);
  });

  it('writing atomically never exposes a partial document', async () => {
    const path = join(workspaceRoot, 'atomic.json');
    const payloads = Array.from({ length: 20 }, (_, index) => JSON.stringify({ index }));
    await Promise.all(payloads.map((payload) => writeFileAtomic(path, payload)));
    const final = JSON.parse(await readFile(path, 'utf8')) as { index: number };
    expect(Number.isInteger(final.index)).toBe(true);
    const leftovers = (await readdir(workspaceRoot)).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('reports a manifest that no longer parses instead of guessing', async () => {
    await install('compat-current', 'current');
    await writeFile(join(workspaceRoot, 'current', PROJECT_FILES.game), '{ not json', 'utf8');
    await expect(workspace.readProject('compat-current')).rejects.toThrow(/not valid JSON/);
    expect(parseGame({}).ok).toBe(false);
  });

  it('refuses to write when the on-disk revision moved on', async () => {
    await install('compat-current', 'current');
    const scene = await workspace.readScene('compat-current', 'main');
    scene.entities[0]!.name = 'First writer';
    await workspace.writeScene('compat-current', 'main', scene, { expectedRevision: scene.revision });

    const stale = structuredClone(scene);
    stale.entities[0]!.name = 'Second writer';
    await expect(workspace.writeScene('compat-current', 'main', stale, { expectedRevision: scene.revision })).rejects.toThrow(
      /revision 4, not 3/,
    );
    expect((await workspace.readScene('compat-current', 'main')).entities[0]!.name).toBe('First writer');
  });

  it('keeps the workspace usable when a project folder is not a project at all', async () => {
    await install('compat-current', 'current');
    await cp(join(fixtures, 'compat-current'), join(workspaceRoot, 'not-a-project'), { recursive: true });
    await rm(join(workspaceRoot, 'not-a-project', PROJECT_FILES.game));
    const projects = await workspace.listProjects();
    expect(projects.map((project) => project.id)).toEqual(['compat-current']);
    expect(existsSync(join(workspaceRoot, 'not-a-project'))).toBe(true);
  });
});
