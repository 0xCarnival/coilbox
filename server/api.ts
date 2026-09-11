import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Workspace, WorkspaceError } from './workspace.js';
import { buildGame } from './build.js';
import { AssetService } from './assets.js';
import { ProjectManager } from './management.js';
import { ProjectWatcher } from './watcher.js';
import { UnsafePathError } from './paths.js';

/**
 * Local workspace API (plan §13).
 *
 * Exposes only what the editor needs: project listing, validated reads and writes, and
 * validation. Security is deliberately boring and explicit:
 *
 * - binds to loopback by default;
 * - validates the `Host` header, which is what stops DNS rebinding from a web page;
 * - validates `Origin` when the browser sends one, allowing loopback origins only;
 * - requires a per-session token on every write;
 * - constrains every path to the selected workspace (see `paths.ts`);
 * - never accepts a shell command, a URL to fetch, or code to execute from the browser.
 */

export interface ApiServerOptions {
  workspace: Workspace;
  /** Stops the process after the given number of requests; used by tests. */
  host?: string;
  port?: number;
  /** Per-session write token; generated when omitted. */
  token?: string;
  /** Extra origins allowed in addition to loopback ones. */
  allowedOrigins?: string[];
  /** Maximum request body size in bytes. */
  maxBodyBytes?: number;
  logger?: (message: string) => void;
}

export interface RequestLogEntry {
  method: string;
  url: string;
  status: number;
  ms: number;
}

