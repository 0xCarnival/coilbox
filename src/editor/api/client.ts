import type { AssetEntry, AssetManifest, GameDocument, SceneDocument, ValidationIssue } from '@schema/index.js';

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
    if (!this.tokenPromise) {
      this.tokenPromise = this.request<{ token: string }>('/session', { method: 'GET' }, false)
        .then((payload) => {
          this.token = payload.token;
          return payload.token;
        })
        .catch((error: unknown) => {
          this.tokenPromise = null;
          throw error;
        });
    }
    return this.tokenPromise;
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

  readRegistry(projectId: string): Promise<{ schemaVersion: number; behaviors: unknown[] }> {
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
      rawBody: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
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
      const text = await response.text();
      const payload = text.length > 0 ? (JSON.parse(text) as { error?: string; message?: string }) : {};
      throw new WorkspaceClientError(response.status, payload.error ?? 'export-failed', payload.message ?? response.statusText);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  importSource(bytes: Uint8Array, projectId?: string): Promise<{ projectId: string; detail: string; warnings: string[] }> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request(`/projects/import${query}`, {
      method: 'POST',
      rawBody: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
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
    const headers: Record<string, string> = { accept: 'application/json' };
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
    const payload = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      throw new WorkspaceClientError(
        response.status,
        String(payload.error ?? 'request-failed'),
        String(payload.message ?? response.statusText),
        Array.isArray(payload.issues) ? (payload.issues as ValidationIssue[]) : [],
      );
    }
    return payload as T;
  }
}

export const workspaceClient = new WorkspaceClient();
