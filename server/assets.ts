import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  parseAssetManifest,
  referencedAssetIdsOf,
  type AssetEntry,
  type AssetKind,
  type AssetManifest,
} from '@schema/index.js';
import {
  behaviorAssetProperties,
  PROJECT_FILES,
  Workspace,
  WorkspaceError,
  writeFileAtomic,
} from './workspace.js';
import { isJsonString, jsonArray, parseJson } from './json.js';

/**
 * Asset import and replacement (plan §9, §14).
 *
 * Rules this module enforces:
 * - Import self-contained files first; store immutable originals with a stable id and a
 *   content hash, so moving or renaming a file never breaks a scene reference.
 * - Support only a declared, tested subset. Anything else is refused with a message that
 *   says what to do instead; unsupported imports must not appear to succeed.
 * - Detect compression extensions a model requires and record them, so the runtime can
 *   report a useful error instead of failing deep inside a loader.
 * - Replacing an asset keeps its identity only through this explicit operation.
 */

export interface AssetKindSpec {
  kind: AssetKind;
  extensions: string[];
  mimeTypes: Record<string, string>;
  /** Files that users commonly try and that this version does not support. */
  rejectedExtensions: Record<string, string>;
}

export const ASSET_KINDS: AssetKindSpec[] = [
  {
    kind: 'model',
    extensions: ['.glb', '.gltf'],
    mimeTypes: { '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json' },
    rejectedExtensions: {
      '.fbx': 'FBX is not supported in this version. Export a self-contained .glb from your modelling tool instead.',
      '.blend': 'Blender files are not supported in this version. Export a .glb instead.',
      '.obj': 'OBJ is not supported in this version. Export a .glb instead.',
      '.dae': 'COLLADA is not supported in this version. Export a .glb instead.',
      '.gltf.zip': 'Zipped glTF is not supported. Import an unpacked .glb or a .gltf with its .bin and textures.',
    },
  },
  {
    kind: 'image',
    extensions: ['.png', '.jpg', '.jpeg', '.webp'],
    mimeTypes: { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' },
    rejectedExtensions: {
      '.psd': 'Photoshop files are not supported. Export a PNG or WebP instead.',
      '.tga': 'TGA is not supported. Export a PNG or WebP instead.',
      '.exr': 'EXR is not supported in this version. Export a PNG instead.',
      '.ktx2': 'Compressed KTX2 textures need a decoder this version does not bundle. Export a PNG or WebP instead.',
      '.svg': 'SVG is not supported as a texture. Export a PNG or WebP instead.',
    },
  },
  {
    kind: 'audio',
    extensions: ['.mp3', '.ogg', '.wav'],
    mimeTypes: { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' },
    rejectedExtensions: {
      '.m4a': 'M4A/AAC is not in the tested audio set for this version. Convert to .mp3 or .ogg.',
      '.flac': 'FLAC is not in the tested audio set for this version. Convert to .mp3 or .ogg.',
      '.aiff': 'AIFF is not in the tested audio set for this version. Convert to .mp3 or .ogg.',
    },
  },
];

export interface ImportAssetOptions {
  projectId: string;
  filename: string;
  bytes: Uint8Array;
  /** Overrides kind detection; normally inferred from the extension. */
  kind?: AssetKind;
  /** Asset id to reuse when replacing; omit to create a new asset. */
  assetId?: string;
  /** Explicit display name for the asset. */
  displayName?: string;
  /** Import into an existing asset id: replaces the original and keeps references. */
  replaceAssetId?: string;
}

export interface ImportAssetResult {
  entry: AssetEntry;
  manifest: AssetManifest;
  replaced: boolean;
  warnings: string[];
}

const MAX_ASSET_BYTES = 64 * 1024 * 1024;

export class AssetService {
  constructor(private readonly workspace: Workspace) {}

  static specFor(filename: string): AssetKindSpec | null {
    const extension = extensionOf(filename);
    for (const spec of ASSET_KINDS) {
      if (spec.extensions.includes(extension)) return spec;
    }
    return null;
  }

  static describeUnsupported(filename: string): string | null {
    const extension = extensionOf(filename);
    for (const spec of ASSET_KINDS) {
      const message = spec.rejectedExtensions[extension];
      if (message) return message;
    }
    return null;
  }

  async import(options: ImportAssetOptions): Promise<ImportAssetResult> {
    const { bytes } = options;
    if (bytes.byteLength === 0) {
      throw new WorkspaceError('empty-file', 'the uploaded file is empty', 422);
    }
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw new WorkspaceError(
        'file-too-large',
        `assets are limited to ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MiB in this version`,
        413,
      );
    }

    const unsupported = AssetService.describeUnsupported(options.filename);
    if (unsupported) throw new WorkspaceError('unsupported-format', unsupported, 415);

    const spec = options.kind
      ? ASSET_KINDS.find((candidate) => candidate.kind === options.kind) ?? null
      : AssetService.specFor(options.filename);
    if (!spec) {
      throw new WorkspaceError(
        'unsupported-format',
        `"${options.filename}" is not a supported asset. Supported: models (${ASSET_KINDS[0]!.extensions.join(', ')}), images (${ASSET_KINDS[1]!.extensions.join(', ')}), audio (${ASSET_KINDS[2]!.extensions.join(', ')}).`,
        415,
      );
    }
    const extension = extensionOf(options.filename);
    if (!spec.extensions.includes(extension)) {
      throw new WorkspaceError(
        'wrong-kind',
        `"${options.filename}" is not a ${spec.kind} this version supports (${spec.extensions.join(', ')})`,
        415,
      );
    }

    const projectRoot = await this.workspace.projectRoot(options.projectId);
    const manifest = await this.readManifest(projectRoot);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const warnings: string[] = [];
    const requires = detectRequirements(bytes, spec.kind, warnings);

    const replacing = options.replaceAssetId ?? options.assetId;
    const existing = replacing ? manifest.assets.find((asset) => asset.id === replacing) : undefined;
    if (replacing && !existing) {
      throw new WorkspaceError('asset-not-found', `no asset "${replacing}" in this project`, 404);
    }
    if (existing && existing.kind !== spec.kind) {
      throw new WorkspaceError(
        'kind-mismatch',
        `asset "${existing.id}" is a ${existing.kind}; replacing it with a ${spec.kind} would break the scenes that use it`,
        409,
      );
    }

    const assetId = existing?.id ?? options.assetId ?? uniqueId(slugify(options.displayName ?? options.filename), manifest.assets);
    if (!existing && manifest.assets.some((asset) => asset.id === assetId)) {
      throw new WorkspaceError('asset-exists', `asset id "${assetId}" is already used`, 409);
    }

    const storedName = `${assetId}-${hash.slice(0, 8)}${extension}`;
    const folder = join(projectRoot, 'assets', `${spec.kind}s`);
    const target = join(folder, storedName);
    await mkdir(folder, { recursive: true });

    if (existing && existing.path !== relativeAssetPath(spec.kind, storedName)) {
      await this.archiveOriginal(projectRoot, existing);
    }
    await writeFile(target, bytes);

    const entry: AssetEntry = {
      id: assetId,
      kind: spec.kind,
      path: relativeAssetPath(spec.kind, storedName),
      hash: `sha256:${hash}`,
      bytes: bytes.byteLength,
      note: existing?.note ?? '',
      requires,
      meta: existing?.meta ?? {},
    };

    const nextManifest: AssetManifest = {
      schemaVersion: manifest.schemaVersion,
      assets: existing
        ? manifest.assets.map((asset) => (asset.id === existing.id ? entry : asset))
        : [...manifest.assets, entry],
    };
    await this.writeManifest(projectRoot, nextManifest);

    return { entry, manifest: nextManifest, replaced: Boolean(existing), warnings };
  }

  async remove(projectId: string, assetId: string): Promise<{ manifest: AssetManifest; removed: AssetEntry }> {
    const projectRoot = await this.workspace.projectRoot(projectId);
    const manifest = await this.readManifest(projectRoot);
    const entry = manifest.assets.find((asset) => asset.id === assetId);
    if (!entry) throw new WorkspaceError('asset-not-found', `no asset "${assetId}" in this project`, 404);

    // References are checked, not guessed: a scene that still points at the asset blocks
    // the removal instead of silently losing the model.
    const referencingScenes = await this.findReferences(projectId, assetId);
    if (referencingScenes.length > 0) {
      throw new WorkspaceError(
        'asset-in-use',
        `asset "${assetId}" is used by ${referencingScenes.join(', ')}; remove those references first`,
        409,
      );
    }

    await this.archiveOriginal(projectRoot, entry);
    const nextManifest: AssetManifest = {
      schemaVersion: manifest.schemaVersion,
      assets: manifest.assets.filter((asset) => asset.id !== assetId),
    };
    await this.writeManifest(projectRoot, nextManifest);
    return { manifest: nextManifest, removed: entry };
  }

  async readManifest(projectRoot: string): Promise<AssetManifest> {
    const path = join(projectRoot, PROJECT_FILES.assetManifest);
    if (!existsSync(path)) return { schemaVersion: 1, assets: [] };
    const raw = parseJson(await readFile(path, 'utf8'));
    const parsed = parseAssetManifest(raw);
    if (!parsed.value) {
      throw new WorkspaceError('invalid-assets', 'assets/manifest.json is not valid', 422, parsed.issues);
    }
    return parsed.value;
  }

  async writeManifest(projectRoot: string, manifest: AssetManifest): Promise<void> {
    await writeFileAtomic(join(projectRoot, PROJECT_FILES.assetManifest), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  /** Absolute path of an asset's stored file, with containment enforced. */
  async assetFilePath(projectId: string, assetId: string): Promise<{ path: string; entry: AssetEntry }> {
    const projectRoot = await this.workspace.projectRoot(projectId);
    const manifest = await this.readManifest(projectRoot);
    const entry = manifest.assets.find((asset) => asset.id === assetId);
    if (!entry) throw new WorkspaceError('asset-not-found', `no asset "${assetId}" in this project`, 404);
    const path = join(projectRoot, entry.path);
    if (!existsSync(path)) {
      throw new WorkspaceError(
        'asset-file-missing',
        `asset "${assetId}" is listed in the manifest but ${entry.path} is missing`,
        410,
      );
    }
    return { path, entry };
  }

  /** Scene ids that reference an asset, used before deleting or replacing it. */
  async findReferences(projectId: string, assetId: string): Promise<string[]> {
    const project = await this.workspace.readProject(projectId);
    const assetProperties = behaviorAssetProperties(await this.workspace.readBehaviorRegistry(projectId));
    const referencing: string[] = [];
    for (const sceneEntry of project.scenes) {
      const scene = await this.workspace.readScene(projectId, sceneEntry.id).catch(() => null);
      if (!scene) continue;
      const used = scene.entities.some((entity) =>
        entity.components.some((component) => referencedAssetIdsOf(component, assetProperties).includes(assetId)),
      );
      if (used) referencing.push(sceneEntry.id);
    }
    return referencing;
  }

  /** Usages per asset id, for the asset browser ("used by 2 objects in main"). */
  async usageIndex(projectId: string): Promise<Record<string, Array<{ sceneId: string; entityId: string; entityName: string }>>> {
    const project = await this.workspace.readProject(projectId);
    const index: Record<string, Array<{ sceneId: string; entityId: string; entityName: string }>> = {};
    const assetProperties = behaviorAssetProperties(await this.workspace.readBehaviorRegistry(projectId));
    for (const sceneEntry of project.scenes) {
      const scene = await this.workspace.readScene(projectId, sceneEntry.id).catch(() => null);
      if (!scene) continue;
      for (const entity of scene.entities) {
        for (const component of entity.components) {
          for (const assetId of referencedAssetIdsOf(component, assetProperties)) {
            (index[assetId] ??= []).push({ sceneId: sceneEntry.id, entityId: entity.id, entityName: entity.name });
          }
        }
      }
    }
    return index;
  }

  /** Move the previous file into the project's recovery folder rather than deleting it. */
  private async archiveOriginal(projectRoot: string, entry: AssetEntry): Promise<void> {
    const source = join(projectRoot, entry.path);
    if (!existsSync(source)) return;
    const folder = join(projectRoot, PROJECT_FILES.internal, 'assets');
    await mkdir(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(folder, `${stamp}__${entry.id}${extname(entry.path)}`);
    await rename(source, target);
    await writeFile(`${target}.json`, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  }
}

function extensionOf(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.gltf.zip')) return '.gltf.zip';
  return extname(lower);
}

function slugify(value: string): string {
  const base = value
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'asset';
}

function uniqueId(base: string, assets: AssetEntry[]): string {
  const used = new Set(assets.map((asset) => asset.id));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function relativeAssetPath(kind: AssetKind, storedName: string): string {
  return `assets/${kind}s/${storedName}`;
}

/**
 * Read the extensions a GLB requires without a loader, so the manifest records them and
 * the runtime can fail with a clear message.
 */
function detectRequirements(bytes: Uint8Array, kind: AssetKind, warnings: string[]): string[] {
  if (kind !== 'model') return [];
  if (bytes.byteLength < 20) {
    warnings.push('the file is too short to be a GLB; it will fail to load');
    return [];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== 'glTF') {
    warnings.push('the file does not start with a GLB header; .gltf files must ship their .bin and textures alongside');
    return [];
  }
  const jsonLength = view.getUint32(12, true);
  const jsonStart = 20;
  if (jsonStart + jsonLength > bytes.byteLength) {
    warnings.push('the GLB JSON chunk is truncated');
    return [];
  }
  try {
    const chunk = parseJson(new TextDecoder().decode(bytes.subarray(jsonStart, jsonStart + jsonLength)).trim());
    // Only declared string extensions count: a GLB that puts anything else in these arrays is
    // malformed, and its entries are not extensions this build could look up.
    const declared = [...(jsonArray(chunk, 'extensionsRequired') ?? []), ...(jsonArray(chunk, 'extensionsUsed') ?? [])];
    return [...new Set(declared.filter(isJsonString))].sort();
  } catch {
    warnings.push('the GLB JSON chunk could not be parsed');
    return [];
  }
}
