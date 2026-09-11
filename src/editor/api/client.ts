import type { AssetEntry, AssetManifest, GameDocument, JsonValue, SceneDocument, ValidationIssue } from '@schema/index.js';
import { isJsonObject, isJsonString, jsonField } from '../json-values.js';

/**
 * Browser client for the local workspace service (plan §13).
 *
 * The token is fetched once from `/api/session`, which the service only answers for
 * loopback Host and Origin headers. Reads are unauthenticated; writes carry the token.
 */

export interface ProjectSummary {
  id: string;
  name: string;
  directory: string;
  sceneCount: number;
  startScene: string;
  modifiedAt: string;
  hasThumbnail: boolean;
}

export interface ProjectDetail extends ProjectSummary {
  game: GameDocument;
  scenes: Array<{ id: string; name: string; path: string }>;
}

/** `scripts/registry.json` as the service returns it; the entries are unread JSON. */
export interface RegistryDocument {
  schemaVersion: number;
  behaviors: JsonValue[];
}

/** The error body the service sends with a failed request. */
interface ServiceError {
  code: string;
  message: string | null;
}

/** A validation issue as the service reports it, or null when the payload is not one. */
function readIssue(value: JsonValue): ValidationIssue | null {
  if (!isJsonObject(value)) return null;
  const code = jsonField(value, 'code');
  const path = jsonField(value, 'path');
  const message = jsonField(value, 'message');
  if (!isJsonString(code) || !isJsonString(path) || !isJsonString(message)) return null;
  return {
    code,
    path,
    message,
    severity: jsonField(value, 'severity') === 'warning' ? 'warning' : 'error',
  };
}

/** Every validation issue in a service payload; anything else reports no issues. */
function readIssues(value: JsonValue): ValidationIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: ValidationIssue[] = [];
  for (const candidate of value) {
    const issue = readIssue(candidate);
    if (issue) issues.push(issue);
  }
  return issues;
}

/** The error envelope of a failed response; absent fields fall back to the HTTP status text. */
function readServiceError(text: string, fallbackCode: string): ServiceError {
  if (text.length === 0) return { code: fallbackCode, message: null };
  const payload: JsonValue = JSON.parse(text);
  const code = jsonField(payload, 'error');
  const message = jsonField(payload, 'message');
  return {
    code: isJsonString(code) ? code : fallbackCode,
    message: isJsonString(message) ? message : null,
  };
}

export class WorkspaceClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ValidationIssue[];

  constructor(status: number, code: string, message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.name = 'WorkspaceClientError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }
}

export class WorkspaceClient {
  readonly baseUrl: string;
  private token: string | null = null;
  private tokenPromise: Promise<string> | null = null;

  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async sessionToken(): Promise<string> {
    if (this.token) return this.token;
    if (!this.tokenPromise) this.tokenPromise = this.fetchSessionToken();
    return this.tokenPromise;
  }

  private async fetchSessionToken(): Promise<string> {
    try {
      const payload = await this.request<{ token: string }>('/session', { method: 'GET' }, false);
      this.token = payload.token;
      return payload.token;
    } catch (cause) {
      // Do not remember a failed token request: the next write should try again.
      this.tokenPromise = null;
      throw cause;
    }
  }

  listProjects(): Promise<{ projects: ProjectSummary[] }> {
    return this.request('/projects', { method: 'GET' });
  }

