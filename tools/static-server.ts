import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { extname, join, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * Minimal static file server used to verify exported games (plan §14).
 *
 * It exists so the export can be tested the way it will actually be served: over
 * HTTP/HTTPS from a nested path, with correct MIME types, and with no dev-server
 * fallbacks. Double-clicking `index.html` is explicitly not supported, so every check
 * goes through this server.
 */

const MIME_TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.glb', 'model/gltf-binary'],
  ['.gltf', 'model/gltf+json'],
  ['.bin', 'application/octet-stream'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.wav', 'audio/wav'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
]);

/** `server.address()` reports an `AddressInfo` for a TCP socket and a path string for a pipe. */
function isAddressInfo(address: AddressInfo | string | null): address is AddressInfo {
  return address !== null && typeof address !== 'string';
}

export interface RequestLogEntry {
  method: string;
  url: string;
  status: number;
  bytes: number;
  contentType: string | null;
}

export interface StaticServerHandle {
  /** Base URL including the nested path prefix, always ending in `/`. */
  url: string;
  port: number;
  requests: RequestLogEntry[];
  close(): Promise<void>;
}

export interface StaticServerOptions {
  /** Directory whose contents are served. */
  root: string;
  /** Nested path prefix, e.g. `/nested/coilbox/`. Defaults to `/`. */
  prefix?: string;
  /** Bind address; loopback by default (plan §13). */
  host?: string;
  port?: number;
  /** Suppress per-request logging. */
  quiet?: boolean;
  /**
   * Additional directories served from the same origin, e.g. `{ '/games/': '/path/to/games' }`.
   * Exported games and their project folders normally sit next to the player, so serving them
   * together keeps checks on a single origin.
   */
  mounts?: Record<string, string>;
  /**
   * Forward matching path prefixes to another origin, e.g. `{ '/api': 'http://127.0.0.1:5179' }`.
   * Used to serve a production editor build next to the workspace service in checks.
   */
  proxy?: Record<string, string>;
}

export async function startStaticServer(options: StaticServerOptions): Promise<StaticServerHandle> {
  const root = resolve(options.root);
  const host = options.host ?? '127.0.0.1';
  const prefix = normalizePrefix(options.prefix ?? '/');
  const requests: RequestLogEntry[] = [];

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response);
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/';
    const pathname = decodeURIComponent(url.split('?')[0] ?? '/');
    const log = (status: number, bytes: number, contentType: string | null) => {
      requests.push({ method: request.method ?? 'GET', url, status, bytes, contentType });
      if (!options.quiet && status >= 400) {
        process.stderr.write(`[static] ${status} ${url}\n`);
      }
    };

    const proxyTarget = matchProxy(pathname, options.proxy);
    if (proxyTarget) {
      await forward(request, response, proxyTarget, url, log);
      return;
    }

    let effectiveRoot = root;
    let relative: string | null = null;
    for (const [mountPrefix, mountRoot] of Object.entries(options.mounts ?? {})) {
      const normalized = normalizePrefix(mountPrefix);
      if (!pathname.startsWith(normalized)) continue;
      effectiveRoot = resolve(mountRoot);
      relative = pathname.slice(normalized.length);
      break;
    }
    if (relative === null) {
      if (!pathname.startsWith(prefix)) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
        log(404, 0, 'text/plain');
        return;
      }
      relative = pathname.slice(prefix.length);
    }
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';

    const target = resolve(join(effectiveRoot, relative));
    if (target !== effectiveRoot && !target.startsWith(effectiveRoot + sep)) {
      // Path traversal attempt: refuse rather than serve something outside the root.
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('forbidden');
      log(403, 0, 'text/plain');
      return;
    }

    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error('not a file');
      const extension = extname(target).toLowerCase();
      const contentType = MIME_TYPES.get(extension) ?? 'application/octet-stream';
      response.writeHead(200, {
        'content-type': contentType,
        'content-length': info.size,
        'cache-control': 'no-store',
      });
      const stream = createReadStream(target);
      stream.pipe(response);
      log(200, info.size, contentType);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      log(404, 0, 'text/plain');
    }
  }

  const port = await new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      if (!isAddressInfo(address)) {
        rejectPort(new Error('static server did not report a port'));
        return;
      }
      resolvePort(address.port);
    });
  });

  return {
    url: `http://${host}:${port}${prefix}`,
    port,
    requests,
    async close() {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}

function matchProxy(pathname: string, proxy: Record<string, string> | undefined): string | null {
  if (!proxy) return null;
  for (const [prefix, target] of Object.entries(proxy)) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return target;
  }
  return null;
}

async function forward(
  request: IncomingMessage,
  response: ServerResponse,
  target: string,
  url: string,
  log: (status: number, bytes: number, contentType: string | null) => void,
): Promise<void> {
  const body: Buffer[] = [];
  for await (const chunk of request) body.push(chunk as Buffer);
  const payload = Buffer.concat(body);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || Array.isArray(value)) continue;
    if (key !== 'host' && key !== 'content-length') headers[key] = value;
  }
  if (payload.length > 0) headers['content-length'] = String(payload.length);
  const upstream = await fetch(new URL(url, target), {
    method: request.method,
    headers,
    body: payload.length > 0 ? payload : undefined,
  });
  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';

  // Stream the body through instead of buffering it: an event stream never completes, so a
  // buffered proxy would hang both the stream and anything waiting on it.
  const isStream = contentType.includes('text/event-stream') || upstream.headers.get('transfer-encoding') === 'chunked';
  if (isStream || !upstream.body) {
    response.writeHead(upstream.status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      connection: isStream ? 'keep-alive' : 'close',
    });
    if (!upstream.body) {
      response.end();
      log(upstream.status, 0, contentType);
      return;
    }
    const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    stream.on('error', () => response.end());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
    log(upstream.status, 0, contentType);
    return;
  }

  const responseBody = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    'content-type': contentType,
    'content-length': responseBody.length,
    'cache-control': 'no-store',
  });
  response.end(responseBody);
  log(upstream.status, responseBody.length, contentType);
}

function normalizePrefix(prefix: string): string {
  let value = prefix.startsWith('/') ? prefix : `/${prefix}`;
  if (!value.endsWith('/')) value += '/';
  return value;
}