export interface ApiServerHandle {
  url: string;
  port: number;
  token: string;
  requests: RequestLogEntry[];
  close(): Promise<void>;
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export async function startApiServer(options: ApiServerOptions): Promise<ApiServerHandle> {
  const workspace = options.workspace;
  const host = options.host ?? '127.0.0.1';
  const token = options.token ?? randomBytes(24).toString('hex');
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;
  const logger = options.logger ?? (() => {});
  const requests: RequestLogEntry[] = [];
  const extraOrigins = new Set(options.allowedOrigins ?? []);
  const managers = new Map<string, ProjectManager>();
  const watchers = new Map<string, { watcher: ProjectWatcher; clients: Set<ServerResponse> }>();

  const managerFor = (): ProjectManager => {
    const existing = managers.get('singleton');
    if (existing) return existing;
    const created = new ProjectManager(workspace);
    managers.set('singleton', created);
    return created;
  };

  /**
   * Server-sent events for external file changes. One watcher per project, one stream per open
   * editor, and everything is torn down when the last client disconnects.
   */
  const subscribe = async (projectId: string, response: ServerResponse): Promise<void> => {
    let entry = watchers.get(projectId);
    if (!entry) {
      const clients = new Set<ServerResponse>();
      const watcher = new ProjectWatcher({
        workspace,
        projectId,
        onEvent: (event) => {
          const payload = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
          for (const client of clients) client.write(payload);
        },
      });
      await watcher.start();
      entry = { watcher, clients };
      watchers.set(projectId, entry);
    }
    entry.clients.add(response);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ projectId })}\n\n`);
    const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
    response.on('close', () => {
      clearInterval(keepAlive);
      const current = watchers.get(projectId);
      if (!current) return;
      current.clients.delete(response);
      if (current.clients.size === 0) {
        current.watcher.close();
        watchers.delete(projectId);
      }
    });
  };

  const server: Server = createServer((request, response) => {
    const started = Date.now();
    void handle(request, response).finally(() => {
      requests.push({
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        status: response.statusCode,
        ms: Date.now() - started,
      });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const security = checkRequestSecurity(request, host, extraOrigins);
      if (!security.ok) {
        sendJson(response, security.status, { error: security.code, message: security.message });
        return;
      }

      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments[0] !== 'api') {
        sendJson(response, 404, { error: 'not-found', message: `no route for ${url.pathname}` });
        return;
      }
      const route = segments.slice(1);

      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-origin': request.headers.origin ?? '*',
          'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
          'access-control-allow-headers': 'content-type,x-coilbox-token',
          'access-control-max-age': '600',
        });
        response.end();
        return;
      }

      // GET /api/projects/:id/events - server-sent events for external file changes
      if (route[0] === 'projects' && route[2] === 'events' && route.length === 3 && request.method === 'GET') {
        await subscribe(route[1] ?? '', response);
        return;
      }

      // GET /api/health
      if (route[0] === 'health' && route.length === 1 && request.method === 'GET') {
        sendJson(response, 200, { ok: true, workspaceRoot: workspace.root });
        return;
      }

      // GET /api/session -> the token the editor uses for writes. Reaching this endpoint
      // already required a loopback Host and Origin, so a foreign page cannot read it.
      if (route[0] === 'session' && route.length === 1 && request.method === 'GET') {
        sendJson(response, 200, { token, workspaceRoot: workspace.root });
        return;
      }

      const requiresToken = request.method !== 'GET';
      if (requiresToken) {
        const presented = request.headers['x-coilbox-token'];
        if (typeof presented !== 'string' || !timingSafeEqual(presented, token)) {
          sendJson(response, 401, { error: 'unauthorized', message: 'a valid session token is required for writes' });
          return;
        }
      }

      // POST /api/projects/import - import a source archive
      if (route[0] === 'projects' && route[1] === 'import' && route.length === 2 && request.method === 'POST') {
        const projectId = url.searchParams.get('projectId') ?? undefined;
        const name = url.searchParams.get('name') ?? undefined;
        const bytes = await readBinaryBody(request, maxBodyBytes);
        sendJson(response, 201, await managerFor().importSource(bytes, { projectId, name }));
        return;
      }

      // GET /api/archives - archived projects
      if (route[0] === 'archives' && route.length === 1 && request.method === 'GET') {
        sendJson(response, 200, { archives: await managerFor().listArchived() });
        return;
      }
      if (route[0] === 'archives' && route.length === 3 && route[2] === 'restore' && request.method === 'POST') {
        sendJson(response, 200, await managerFor().restore(route[1] ?? ''));
        return;
      }

      // GET /api/projects
      if (route[0] === 'projects' && route.length === 1) {
        if (request.method === 'GET') {
          sendJson(response, 200, { projects: await workspace.listProjects() });
          return;
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request, maxBodyBytes);
          const project = await workspace.createProject({
            id: String(body.id ?? ''),
            name: String(body.name ?? body.id ?? ''),
            template: body.template === undefined ? undefined : String(body.template),
          });
          sendJson(response, 201, { project });
          return;
        }
      }

      // /api/projects/:id[...]
      if (route[0] === 'projects' && route.length >= 2) {
        const projectId = route[1] ?? '';
        if (route.length === 2 && request.method === 'GET') {
          sendJson(response, 200, { project: await workspace.readProject(projectId) });
          return;
        }
        if (route.length === 2 && request.method === 'DELETE') {
          sendJson(response, 405, { error: 'method-not-allowed', message: 'archiving arrives with project management' });
          return;
        }
        // --- project management ------------------------------------------------
        if (route[2] === 'duplicate' && route.length === 3 && request.method === 'POST') {
          const body = await readJsonBody(request, maxBodyBytes);
          const result = await managerFor().duplicate(projectId, {
            newId: String(body.newId ?? `${projectId}-copy`),
            newName: body.newName === undefined ? undefined : String(body.newName),
          });
          sendJson(response, 201, result);
          return;
        }
        if (route[2] === 'archive' && route.length === 3 && request.method === 'POST') {
          const body = await readJsonBody(request, maxBodyBytes);
          sendJson(response, 200, await managerFor().archive(projectId, { reason: body.reason === undefined ? undefined : String(body.reason) }));
          return;
        }
        if (route[2] === 'export-source' && route.length === 3 && request.method === 'GET') {
          const exported = await managerFor().exportSource(projectId);
          response.writeHead(200, {
            'content-type': 'application/gzip',
            'content-length': exported.bytes.byteLength,
            'content-disposition': `attachment; filename="${projectId}-source.tar.gz"`,
            'cache-control': 'no-store',
          });
          response.end(exported.bytes);
          return;
        }

        if (route.length === 2 && request.method === 'PATCH') {
          const body = await readJsonBody(request, maxBodyBytes);
          sendJson(response, 200, { project: await workspace.renameProject(projectId, String(body.name ?? '')) });
          return;
        }
        if (route[2] === 'thumbnail' && route.length === 3) {
          if (request.method === 'POST') {
            const bytes = await readBinaryBody(request, maxBodyBytes);
            sendJson(response, 200, { bytes: await workspace.writeThumbnail(projectId, bytes) });
            return;
          }
          if (request.method === 'GET') {
            const path = await workspace.readThumbnail(projectId);
            const bytes = await readFile(path);
            response.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.byteLength, 'cache-control': 'no-store' });
            response.end(bytes);
            return;
          }
        }
        if (route[2] === 'registry' && route.length === 3 && request.method === 'GET') {
          sendJson(response, 200, await workspace.readBehaviorRegistry(projectId));
          return;
        }
        if (route[2] === 'validate' && route.length === 3 && request.method === 'POST') {
          sendJson(response, 200, await workspace.validateProject(projectId));
          return;
        }
        // --- assets ---------------------------------------------------------
        if (route[2] === 'assets' && route.length === 3) {
          const assets = new AssetService(workspace);
          if (request.method === 'GET') {
            const projectRoot = await workspace.projectRoot(projectId);
            const manifest = await assets.readManifest(projectRoot);
            sendJson(response, 200, { manifest, usage: await assets.usageIndex(projectId) });
            return;
          }
          if (request.method === 'POST') {
            const filename = url.searchParams.get('filename') ?? '';
            const kind = url.searchParams.get('kind');
            const replace = url.searchParams.get('replace');
            if (filename.length === 0) {
              throw new WorkspaceError('missing-filename', 'the filename query parameter is required', 400);
            }
            const bytes = await readBinaryBody(request, maxBodyBytes);
            const result = await assets.import({
              projectId,
              filename,
              bytes,
              kind: kind === 'model' || kind === 'image' || kind === 'audio' ? kind : undefined,
              replaceAssetId: replace ?? undefined,
            });
            sendJson(response, result.replaced ? 200 : 201, result);
            return;
          }
        }

        if (route[2] === 'assets' && route.length >= 4) {
          const assets = new AssetService(workspace);
          const assetId = route[3] ?? '';
          if (route.length === 4 && request.method === 'DELETE') {
            sendJson(response, 200, await assets.remove(projectId, assetId));
            return;
          }
          if (route.length === 5 && route[4] === 'content' && request.method === 'GET') {
            const { path, entry } = await assets.assetFilePath(projectId, assetId);
            const bytes = await readFile(path);
            response.writeHead(200, {
              'content-type': contentTypeFor(entry.path),
              'content-length': bytes.byteLength,
              'cache-control': 'no-store',
              etag: `"${entry.hash}"`,
            });
            response.end(bytes);
            return;
          }
        }

        // Export Game. The pipeline is fixed; the browser cannot pass arguments to it.
        if (route[2] === 'build' && route.length === 3 && request.method === 'POST') {
          const result = await buildGame({ workspace, projectId, log: (message) => logger(message) });
          sendJson(response, 200, {
            ok: result.ok,
            outDir: result.outDir,
            relativeOutDir: result.relativeOutDir,
            files: result.files.length,
            totalBytes: result.totalBytes,
          });
          return;
        }
        if (route[2] === 'scenes' && route.length === 4) {
          const sceneId = route[3] ?? '';
          if (request.method === 'GET') {
            sendJson(response, 200, { scene: await workspace.readScene(projectId, sceneId) });
            return;
          }
          if (request.method === 'PUT') {
            const body = await readJsonBody(request, maxBodyBytes);
            const expectedRevision =
              typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined;
            const written = await workspace.writeScene(projectId, sceneId, body.scene, { expectedRevision });
            sendJson(response, 200, written);
            return;
          }
        }
        // /api/projects/:id/validate, /api/projects/:id/scenes/:sceneId handled above.
      }

      sendJson(response, 404, { error: 'not-found', message: `no route for ${request.method} ${url.pathname}` });
    } catch (error) {
      handleError(response, error, logger);
    }
  }

  const port = await new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        rejectPort(new Error('api server did not report a port'));
        return;
      }
      resolvePort(address.port);
    });
  });

  logger(`workspace api listening on http://${host}:${port} (root: ${workspace.root})`);

  return {
    url: `http://${host}:${port}`,
    port,
    token,
    requests,
    async close() {
      // An open event stream keeps the connection alive, and `server.close()` waits for every
      // connection to end — so streams are ended first and any straggler is destroyed, otherwise
      // shutting the service down would hang while an editor tab is open.
      for (const entry of watchers.values()) {
        for (const client of entry.clients) client.end();
        entry.clients.clear();
        entry.watcher.close();
      }
      watchers.clear();
      server.closeAllConnections?.();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}

interface SecurityResult {
  ok: boolean;
  status: number;
  code: string;
  message: string;
}

function checkRequestSecurity(request: IncomingMessage, expectedHost: string, extraOrigins: Set<string>): SecurityResult {
  const hostHeader = request.headers.host ?? '';
  const hostname = hostHeader.replace(/:\d+$/, '');
  if (!LOOPBACK_HOSTNAMES.has(hostname) && hostname !== expectedHost) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden-host',
      message: `requests must address the workspace service on loopback, not "${hostHeader}"`,
    };
  }

  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
    if (!isAllowedOrigin(origin, extraOrigins)) {
      return {
        ok: false,
        status: 403,
        code: 'forbidden-origin',
        message: `origin "${origin}" is not allowed to talk to the workspace service`,
      };
    }
  }
  return { ok: true, status: 200, code: 'ok', message: '' };
}

