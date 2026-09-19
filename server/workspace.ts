import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BehaviorPropertyType } from '@runtime/behaviors/types.js';
import {
  formatIssues,
  parseAssetManifest,
  parseGame,
  parseScene,
  type AssetManifest,
  type GameDocument,
  type JsonValue,
  type SceneDocument,
  type ValidationIssue,
} from '@schema/index.js';
import { assertProjectRelative, assertSafeSegment, resolveInside, UnsafePathError } from './paths.js';
import { jsonArray, jsonField, jsonNumber, jsonString, parseJson } from './json.js';

/**
 * Project storage for the workspace service (plan §7, §13).
 *
 * Each game is an ordinary folder. The service owns project discovery, validated reads and
 * writes, atomic saves with a recovery copy, and revision checks so that two editor tabs —
 * or an agent editing files — cannot silently replace newer content.
 */

export const PROJECT_FILES = {
  game: 'game.json',
  assetManifest: 'assets/manifest.json',
  behaviorRegistry: 'scripts/registry.json',
  thumbnail: 'thumbnail.png',
  readme: 'README.md',
  /** Recovery copies and caches live here and are excluded from source exports. */
  internal: '.coilbox',
} as const;

export interface ProjectSummary {
  id: string;
  name: string;
  /** Project-relative directory name inside the workspace. */
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

/**
 * `scripts/registry.json`: the declarative behavior metadata the inspector renders from and the
 * validator checks against. Entries stay unparsed here — `behaviorValidationContext` reads the
 * fields it checks one by one rather than trusting the document because it parsed.
 */
export interface BehaviorRegistryDocument {
  schemaVersion: number;
  behaviors: JsonValue[];
  /**
   * Editor panel declarations, passed through unread.
   *
   * Optional, and omitted entirely when the file has none, so a project written before panels existed
   * produces exactly the response it always did.
   */
  panels?: JsonValue;
}

export class WorkspaceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues: ValidationIssue[];

  constructor(code: string, message: string, status = 400, issues: ValidationIssue[] = []) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

export interface WorkspaceOptions {
  /** Directory scanned for projects. */
  root: string;
  /** Directory holding whole-project starter copies. */
  templatesRoot?: string;
  /** How many recovery copies to keep per document. */
  recoveryLimit?: number;
  /** Files/directories that are copies, caches, or build output. */
  ignoreDirectories?: string[];
}

export class Workspace {
  readonly root: string;
  readonly templatesRoot: string | null;
  private readonly recoveryLimit: number;
  private readonly ignoreDirectories: Set<string>;

