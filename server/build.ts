import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetReferencesOf, type AssetEntry, type AssetKind, type AssetManifest } from '@schema/index.js';
import { box3dWasmPlugin } from '../tools/vite-plugin-box3d-wasm.js';
import { Workspace, WorkspaceError } from './workspace.js';

/**
 * Export Game: a standalone web player plus the project documents it needs (plan §14).
 *
 * The build is a fixed pipeline, not a shell command, so the workspace service can run it
 * from a browser request without accepting arbitrary arguments.
 *
 * Output layout (inside the project's `.coilbox` folder, which source exports exclude):
 *
 *   .coilbox/export/
 *     index.html            the player entry
 *     assets/*              compiled runtime, wasm, decoders
 *     project/              game.json, scenes/, assets/, scripts/ — plain files
 *     NOTICES.txt           bundled third-party notices
 *
 * Only assets some scene references are copied, and the exported manifest lists only those: an
 * import that was tried and abandoned should not be what makes a published game slow to load. The
 * result reports every asset's size and whether it shipped, so the author can see what the export
 * weighs and why.
 *
 * The exported game must run with the editor and the workspace service switched off, which
 * is what `tools/verify-stage1.ts` checks.
 */

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export interface BuildResult {
  ok: boolean;
  /** Absolute path of the export directory. */
  outDir: string;
  /** Project-relative path of the export directory (what the editor shows). */
  relativeOutDir: string;
  files: Array<{ path: string; bytes: number }>;
  totalBytes: number;
  /** Every manifest asset, largest first, with whether it shipped. */
  assets: ExportedAsset[];
  /** Bytes of unreferenced assets left out of the export. */
  prunedBytes: number;
  log: string[];
}

export interface ExportedAsset {
  id: string;
  kind: AssetKind;
  path: string;
  bytes: number;
  /** False when no scene references the asset, so it stayed out of the export. */
  included: boolean;
}

export interface AssetExportPlan {
  assets: ExportedAsset[];
  /** The manifest the export ships: the referenced entries only. */
  manifest: AssetManifest;
  prunedBytes: number;
}

/**
 * Decide which manifest assets an export ships: those at least one scene references. Sizes come
 * from the manifest, so the report is the same whether or not the files are read.
 */
export function planAssetExport(manifest: AssetManifest, referenced: ReadonlySet<string>): AssetExportPlan {
  const assets = manifest.assets
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      path: entry.path,
      bytes: entry.bytes,
      included: referenced.has(entry.id),
    }))
    .sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));
  const kept = new Set(assets.filter((asset) => asset.included).map((asset) => asset.id));
  return {
    assets,
    manifest: { schemaVersion: manifest.schemaVersion, assets: manifest.assets.filter((entry) => kept.has(entry.id)) },
    prunedBytes: assets.reduce((sum, asset) => (asset.included ? sum : sum + asset.bytes), 0),
  };
}

export interface BuildOptions {
  workspace: Workspace;
  projectId: string;
  /** Relative output directory inside the project; defaults to `.coilbox/export`. */
  outSubdirectory?: string;
  log?: (message: string) => void;
}

