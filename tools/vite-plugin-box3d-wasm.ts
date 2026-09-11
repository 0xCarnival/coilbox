import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * Makes the Box3D WASM binary available to both the dev server and production builds.
 *
 * `box3d.js` resolves its wasm with `new URL('box3d.wasm', import.meta.url)`, which only
 * works while the module file sits next to the binary. Inside a bundler the module is
 * relocated, so the adapter passes an explicit `locateFile`. This plugin is the single
 * place that knows where the binary lives:
 *
 * - dev: served straight from `node_modules` (Vite can read it from the project root)
 * - build: emitted as an asset, so the player and exported games work under any base path
 *
 * The virtual module `virtual:box3d-wasm-url` exports the URL as a string. The package
 * does not export the wasm subpath, so the binary is located relative to the resolved
 * module entry.
 */

const VIRTUAL_ID = 'virtual:box3d-wasm-url';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

function resolveWasmPath(root: string): string {
  const candidates: string[] = [];
  try {
    const entry = import.meta.resolve('box3d.js');
    if (entry.startsWith('file:')) candidates.push(join(dirname(fileURLToPath(entry)), 'box3d.wasm'));
  } catch {
    // Unusual resolver or older Node: fall through to the node_modules location.
  }
  candidates.push(join(root, 'node_modules', 'box3d.js', 'dist', 'box3d.wasm'));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `coilbox:box3d-wasm could not find box3d.wasm. Looked in:\n${candidates.map((c) => `  ${c}`).join('\n')}`,
  );
}

export function box3dWasmPlugin(): Plugin {
  let isBuild = false;
  let base = '/';
  let root = process.cwd();

  return {
    name: 'coilbox:box3d-wasm',
    configResolved(config) {
      isBuild = config.command === 'build';
      base = config.base;
      root = config.root;
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      const wasmPath = resolveWasmPath(root);
      if (!isBuild) {
        const normalizedBase = base.endsWith('/') ? base : `${base}/`;
        const relative = wasmPath.slice(root.length).split('\\').join('/').replace(/^\//, '');
        return `export default ${JSON.stringify(`${normalizedBase}${relative}`)};`;
      }
      const source = readFileSync(wasmPath);
      const referenceId = this.emitFile({
        type: 'asset',
        name: 'box3d.wasm',
        source,
      });
      return [`const url = import.meta.ROLLUP_FILE_URL_${referenceId};`, 'export default url;'].join('\n');
    },
  };
}
