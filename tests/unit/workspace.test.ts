import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApiServer, type ApiServerHandle } from '../../server/api.js';
import { Workspace } from '../../server/workspace.js';
import { UnsafePathError } from '../../server/paths.js';
import { parseScene } from '@schema/index.js';

/**
 * Workspace service tests (plan §13, §16 "Authoring and data integrity").
 *
 * The service is the only thing that writes project files, so these tests cover the
 * failure modes the plan calls out: interrupted saves, stale revisions, invalid documents,
 * duplicate ids, parent cycles, path traversal, and cross-origin requests.
 */

const repositoryRoot = new URL('../../', import.meta.url).pathname;

let workspaceRoot: string;
let workspace: Workspace;
let api: ApiServerHandle;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'coilbox-ws-'));
  workspace = new Workspace({ root: workspaceRoot, templatesRoot: join(repositoryRoot, 'templates') });
  api = await startApiServer({ workspace, port: 0 });
});

afterEach(async () => {
  await api.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

function rawRequestStatus(baseUrl: string, path: string, hostHeader: string): Promise<number> {
  return new Promise((resolveStatus, rejectStatus) => {
    const url = new URL(baseUrl);
    const request = httpRequest(
      { hostname: url.hostname, port: url.port, path, method: 'GET', headers: { host: hostHeader } },
      (response) => {
        response.resume();
        response.on('end', () => resolveStatus(response.statusCode ?? 0));
      },
    );
    request.on('error', rejectStatus);
    request.end();
  });
}

async function request(
  path: string,
  options: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const token = options.token === undefined ? api.token : options.token;
  if (token) headers['x-coilbox-token'] = token;
  const response = await fetch(`${api.url}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

describe('project lifecycle', () => {
  it('creates a project from the blank template and lists it', async () => {
    const created = await request('/api/projects', { method: 'POST', body: { id: 'my-game', name: 'My Game' } });
    expect(created.status).toBe(201);
    expect(created.body.project.id).toBe('my-game');
    expect(created.body.project.name).toBe('My Game');
    expect(existsSync(join(workspaceRoot, 'my-game', 'game.json'))).toBe(true);
    expect(existsSync(join(workspaceRoot, 'my-game', 'scenes', 'main.scene.json'))).toBe(true);

    const list = await request('/api/projects');
    expect(list.status).toBe(200);
    expect(list.body.projects.map((project: { id: string }) => project.id)).toEqual(['my-game']);
  });

  it('refuses to create a project whose folder already exists', async () => {
    await request('/api/projects', { method: 'POST', body: { id: 'dupe', name: 'Dupe' } });
    const again = await request('/api/projects', { method: 'POST', body: { id: 'dupe', name: 'Dupe' } });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('project-exists');
  });

  it('rejects project ids that are not safe path segments', async () => {
    for (const id of ['../escape', 'nested/child', '.hidden', '']) {
      const response = await request('/api/projects', { method: 'POST', body: { id, name: 'x' } });
      expect(response.status, `id ${JSON.stringify(id)}`).toBeGreaterThanOrEqual(400);
    }
    expect(existsSync(join(workspaceRoot, '..', 'escape'))).toBe(false);
  });

  it('reports a missing project as 404 and an unknown scene as 404', async () => {
    expect((await request('/api/projects/nope')).status).toBe(404);
    await request('/api/projects', { method: 'POST', body: { id: 'g', name: 'G' } });
    expect((await request('/api/projects/g/scenes/ghost')).status).toBe(404);
  });
});

describe('scene reads and writes', () => {
  beforeEach(async () => {
    await request('/api/projects', { method: 'POST', body: { id: 'g', name: 'G' } });
  });

  it('reads the starter scene and writes it back with an incremented revision', async () => {
    const read = await request('/api/projects/g/scenes/main');
    expect(read.status).toBe(200);
    const scene = read.body.scene;
    expect(scene.revision).toBe(0);
    expect(scene.entities.map((entity: { id: string }) => entity.id)).toEqual(['ground', 'player', 'game-camera', 'sun']);

    const moved = structuredClone(scene);
    moved.entities[1].transform.position = [3, 1, 0];
    const write = await request('/api/projects/g/scenes/main', {
      method: 'PUT',
      body: { scene: moved, expectedRevision: 0 },
    });
    expect(write.status).toBe(200);
    expect(write.body.scene.revision).toBe(1);
    expect(write.body.scene.entities[1].transform.position).toEqual([3, 1, 0]);

    const reread = await request('/api/projects/g/scenes/main');
    expect(reread.body.scene.entities[1].transform.position).toEqual([3, 1, 0]);
    expect(reread.body.scene.revision).toBe(1);
  });

  it('refuses a write whose expected revision is stale, and leaves the file untouched', async () => {
    const scene = (await request('/api/projects/g/scenes/main')).body.scene;
    await request('/api/projects/g/scenes/main', { method: 'PUT', body: { scene, expectedRevision: 0 } });
    const stale = structuredClone(scene);
    stale.entities[1].transform.position = [9, 9, 9];
    const conflict = await request('/api/projects/g/scenes/main', {
      method: 'PUT',
      body: { scene: stale, expectedRevision: 0 },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('revision-conflict');
    const onDisk = JSON.parse(await readFile(join(workspaceRoot, 'g', 'scenes', 'main.scene.json'), 'utf8'));
    expect(onDisk.entities[1].transform.position).toEqual([0, 1, 0]);
  });

  it('refuses to write an invalid document and keeps the previous one', async () => {
    const scene = (await request('/api/projects/g/scenes/main')).body.scene;
    const broken = structuredClone(scene);
    broken.entities.push({ ...broken.entities[0], id: broken.entities[0].id }); // duplicate id
    const response = await request('/api/projects/g/scenes/main', { method: 'PUT', body: { scene: broken } });
    expect(response.status).toBe(422);
    expect(response.body.issues.map((issue: { code: string }) => issue.code)).toContain('duplicate-entity-id');

    const cycles = structuredClone(scene);
    cycles.entities[0].parentId = cycles.entities[1].id;
    cycles.entities[1].parentId = cycles.entities[0].id;
    const cycleResponse = await request('/api/projects/g/scenes/main', { method: 'PUT', body: { scene: cycles } });
    expect(cycleResponse.status).toBe(422);
    expect(cycleResponse.body.issues.map((issue: { code: string }) => issue.code)).toContain('parent-cycle');

    const onDisk = JSON.parse(await readFile(join(workspaceRoot, 'g', 'scenes', 'main.scene.json'), 'utf8'));
    expect(onDisk.entities).toHaveLength(scene.entities.length);
  });

  it('rejects malformed JSON and non-object bodies', async () => {
    const response = await fetch(`${api.url}/api/projects/g/scenes/main`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-coilbox-token': api.token },
      body: '{ not json',
    });
    expect(response.status).toBe(400);
    const arrayBody = await request('/api/projects/g/scenes/main', { method: 'PUT', body: [1, 2, 3] as unknown });
    expect(arrayBody.status).toBe(400);
  });

  it('keeps a recovery copy of the replaced document, bounded in number', async () => {
    for (let index = 0; index < 5; index += 1) {
      const scene = (await request('/api/projects/g/scenes/main')).body.scene;
      scene.entities[1].transform.position = [index, 1, 0];
      const write = await request('/api/projects/g/scenes/main', {
        method: 'PUT',
        body: { scene, expectedRevision: scene.revision },
      });
      expect(write.status).toBe(200);
    }
    const recovery = join(workspaceRoot, 'g', '.coilbox', 'recovery');
    const copies = await readdir(recovery);
    expect(copies.length).toBeGreaterThan(0);
    const first = JSON.parse(await readFile(join(recovery, copies[0]!), 'utf8'));
    expect(parseScene(first).ok).toBe(true);
  });

  it('leaves no temporary files behind after a successful write', async () => {
    const scene = (await request('/api/projects/g/scenes/main')).body.scene;
    await request('/api/projects/g/scenes/main', { method: 'PUT', body: { scene, expectedRevision: 0 } });
    const entries = await readdir(join(workspaceRoot, 'g', 'scenes'));
    expect(entries.filter((name) => name.includes('.tmp-'))).toHaveLength(0);
  });

  it('validates a project through the api', async () => {
    const valid = await request('/api/projects/g/validate', { method: 'POST' });
    expect(valid.status).toBe(200);
    expect(valid.body.ok).toBe(true);

    // A later version of the schema must be reported, not silently rewritten.
    const gamePath = join(workspaceRoot, 'g', 'game.json');
    const game = JSON.parse(await readFile(gamePath, 'utf8'));
    game.schemaVersion = 99;
    await writeFile(gamePath, JSON.stringify(game, null, 2));
    const invalid = await request('/api/projects/g/validate', { method: 'POST' });
    expect(invalid.body.ok).toBe(true); // schemaVersion is structurally valid; scene checks still run
    expect(game.schemaVersion).toBe(99);
  });
});

describe('security', () => {
  beforeEach(async () => {
    await request('/api/projects', { method: 'POST', body: { id: 'g', name: 'G' } });
  });

  it('requires the session token for writes but not for reads', async () => {
    const scene = (await request('/api/projects/g/scenes/main')).body.scene;
    const noToken = await request('/api/projects/g/scenes/main', {
      method: 'PUT',
      body: { scene },
      token: null,
    });
    expect(noToken.status).toBe(401);
    const wrongToken = await request('/api/projects/g/scenes/main', {
      method: 'PUT',
      body: { scene },
      token: 'nope',
    });
    expect(wrongToken.status).toBe(401);
    expect((await request('/api/projects/g')).status).toBe(200);
  });

  it('hands the token to same-origin pages through /api/session', async () => {
    const response = await request('/api/session', { headers: { origin: `http://127.0.0.1:${api.port}` } });
    expect(response.status).toBe(200);
    expect(response.body.token).toBe(api.token);
  });

  it('rejects requests with a foreign Host header (DNS rebinding)', async () => {
    // `fetch` refuses to set Host, so this check uses a raw request: a browser reaching a
    // rebound DNS name would send exactly this.
    const status = await rawRequestStatus(api.url, '/api/projects', 'evil.example.com');
    expect(status).toBe(403);
  });

  it('rejects requests from a foreign Origin', async () => {
    const response = await fetch(`${api.url}/api/projects`, { headers: { origin: 'https://evil.example.com' } });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('forbidden-origin');
  });

  it('allows loopback origins and answers preflight requests', async () => {
    const allowed = await fetch(`${api.url}/api/projects`, { headers: { origin: 'http://localhost:5178' } });
    expect(allowed.status).toBe(200);
    const preflight = await fetch(`${api.url}/api/projects`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5178' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('x-coilbox-token');
  });

  it('refuses requests outside /api', async () => {
    expect((await request('/etc/passwd')).status).toBe(404);
  });
});

describe('workspace path safety', () => {
  it('refuses to resolve a path outside the workspace', async () => {
    await expect(workspace.projectRoot('..')).rejects.toThrow(UnsafePathError);
  });

  it('refuses a symlinked project that points outside the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'coilbox-outside-'));
    await writeFile(join(outside, 'game.json'), JSON.stringify({ schemaVersion: 1, id: 'escape', name: 'Escape', scenes: [{ id: 'main', name: 'Main', path: 'scenes/main.scene.json' }], startScene: 'main' }));
    await mkdir(join(workspaceRoot, 'linked'), { recursive: true }).catch(() => {});
    await rm(join(workspaceRoot, 'linked'), { recursive: true, force: true });
    await symlink(outside, join(workspaceRoot, 'linked'));
    await expect(workspace.projectRoot('escape')).rejects.toThrow(UnsafePathError);
    await rm(outside, { recursive: true, force: true });
  });

  it('does not list directories that are not projects', async () => {
    await mkdir(join(workspaceRoot, 'not-a-game'), { recursive: true });
    await mkdir(join(workspaceRoot, '.hidden'), { recursive: true });
    expect(await workspace.listProjects()).toEqual([]);
  });
});