export async function buildGame(options: BuildOptions): Promise<BuildResult> {
  const log: string[] = [];
  const write = (message: string) => {
    log.push(message);
    options.log?.(message);
  };

  const projectRoot = await options.workspace.projectRoot(options.projectId);
  const validation = await options.workspace.validateProject(options.projectId);
  const errors = validation.issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new WorkspaceError(
      'invalid-project',
      `refusing to build "${options.projectId}": ${errors.length} validation error(s)`,
      422,
      errors,
    );
  }

  const outDir = join(projectRoot, options.outSubdirectory ?? join('.coilbox', 'export'));
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  write(`building player for "${options.projectId}" into ${outDir}`);

  const { build } = await import('vite');
  await build({
    configFile: false,
    root: repositoryRoot,
    base: './',
    publicDir: false,
    plugins: [box3dWasmPlugin()],
    define: {
      __COILBOX_PROJECT__: JSON.stringify('./project/'),
    },
    resolve: {
      alias: {
        '@schema': join(repositoryRoot, 'src/schema'),
        '@runtime': join(repositoryRoot, 'src/runtime'),
        '@editor': join(repositoryRoot, 'src/editor'),
        '@shared': join(repositoryRoot, 'src/shared'),
      },
    },
    build: {
      outDir,
      emptyOutDir: false,
      target: 'es2022',
      sourcemap: false,
      rollupOptions: {
        input: { index: join(repositoryRoot, 'player.html') },
      },
    },
    logLevel: 'warn',
  });
  // Vite names the emitted page after its source file; the export entry is index.html.
  const emittedPlayer = join(outDir, 'player.html');
  if (existsSync(emittedPlayer)) {
    await rename(emittedPlayer, join(outDir, 'index.html'));
  } else if (!existsSync(join(outDir, 'index.html'))) {
    throw new WorkspaceError('build-failed', 'the player build produced no entry page', 500);
  }
  write('player bundle compiled');

  await copyIcons(outDir);
  await copyProjectDocuments(projectRoot, join(outDir, 'project'), write);

  const detail = await options.workspace.readProject(options.projectId);
  const manifest = await options.workspace.readAssetManifest(projectRoot, detail.game);
  // Every scene is read outright: a scene that fails to parse must fail the export, not quietly
  // drop the assets it references.
  const referenced = new Set<string>();
  for (const sceneEntry of detail.game.scenes) {
    const scene = await options.workspace.readScene(options.projectId, sceneEntry.id);
    for (const entity of scene.entities) {
      for (const component of entity.components) {
        for (const reference of assetReferencesOf(component)) referenced.add(reference.assetId);
      }
    }
  }
  const plan = planAssetExport(manifest, referenced);
  await copyAssets(projectRoot, join(outDir, 'project'), detail.game.assetManifest, plan.manifest);
  const shipped = plan.assets.filter((asset) => asset.included);
  const shippedBytes = shipped.reduce((sum, asset) => sum + asset.bytes, 0);
  write(
    `${shipped.length} asset(s) bundled, ${formatBytes(shippedBytes)}; ${plan.assets.length - shipped.length} unused skipped, ${formatBytes(plan.prunedBytes)}`,
  );
  for (const asset of plan.assets) {
    write(`  ${asset.included ? 'bundled' : 'skipped'}  ${formatBytes(asset.bytes).padStart(10)}  ${asset.id} (${asset.kind})`);
  }

  await writeFile(
    join(outDir, 'NOTICES.txt'),
    [
      'This exported game bundles third-party software:',
      '',
      '- three.js — MIT License — https://github.com/mrdoob/three.js',
      '- box3d.js — MIT License — https://github.com/isaac-mason/box3d.js',
      '- Box3D — MIT License — https://github.com/erincatto/box3d',
      '- Draco decoder — Apache License 2.0 — https://github.com/google/draco',
      '- Basis Universal transcoder — Apache License 2.0 — https://github.com/BinomialLLC/basis_universal',
      '- meshoptimizer decoder — MIT License — https://github.com/zeux/meshoptimizer',
      '',
      'Imported assets keep their own licences; check the project README before publishing.',
      '',
    ].join('\n'),
    'utf8',
  );

  const files = await listFiles(outDir);
  const fileDetail = await Promise.all(
    files.map(async (path) => ({ path: relative(outDir, path).split(sep).join('/'), bytes: (await stat(path)).size })),
  );
  const totalBytes = fileDetail.reduce((sum, entry) => sum + entry.bytes, 0);
  write(`exported ${fileDetail.length} files, ${formatBytes(totalBytes)}`);

  return {
    ok: true,
    outDir,
    relativeOutDir: relative(projectRoot, outDir).split(sep).join('/'),
    files: fileDetail,
    totalBytes,
    assets: plan.assets,
    prunedBytes: plan.prunedBytes,
    log,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/** Assets are copied one by one from the pruned manifest, never as a folder. */
const PROJECT_DOCUMENT_FOLDERS = ['scenes', 'scripts'];

const PROJECT_DOCUMENT_FILES = ['game.json', 'README.md'];
/** Icons the HTML pages link, copied into every export. */
const ICON_FILES = ['favicon-32.png', 'favicon-192.png', 'apple-touch-icon.png'];

/**
 * The pages link their icons relatively, and an export is built with `publicDir: false` (an export
 * ships the player, not the repository's public folder), so the icons the HTML asks for have to be
 * copied next to it. Without this an exported game requests a missing icon and the browser logs a
 * 404 for a page that is otherwise fine.
 */
async function copyIcons(outDir: string): Promise<void> {
  for (const icon of ICON_FILES) {
    const source = join(repositoryRoot, 'public', icon);
    if (!existsSync(source)) continue;
    await cp(source, join(outDir, icon));
  }
}

async function copyProjectDocuments(projectRoot: string, target: string, write: (message: string) => void): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const file of PROJECT_DOCUMENT_FILES) {
    const source = join(projectRoot, file);
    if (!existsSync(source)) continue;
    await cp(source, join(target, file));
  }
  for (const folder of PROJECT_DOCUMENT_FOLDERS) {
    const source = join(projectRoot, folder);
    if (!existsSync(source)) continue;
    await cp(source, join(target, folder), { recursive: true });
  }
  write('project documents copied next to the player');
}

async function copyAssets(projectRoot: string, target: string, manifestPath: string, manifest: AssetManifest): Promise<void> {
  const manifestTarget = join(target, ...manifestPath.split('/'));
  await mkdir(dirname(manifestTarget), { recursive: true });
  await writeFile(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  for (const entry of manifest.assets) {
    await copyAsset(projectRoot, target, entry);
  }
}

async function copyAsset(projectRoot: string, target: string, entry: AssetEntry): Promise<void> {
  const segments = entry.path.split('/');
  const source = join(projectRoot, ...segments);
  if (!existsSync(source)) {
    throw new WorkspaceError(
      'asset-missing',
      `asset "${entry.id}" is referenced by a scene but its file ${entry.path} is missing; re-import it before exporting`,
      422,
    );
  }
  const destination = join(target, ...segments);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else result.push(path);
    }
  };
  await walk(root);
  return result.sort();
}