export function isAllowedOrigin(origin: string, extraOrigins: Set<string> = new Set()): boolean {
  if (extraOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

async function readBinaryBody(request: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) {
      throw new WorkspaceError('body-too-large', `request body exceeds ${maxBytes} bytes`, 413);
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function contentTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.glb')) return 'model/gltf-binary';
  if (lower.endsWith('.gltf')) return 'model/gltf+json';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) {
      throw new WorkspaceError('body-too-large', `request body exceeds ${maxBytes} bytes`, 413);
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new WorkspaceError('invalid-body', 'the request body must be a JSON object', 400);
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    if (cause instanceof WorkspaceError) throw cause;
    throw new WorkspaceError('invalid-json', `request body is not valid JSON: ${String(cause)}`, 400);
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function handleError(response: ServerResponse, error: unknown, logger: (message: string) => void): void {
  if (error instanceof WorkspaceError) {
    sendJson(response, error.status, { error: error.code, message: error.message, issues: error.issues });
    return;
  }
  if (error instanceof UnsafePathError) {
    sendJson(response, 403, { error: 'unsafe-path', message: error.message });
    return;
  }
  logger(`unhandled api error: ${String(error)}`);
  sendJson(response, 500, { error: 'internal-error', message: String(error) });
}

/** Constant-time-ish comparison; the token is local and short-lived, this avoids the trivial case. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}