  constructor(options: WorkspaceOptions) {
    this.root = options.root;
    this.templatesRoot = options.templatesRoot ?? null;
    this.recoveryLimit = options.recoveryLimit ?? 20;
    this.ignoreDirectories = new Set(
      options.ignoreDirectories ?? ['node_modules', 'dist', '.coilbox', '.git', '.cache', 'dist-export'],
    );
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /** Every valid project folder in the workspace, newest first. */
  async listProjects(): Promise<ProjectSummary[]> {
    await this.ensureRoot();
    const entries = await readdir(this.root, { withFileTypes: true });
    const summaries: ProjectSummary[] = [];
    for (const entry of entries) {
      // Symlinks are considered here on purpose: `resolveInside` then rejects any that
      // point outside the workspace, which is the check that actually matters.
      if (!isDirectoryLike(entry) || entry.name.startsWith('.') || this.ignoreDirectories.has(entry.name)) continue;
      const summary = await this.readSummary(entry.name).catch(() => null);
      if (summary) summaries.push(summary);
    }
    return summaries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  private async readSummary(directory: string): Promise<ProjectSummary | null> {
    const projectRoot = await resolveInside(this.root, [directory]);
    const gamePath = join(projectRoot, PROJECT_FILES.game);
    if (!existsSync(gamePath)) return null;
    const raw = await readJson(gamePath);
    const parsed = parseGame(raw);
    if (!parsed.value) {
      throw new WorkspaceError('invalid-project', `game.json in "${directory}" is not valid`, 422, parsed.issues);
    }
    const info = await stat(gamePath);
    return {
      id: parsed.value.id,
      name: parsed.value.name,
      directory,
      sceneCount: parsed.value.scenes.length,
      startScene: parsed.value.startScene,
      modifiedAt: info.mtime.toISOString(),
      hasThumbnail: existsSync(join(projectRoot, PROJECT_FILES.thumbnail)),
    };
  }

  async findProjectDirectory(projectId: string): Promise<string> {
    assertSafeSegment(projectId, 'project id');
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    let parseFailure: WorkspaceError | null = null;
    for (const entry of entries) {
      if (!isDirectoryLike(entry) || entry.name.startsWith('.')) continue;
      const gamePath = join(this.root, entry.name, PROJECT_FILES.game);
      if (!existsSync(gamePath)) continue;
      const raw = await readJson(gamePath).catch((cause: unknown) => {
        // Remember it: "game.json is not valid JSON" is a far more useful answer than
        // "project not found" when the folder is sitting right there.
        if (cause instanceof WorkspaceError && !parseFailure) parseFailure = cause;
        return null;
      });
      if (jsonString(raw, 'id') === projectId) return entry.name;
    }
    if (parseFailure) throw parseFailure;
    throw new WorkspaceError('project-not-found', `no project with id "${projectId}" in the workspace`, 404);
  }

  async projectRoot(projectId: string): Promise<string> {
    const directory = await this.findProjectDirectory(projectId);
    return resolveInside(this.root, [directory]);
  }

  async readProject(projectId: string): Promise<ProjectDetail> {
    const directory = await this.findProjectDirectory(projectId);
    const projectRoot = await resolveInside(this.root, [directory]);
    const raw = await readJson(join(projectRoot, PROJECT_FILES.game));
    const parsed = parseGame(raw);
    if (!parsed.value) {
      throw new WorkspaceError('invalid-project', 'game.json is not valid', 422, parsed.issues);
    }
    // A project from a newer build is refused here rather than opened and misread; the file is
    // left exactly as it was.
    if (!parsed.ok) {
      const first = parsed.issues.find((issue) => issue.severity === 'error');
      throw new WorkspaceError(first?.code ?? 'invalid-project', first?.message ?? 'the project cannot be opened', 422, parsed.issues);
    }
    const summary = await this.readSummary(directory);
    if (!summary) throw new WorkspaceError('project-not-found', `project "${projectId}" disappeared`, 404);
    return { ...summary, game: parsed.value, scenes: parsed.value.scenes };
  }

  async readScene(projectId: string, sceneId: string): Promise<SceneDocument> {
    assertSafeSegment(sceneId, 'scene id');
    const detail = await this.readProject(projectId);
    const projectRoot = await this.projectRoot(projectId);
    const entry = detail.game.scenes.find((scene) => scene.id === sceneId);
    if (!entry) {
      throw new WorkspaceError('scene-not-found', `project "${projectId}" has no scene "${sceneId}"`, 404);
    }
    const scenePath = await this.scenePath(projectRoot, entry.path);
    const raw = await readJson(scenePath).catch(() => {
      throw new WorkspaceError('scene-not-found', `scene file "${entry.path}" is missing`, 404);
    });
    const manifest = await this.readAssetManifest(projectRoot, detail.game);
    const registry = await this.readBehaviorRegistry(projectId);
    const parsed = parseScene(raw, {
      assetIds: new Set(manifest.assets.map((asset) => asset.id)),
      assetKinds: new Map(manifest.assets.map((asset) => [asset.id, asset.kind])),
      ...behaviorValidationContext(registry),
    });
    if (!parsed.value) {
      throw new WorkspaceError('invalid-scene', `scene "${sceneId}" is not valid`, 422, parsed.issues);
    }
    if (!parsed.ok) {
      // Refusing to load is the safe answer: the editor keeps whatever it already had, and the
      // file on disk is untouched.
      const first = parsed.issues.find((issue) => issue.severity === 'error');
      throw new WorkspaceError(first?.code ?? 'invalid-scene', first?.message ?? `scene "${sceneId}" cannot be loaded`, 422, parsed.issues);
    }
    return parsed.value;
  }

  /**
   * Read `scripts/registry.json`: the declarative behavior metadata the inspector renders from
   * and the validator checks against. Executable behavior code lives in the runtime bundle, not
   * here — editing a scene must never execute a behavior constructor (plan §10).
   */
  async readBehaviorRegistry(projectId: string): Promise<BehaviorRegistryDocument> {
    const detail = await this.readProject(projectId);
    const projectRoot = await this.projectRoot(projectId);
    const relativePath = assertProjectRelative(detail.game.behaviorRegistry);
    const path = join(projectRoot, relativePath);
    if (!existsSync(path)) return { schemaVersion: 1, behaviors: [] };
    const raw = await readJson(path).catch(() => null);
    const behaviors = jsonArray(raw, 'behaviors');
    if (behaviors === undefined) {
      throw new WorkspaceError('invalid-registry', `${relativePath} does not contain a behaviors array`, 422);
    }
    /**
     * `panels` is passed through unread, like the behaviors.
     *
     * The service's job is to hand the file over, not to interpret it: deciding which panel ids are
     * real is the editor's question, and it is the editor that knows the answer. Omitting the key
     * when the file has none keeps the response byte-identical to what it was before panels existed.
     */
    const panels = jsonField(raw, 'panels');
    return panels === undefined
      ? { schemaVersion: jsonNumber(raw, 'schemaVersion') ?? 1, behaviors }
      : { schemaVersion: jsonNumber(raw, 'schemaVersion') ?? 1, behaviors, panels };
  }

  async readAssetManifest(projectRoot: string, game: GameDocument): Promise<AssetManifest> {
    const relativePath = assertProjectRelative(game.assetManifest);
    const path = join(projectRoot, relativePath);
    if (!existsSync(path)) return { schemaVersion: 1, assets: [] };
    const raw = await readJson(path).catch(() => null);
    const parsed = parseAssetManifest(raw);
    if (!parsed.value) {
      throw new WorkspaceError('invalid-assets', 'assets/manifest.json is not valid', 422, parsed.issues);
    }
    return parsed.value;
  }

  private async scenePath(projectRoot: string, scenePath: string): Promise<string> {
    const relativePath = assertProjectRelative(scenePath);
    return resolveInside(projectRoot, relativePath.split('/'), { allowMissing: false });
  }

  /**
   * Write a scene document atomically with a revision check.
   *
   * - `expectedRevision` must match what is on disk, otherwise the write is refused with
   *   the current document so the editor can show a conflict instead of losing an edit.
   * - The new document is validated before anything touches the file.
   * - The write goes to a temporary file and is renamed into place, so an interrupted
   *   save leaves the previous valid document intact.
   * - The replaced document is copied into the recovery folder first.
   *
   * `scene` is whatever the caller holds — parsed JSON from a client, a document read back from
   * disk, or anything else the project format can express — because this method is the boundary:
   * `parseScene` below decides whether it is a document, and refuses to write when it is not.
   */
  async writeScene<Input extends JsonValue>(
    projectId: string,
    sceneId: string,
    scene: Input,
    options: { expectedRevision?: number; createRecovery?: boolean } = {},
  ): Promise<{ scene: SceneDocument; bytes: number }> {
    assertSafeSegment(sceneId, 'scene id');
    const detail = await this.readProject(projectId);
    const projectRoot = await this.projectRoot(projectId);
    const entry = detail.game.scenes.find((sceneEntry) => sceneEntry.id === sceneId);
    if (!entry) {
      throw new WorkspaceError('scene-not-found', `project "${projectId}" has no scene "${sceneId}"`, 404);
    }

    const manifest = await this.readAssetManifest(projectRoot, detail.game);
    const registry = await this.readBehaviorRegistry(projectId);
    const parsed = parseScene(scene, {
      assetIds: new Set(manifest.assets.map((asset) => asset.id)),
      assetKinds: new Map(manifest.assets.map((asset) => [asset.id, asset.kind])),
      ...behaviorValidationContext(registry),
    });
    if (!parsed.value || !parsed.ok) {
      throw new WorkspaceError('invalid-scene', 'refusing to write an invalid scene document', 422, parsed.issues);
    }

    const target = await this.scenePath(projectRoot, entry.path);
    const existing = existsSync(target) ? await readJson(target).catch(() => null) : null;
    const existingRevision = readRevision(existing);

    if (options.expectedRevision !== undefined && options.expectedRevision !== existingRevision) {
      throw new WorkspaceError(
        'revision-conflict',
        `scene "${sceneId}" on disk is at revision ${existingRevision}, not ${options.expectedRevision}`,
        409,
      );
    }

    const nextDocument: SceneDocument = { ...parsed.value, revision: existingRevision + 1 };
    const serialised = `${JSON.stringify(nextDocument, null, 2)}\n`;

    if (options.createRecovery !== false && existing !== null) {
      await this.writeRecoveryCopy(projectRoot, entry.path, existing);
    }
    await writeFileAtomic(target, serialised);
    return { scene: nextDocument, bytes: Buffer.byteLength(serialised) };
  }

  private async writeRecoveryCopy(projectRoot: string, scenePath: string, document: JsonValue): Promise<void> {
    const folder = join(projectRoot, PROJECT_FILES.internal, 'recovery');
    await mkdir(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = scenePath.split('/').join('__');
    await writeFile(join(folder, `${stamp}__${safeName}`), `${JSON.stringify(document, null, 2)}\n`, 'utf8');

    const entries = (await readdir(folder)).filter((name) => name.endsWith(safeName)).sort();
    while (entries.length > this.recoveryLimit) {
      const oldest = entries.shift();
      if (oldest) await rm(join(folder, oldest), { force: true });
    }
  }

  /** Validate a project on disk without changing anything. */
  async validateProject(projectId: string): Promise<{ ok: boolean; issues: ValidationIssue[] }> {
    const issues: ValidationIssue[] = [];
    let detail: ProjectDetail;
    try {
      detail = await this.readProject(projectId);
    } catch (error) {
      if (error instanceof WorkspaceError) return { ok: false, issues: error.issues.length > 0 ? error.issues : [toIssue(error)] };
      throw error;
    }
    const projectRoot = await this.projectRoot(projectId);
    const manifest = await this.readAssetManifest(projectRoot, detail.game);
    const registry = await this.readBehaviorRegistry(projectId);
    const context = {
      assetIds: new Set(manifest.assets.map((asset) => asset.id)),
      assetKinds: new Map(manifest.assets.map((asset) => [asset.id, asset.kind])),
      ...behaviorValidationContext(registry),
    };
    for (const sceneEntry of detail.game.scenes) {
      try {
        const scene = await this.readScene(projectId, sceneEntry.id);
        const parsed = parseScene(scene, context);
        issues.push(...parsed.issues);
      } catch (error) {
        if (error instanceof WorkspaceError) {
          issues.push(...(error.issues.length > 0 ? error.issues : [toIssue(error, sceneEntry.path)]));
          continue;
        }
        throw error;
      }
    }
    return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
  }

  /**
   * Create a project folder from a template (plan §11, §15 stage 1).
   * Templates are whole-project copies, not linked prefabs.
   */
  async createProject(input: { id: string; name: string; template?: string }): Promise<ProjectDetail> {
    const directory = assertSafeSegment(input.id, 'project id');
    await this.ensureRoot();
    const target = join(this.root, directory);
    if (existsSync(target)) {
      throw new WorkspaceError('project-exists', `a folder named "${directory}" already exists`, 409);
    }

    const template = input.template ?? 'blank';
    assertSafeSegment(template, 'template id');
    if (!this.templatesRoot) {
      throw new WorkspaceError('no-templates', 'this workspace has no templates directory configured', 500);
    }
    const templatePath = join(this.templatesRoot, template);
    if (!existsSync(join(templatePath, PROJECT_FILES.game))) {
      throw new WorkspaceError('template-not-found', `template "${template}" does not exist`, 404);
    }

    await cp(templatePath, target, { recursive: true });
    // The folder name is the project's identity on disk; the documents carry the display
    // name and id, which are written here so a renamed folder cannot desynchronise them.
    const gamePath = join(target, PROJECT_FILES.game);
    const raw = await readJson(gamePath);
    const parsed = parseGame(raw);
    if (!parsed.value) {
      await rm(target, { recursive: true, force: true });
      throw new WorkspaceError('invalid-template', `template "${template}" has an invalid game.json`, 500, parsed.issues);
    }
    const game: GameDocument = { ...parsed.value, id: input.id, name: input.name };
    await writeFileAtomic(gamePath, `${JSON.stringify(game, null, 2)}\n`);

    const summary = await this.readSummary(directory);
    if (!summary) throw new WorkspaceError('create-failed', 'project was created but could not be read back', 500);
    return { ...summary, game, scenes: game.scenes };
  }

  /** Rename a project's display name. The folder and id are identity and do not move. */
  async renameProject(projectId: string, name: string): Promise<ProjectDetail> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      throw new WorkspaceError('invalid-name', 'a project name must be 1-200 characters', 422);
    }
    const projectRoot = await this.projectRoot(projectId);
    const gamePath = join(projectRoot, PROJECT_FILES.game);
    const parsed = parseGame(JSON.parse(await readFile(gamePath, 'utf8')));
    if (!parsed.value) {
      throw new WorkspaceError('invalid-project', 'game.json is not valid', 422, parsed.issues);
    }
    await writeFileAtomic(gamePath, `${JSON.stringify({ ...parsed.value, name: trimmed }, null, 2)}\n`);
    return this.readProject(projectId);
  }

  /** Store a project thumbnail (PNG bytes captured from the editor viewport). */
  async writeThumbnail(projectId: string, bytes: Uint8Array): Promise<number> {
    if (bytes.byteLength === 0) throw new WorkspaceError('empty-file', 'the thumbnail is empty', 422);
    if (bytes.byteLength > 4 * 1024 * 1024) {
      throw new WorkspaceError('file-too-large', 'thumbnails are limited to 4 MiB', 413);
    }
    // A PNG signature check keeps the field honest: this file is served back to the browser.
    const signature = [0x89, 0x50, 0x4e, 0x47];
    if (!signature.every((byte, index) => bytes[index] === byte)) {
      throw new WorkspaceError('unsupported-format', 'thumbnails must be PNG images', 415);
    }
    const projectRoot = await this.projectRoot(projectId);
    // writeFileAtomic takes text elsewhere; a thumbnail is binary, so write it directly through
    // the same temp-then-rename dance.
    const target = join(projectRoot, PROJECT_FILES.thumbnail);
    const temporary = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);
    return bytes.byteLength;
  }