  readProject(projectId: string): Promise<{ project: ProjectDetail }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}`, { method: 'GET' });
  }

  createProject(input: { id: string; name: string; template?: string }): Promise<{ project: ProjectDetail }> {
    return this.request('/projects', { method: 'POST', body: input });
  }

  readScene(projectId: string, sceneId: string): Promise<{ scene: SceneDocument }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}`, {
      method: 'GET',
    });
  }

  /** Write a scene. `expectedRevision` makes the write fail rather than clobber newer content. */
  writeScene(
    projectId: string,
    sceneId: string,
    scene: SceneDocument,
    expectedRevision: number,
  ): Promise<{ scene: SceneDocument; bytes: number }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}`, {
      method: 'PUT',
      body: { scene, expectedRevision },
    });
  }

  readRegistry(projectId: string): Promise<RegistryDocument> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/registry`, { method: 'GET' });
  }

  listAssets(projectId: string): Promise<{
    manifest: AssetManifest;
    usage: Record<string, Array<{ sceneId: string; entityId: string; entityName: string }>>;
  }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/assets`, { method: 'GET' });
  }

  /**
   * Import a file. The bytes go up as-is with the filename in the query string; the service
   * decides the kind from the extension and refuses unsupported formats with a reason.
   */
  async importAsset(
    projectId: string,
    file: { name: string; bytes: ArrayBuffer; type?: string },
    options: { assetId?: string; replaceAssetId?: string } = {},
  ): Promise<{ entry: AssetEntry; manifest: AssetManifest; replaced: boolean; warnings: string[] }> {
    const query = new URLSearchParams({ filename: file.name });
    if (options.assetId) query.set('assetId', options.assetId);
    if (options.replaceAssetId) query.set('replace', options.replaceAssetId);
    return this.request(`/projects/${encodeURIComponent(projectId)}/assets?${query.toString()}`, {
      method: 'POST',
      rawBody: file.bytes,
      contentType: file.type && file.type.length > 0 ? file.type : 'application/octet-stream',
    });
  }

  deleteAsset(projectId: string, assetId: string): Promise<{ manifest: AssetManifest; removed: AssetEntry }> {
    return this.request(
      `/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`,
      { method: 'DELETE' },
    );
  }

  renameProject(projectId: string, name: string): Promise<{ project: ProjectDetail }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: { name } });
  }

  async uploadThumbnail(projectId: string, bytes: Uint8Array): Promise<{ bytes: number }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/thumbnail`, {
      method: 'POST',
      // A copy of exactly the used bytes: `Uint8Array.buffer` is `ArrayBufferLike`, and the request
      // body must be an `ArrayBuffer` rather than a view that may sit inside a shared one.
      rawBody: bytes.slice().buffer,
      contentType: 'image/png',
    });
  }

  duplicateProject(
    projectId: string,
    options: { newId: string; newName?: string },
  ): Promise<{ projectId: string; directory: string; detail: string }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/duplicate`, {
      method: 'POST',
      body: { newId: options.newId, newName: options.newName },
    });
  }

  archiveProject(projectId: string, reason?: string): Promise<{ projectId: string; directory: string; detail: string }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/archive`, { method: 'POST', body: { reason } });
  }

  listArchives(): Promise<{ archives: Array<{ directory: string; projectId: string; archivedAt: string; reason: string }> }> {
    return this.request('/archives', { method: 'GET' });
  }

  restoreArchive(directory: string): Promise<{ projectId: string; directory: string; detail: string }> {
    return this.request(`/archives/${encodeURIComponent(directory)}/restore`, { method: 'POST', body: {} });
  }

  /** Source archive bytes; the caller decides whether to download or store them. */
  async exportSource(projectId: string): Promise<Uint8Array> {
    const response = await fetch(`${this.baseUrl}/projects/${encodeURIComponent(projectId)}/export-source`, {
      headers: { accept: 'application/gzip' },
    });
    if (!response.ok) {
      const failure = readServiceError(await response.text(), 'export-failed');
      throw new WorkspaceClientError(response.status, failure.code, failure.message ?? response.statusText);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  importSource(bytes: Uint8Array, projectId?: string): Promise<{ projectId: string; detail: string; warnings: string[] }> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request(`/projects/import${query}`, {
      method: 'POST',
      rawBody: bytes.slice().buffer,
      contentType: 'application/gzip',
    });
  }

  validateProject(projectId: string): Promise<{ ok: boolean; issues: ValidationIssue[] }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/validate`, { method: 'POST', body: {} });
  }

  private async request<T>(
    path: string,
    options: { method: string; body?: unknown; rawBody?: ArrayBuffer; contentType?: string },
    withToken = true,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    headers.accept = 'application/json';
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.rawBody !== undefined) headers['content-type'] = options.contentType ?? 'application/octet-stream';
    if (withToken && options.method !== 'GET') headers['x-coilbox-token'] = await this.sessionToken();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method,
        headers,
        body:
          options.rawBody !== undefined
            ? options.rawBody
            : options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
      });
    } catch (cause) {
      throw new WorkspaceClientError(0, 'network-error', `cannot reach the workspace service: ${String(cause)}`);
    }

    const text = await response.text();
    const parsed: JsonValue = text.length > 0 ? JSON.parse(text) : {};
    const payload = isJsonObject(parsed) ? parsed : {};
    if (!response.ok) {
      throw new WorkspaceClientError(
        response.status,
        String(payload.error ?? 'request-failed'),
        String(payload.message ?? response.statusText),
        readIssues(payload.issues),
      );
    }
    // SAFETY: `T` is the response contract the workspace service documents for this path, declared by
    // each caller (`ProjectDetail`, `SceneDocument`, the archives list, …). The service is the only
    // producer of these bodies, and every failure it reports has already been thrown above.
    return payload as T;
  }
}

export const workspaceClient = new WorkspaceClient();
