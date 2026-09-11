import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { ENGINE_VERSION, parseGame, parseScene, type GameDocument, type JsonValue } from '@schema/index.js';
import { assertSafeArchivePath, createTarGz, readTarGz, type ArchiveEntry } from './archive.js';
import { PROJECT_FILES, Workspace, WorkspaceError } from './workspace.js';
import { assertSafeSegment, resolveInside } from './paths.js';
import { jsonNumber, jsonString, parseJson } from './json.js';

/**
 * Project management (plan §4, §11, §13): duplicate, archive, source export, and source import.
 *
 * Rules from the plan that this module enforces:
 * - Archiving moves a project to a recoverable location instead of deleting it.
 * - A source archive contains the manifest, scenes, scripts, assets, compatibility metadata, and
 *   a README — and excludes caches, credentials, temporary files, and build output.
 * - Import validates archive paths and size limits, checks schema compatibility, and never
 *   installs dependencies or executes project code.
 */

export interface ManagementResult {
  projectId: string;
  directory: string;
  detail: string;
}

/** Directories that are never part of a source archive. */
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'dist-export',
  '.coilbox',
  '.git',
  '.cache',
  '.generated',
]);

const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

export class ProjectManager {
  constructor(private readonly workspace: Workspace) {}

  /** Copy a project into a new folder with fresh ids for scenes referenced by path. */
  async duplicate(projectId: string, options: { newId: string; newName?: string }): Promise<ManagementResult> {
    const directory = assertSafeSegment(options.newId, 'project id');
    const sourceRoot = await this.workspace.projectRoot(projectId);
    await this.workspace.ensureRoot();
    const targetRoot = join(this.workspace.root, directory);
    if (existsSync(targetRoot)) {
      throw new WorkspaceError('project-exists', `a folder named "${directory}" already exists`, 409);
    }

    await cp(sourceRoot, targetRoot, {
      recursive: true,
      filter: (source) => {
        const segments = relative(sourceRoot, source).split(sep);
        return !segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment));
      },
    });

    const gamePath = join(targetRoot, PROJECT_FILES.game);
    const raw = parseJson(await readFile(gamePath, 'utf8'));
    const parsed = parseGame(raw);
    if (!parsed.value) {
      await rm(targetRoot, { recursive: true, force: true });
      throw new WorkspaceError('invalid-project', 'the project could not be duplicated: game.json is not valid', 422, parsed.issues);
    }
    const copy: GameDocument = {
      ...parsed.value,
      id: options.newId,
      name: options.newName ?? `${parsed.value.name} copy`,
    };
    await writeFile(gamePath, `${JSON.stringify(copy, null, 2)}\n`, 'utf8');

    return {
      projectId: options.newId,
      directory,
      detail: `duplicated "${projectId}" to "${options.newId}" (${copy.scenes.length} scene(s))`,
    };
  }

  /**
   * Move a project into the workspace's archive folder. Assets are kept, and the archive can be
   * listed and restored, so archiving is not deletion.
   */
  async archive(projectId: string, options: { reason?: string } = {}): Promise<ManagementResult> {
    const sourceRoot = await this.workspace.projectRoot(projectId);
    const archiveRoot = join(this.workspace.root, '.archive');
    await mkdir(archiveRoot, { recursive: true });
    // Keep the folder name to the same lowercase-safe shape every other path segment uses.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase();
    const target = join(archiveRoot, `${basename(sourceRoot)}-${stamp}`);
    await rename(sourceRoot, target);
    await writeFile(
      join(target, '.archived.json'),
      `${JSON.stringify({ projectId, archivedAt: new Date().toISOString(), reason: options.reason ?? '' }, null, 2)}\n`,
      'utf8',
    );
    return {
      // The bare archive name: `restore()` takes exactly this back.
      projectId,
      directory: basename(target),
      detail: `archived "${projectId}" to ${relative(this.workspace.root, target)}`,
    };
  }

  async listArchived(): Promise<Array<{ directory: string; projectId: string; archivedAt: string; reason: string }>> {
    const archiveRoot = join(this.workspace.root, '.archive');
    if (!existsSync(archiveRoot)) return [];
    const entries = await readdir(archiveRoot, { withFileTypes: true });
    const result: Array<{ directory: string; projectId: string; archivedAt: string; reason: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const marker = join(archiveRoot, entry.name, '.archived.json');
      if (!existsSync(marker)) continue;
      // The marker is read field by field: a hand-edited or truncated one falls back to the
      // directory name instead of putting a non-string into the listing.
      const payload = parseJson(await readFile(marker, 'utf8'));
      result.push({
        // Bare directory name so it can be handed straight back to `restore()`.
        directory: entry.name,
        projectId: jsonString(payload, 'projectId') ?? entry.name,
        archivedAt: jsonString(payload, 'archivedAt') ?? '',
        reason: jsonString(payload, 'reason') ?? '',
      });
    }
    return result.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }

  /** Restore an archived project into the workspace under its original id. */
  async restore(directory: string, options: { newId?: string } = {}): Promise<ManagementResult> {
    assertSafeSegment(directory, 'archive directory');
    const archiveRoot = join(this.workspace.root, '.archive');
    const sourceRoot = await resolveInside(archiveRoot, [directory]);
    if (!existsSync(join(sourceRoot, PROJECT_FILES.game))) {
      throw new WorkspaceError('archive-not-found', `no archived project in "${directory}"`, 404);
    }
    const game = parseGame(parseJson(await readFile(join(sourceRoot, PROJECT_FILES.game), 'utf8'))).value;
    const id = options.newId ?? game?.id ?? directory;
    assertSafeSegment(id, 'project id');
    const target = join(this.workspace.root, id);
    if (existsSync(target)) {
      throw new WorkspaceError('project-exists', `a folder named "${id}" already exists`, 409);
    }
    await rename(sourceRoot, target);
    await rm(join(target, '.archived.json'), { force: true });
    return { projectId: id, directory: id, detail: `restored "${id}" from the archive` };
  }

  /**
   * Export Project: a source archive containing the manifest, scenes, scripts, assets,
   * compatibility metadata, and a README. Caches and build output are excluded.
   */
  async exportSource(projectId: string): Promise<{ bytes: Uint8Array; entries: ArchiveEntry[]; detail: string }> {
    const projectRoot = await this.workspace.projectRoot(projectId);
    const files = await collectProjectFiles(projectRoot);
    if (files.length === 0) {
      throw new WorkspaceError('empty-project', `project "${projectId}" has no files to export`, 422);
    }
    const game = parseGame(parseJson(await readFile(join(projectRoot, PROJECT_FILES.game), 'utf8'))).value;
    const withBytes: ArchiveEntry[] = [];
    for (const path of files) {
      const archivePath = relative(projectRoot, path).split(sep).join('/');
      assertSafeArchivePath(archivePath);
      withBytes.push({ path: archivePath, bytes: new Uint8Array(await readFile(path)) });
    }
    withBytes.push({
      path: 'COMPATIBILITY.json',
      bytes: new TextEncoder().encode(
        `${JSON.stringify(
          {
            projectId,
            name: game?.name ?? projectId,
            schemaVersion: game?.schemaVersion ?? 1,
            engineVersion: game?.engineVersion ?? ENGINE_VERSION,
            engineCompat: game?.engineCompat ?? ENGINE_VERSION,
            exportedAt: new Date().toISOString(),
            note: 'Import requires the same or an older schemaVersion and a compatible engine version.',
          },
          null,
          2,
        )}\n`,
      ),
    });
    const bytes = createTarGz(withBytes);
    return {
      bytes,
      entries: withBytes,
      detail: `exported ${withBytes.length} files (${(bytes.byteLength / 1024).toFixed(0)} KiB)`,
    };
  }

  /**
   * Import Project from a source archive.
   *
   * Validation is deliberately paranoid: archive paths, sizes, the manifest, every scene, and the
   * compatibility metadata are checked before anything is written, and the destination folder is
   * created only after the whole archive validates. Nothing in the archive is executed.
   */
  async importSource(
    archiveBytes: Uint8Array,
    options: { projectId?: string; name?: string } = {},
  ): Promise<{ projectId: string; directory: string; detail: string; warnings: string[] }> {
    if (archiveBytes.byteLength > MAX_IMPORT_BYTES) {
      throw new WorkspaceError('archive-too-large', `archives are limited to ${MAX_IMPORT_BYTES / 1024 / 1024} MiB`, 413);
    }
    const entries = readTarGz(archiveBytes);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const gameEntry = byPath.get(PROJECT_FILES.game);
    if (!gameEntry) {
      throw new WorkspaceError('invalid-archive', 'the archive does not contain game.json at its root', 422);
    }

    const decoded = new TextDecoder();
    let rawGame: JsonValue;
    try {
      rawGame = parseJson(decoded.decode(gameEntry.bytes));
    } catch (cause) {
      throw new WorkspaceError('invalid-project', `game.json in the archive is not valid JSON: ${String(cause)}`, 422);
    }
    const game = parseGame(rawGame);
    if (!game.value) {
      throw new WorkspaceError('invalid-project', 'game.json in the archive is not a valid project manifest', 422, game.issues);
    }

    const warnings: string[] = [];
    const compatibility = byPath.get('COMPATIBILITY.json');
    if (compatibility) {
      const payload = parseJson(decoded.decode(compatibility.bytes));
      const schemaVersion = jsonNumber(payload, 'schemaVersion');
      if (schemaVersion !== undefined && schemaVersion > game.value.schemaVersion) {
        throw new WorkspaceError(
          'incompatible-schema',
          `the archive was written with schema version ${schemaVersion}, which this build cannot open (it supports ${game.value.schemaVersion})`,
          422,
        );
      }
      const engineCompat = jsonString(payload, 'engineCompat');
      if (engineCompat !== undefined && engineCompat !== '' && engineCompat !== ENGINE_VERSION) {
        warnings.push(
          `the archive was authored against engine ${engineCompat}; this build is ${ENGINE_VERSION} and will open it without rewriting the original file`,
        );
      }
    }

    // Every scene must parse and validate before anything is written.
    for (const sceneEntry of game.value.scenes) {
      const entry = byPath.get(sceneEntry.path);
      if (!entry) {
        throw new WorkspaceError('missing-scene', `the archive is missing ${sceneEntry.path}`, 422);
      }
      let rawScene: JsonValue;
      try {
        rawScene = parseJson(decoded.decode(entry.bytes));
      } catch (cause) {
        throw new WorkspaceError('invalid-scene', `${sceneEntry.path} is not valid JSON: ${String(cause)}`, 422);
      }
      const parsed = parseScene(rawScene);
      // `value` is present even when relationship validation fails, so both must be checked:
      // an imported project has to be one the runtime would actually load.
      if (!parsed.value || !parsed.ok) {
        throw new WorkspaceError('invalid-scene', `${sceneEntry.path} is not a valid scene document`, 422, parsed.issues);
      }
    }

    const manifestEntry = byPath.get(game.value.assetManifest);
    if (!manifestEntry) warnings.push(`${game.value.assetManifest} is missing; the project will start with no assets`);
    const registryEntry = byPath.get(game.value.behaviorRegistry);
    if (!registryEntry) warnings.push(`${game.value.behaviorRegistry} is missing; behavior properties will not be editable`);

    const id = assertSafeSegment(options.projectId ?? game.value.id, 'project id');
    await this.workspace.ensureRoot();
    const target = join(this.workspace.root, id);
    if (existsSync(target)) {
      throw new WorkspaceError('project-exists', `a folder named "${id}" already exists`, 409);
    }

    await mkdir(target, { recursive: true });
    try {
      for (const entry of entries) {
        if (entry.path === 'COMPATIBILITY.json') continue;
        const path = join(target, entry.path);
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, entry.bytes);
      }
      if (options.name && options.name !== game.value.name) {
        const updated: GameDocument = { ...game.value, id, name: options.name };
        await writeFile(join(target, PROJECT_FILES.game), `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
      } else if (id !== game.value.id) {
        const updated: GameDocument = { ...game.value, id };
        await writeFile(join(target, PROJECT_FILES.game), `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
      }
    } catch (cause) {
      await rm(target, { recursive: true, force: true });
      throw new WorkspaceError('import-failed', `importing failed and was rolled back: ${String(cause)}`, 500);
    }

    return {
      projectId: id,
      directory: id,
      detail: `imported "${id}" from a source archive (${entries.length} files)`,
      warnings,
    };
  }
}

/** Files that belong in a source archive, in a stable order. */
async function collectProjectFiles(projectRoot: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        await walk(path);
        continue;
      }
      if (entry.name.endsWith('.tmp') || entry.name.includes('.tmp-')) continue;
      files.push(path);
    }
  };
  await walk(projectRoot);
  return files.sort();
}