  async readThumbnail(projectId: string): Promise<string> {
    const projectRoot = await this.projectRoot(projectId);
    const path = join(projectRoot, PROJECT_FILES.thumbnail);
    if (!existsSync(path)) throw new WorkspaceError('thumbnail-not-found', 'this project has no thumbnail', 404);
    return path;
  }

  /** Directory names present in the workspace, used to keep generated ids unique. */
  async existingDirectories(): Promise<string[]> {
    await this.ensureRoot();
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries.filter((entry) => isDirectoryLike(entry)).map((entry) => entry.name);
  }
}

/** What the scene validator needs to know about a project's declared behaviors. */
export interface BehaviorValidationContext {
  behaviorIds: Set<string>;
  behaviorProperties: Map<string, Map<string, BehaviorPropertyType>>;
}

/**
 * Turn a project's declared behaviors into the context the scene validator needs, so
 * `studio validate` catches an unregistered behavior or a mistyped property instead of leaving it
 * for the runtime to discover.
 */
export function behaviorValidationContext(registry: BehaviorRegistryDocument): BehaviorValidationContext {
  const behaviorIds = new Set<string>();
  const behaviorProperties = new Map<string, Map<string, BehaviorPropertyType>>();
  for (const entry of registry.behaviors) {
    const id = jsonString(entry, 'id');
    if (id === undefined) continue;
    behaviorIds.add(id);
    const descriptors = new Map<string, BehaviorPropertyType>();
    for (const property of jsonArray(entry, 'properties') ?? []) {
      const key = jsonString(property, 'key');
      const type = jsonString(property, 'type');
      if (key !== undefined && isBehaviorPropertyType(type)) {
        descriptors.set(key, type);
      }
    }
    behaviorProperties.set(id, descriptors);
  }
  return { behaviorIds, behaviorProperties };
}

/** Per behavior id, the property keys the registry declares as `asset`. */
export function behaviorAssetProperties(context: BehaviorValidationContext): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const [behaviorId, descriptors] of context.behaviorProperties) {
    const keys = new Set<string>();
    for (const [key, type] of descriptors) if (type === 'asset') keys.add(key);
    if (keys.size > 0) result.set(behaviorId, keys);
  }
  return result;
}

function isBehaviorPropertyType(value: unknown): value is BehaviorPropertyType {
  return (
    value === 'number' || value === 'boolean' || value === 'text' || value === 'enum' || value === 'entity' || value === 'asset'
  );
}

function isDirectoryLike(entry: { isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  return entry.isDirectory() || entry.isSymbolicLink();
}

/** The revision a document on disk declares, or 0 when it declares none. */
function readRevision(document: JsonValue): number {
  return jsonNumber(document, 'revision') ?? 0;
}

async function readJson(path: string): Promise<JsonValue> {
  const text = await readFile(path, 'utf8');
  try {
    return parseJson(text);
  } catch (cause) {
    throw new WorkspaceError('invalid-json', `${basename(path)} is not valid JSON: ${String(cause)}`, 422);
  }
}

/** Write via a temporary file and rename, so an interrupted save cannot truncate a document. */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // A unique suffix per write: two writers (the editor and an agent, say) landing in the same
  // millisecond would otherwise share a temp path and clobber each other's rename.
  const temporary = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, path);
}

function toIssue(error: WorkspaceError, path = ''): ValidationIssue {
  return { code: error.code, path, message: error.message, severity: 'error' };
}

export { formatIssues, UnsafePathError };
