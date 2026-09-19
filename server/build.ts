import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  log: string[];
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
  const detail = await Promise.all(
    files.map(async (path) => ({ path: relative(outDir, path).split(sep).join('/'), bytes: (await stat(path)).size })),
  );
  const totalBytes = detail.reduce((sum, entry) => sum + entry.bytes, 0);
  write(`exported ${detail.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB`);

  return {
    ok: true,
    outDir,
    relativeOutDir: relative(projectRoot, outDir).split(sep).join('/'),
    files: detail,
    totalBytes,
    log,
  };
}

const PROJECT_DOCUMENT_FOLDERS = ['scenes', 'assets', 'scripts'];

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
