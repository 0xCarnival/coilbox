import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import stylex from '@stylexjs/unplugin/vite';
import { box3dWasmPlugin } from './tools/vite-plugin-box3d-wasm.js';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export const aliases = {
  '@schema': resolvePath('./src/schema'),
  '@runtime': resolvePath('./src/runtime'),
  '@editor': resolvePath('./src/editor'),
  '@shared': resolvePath('./src/shared'),
};

/**
 * One repository, one Vite config (plan §5).
 *
 * - `index.html`  editor shell
 * - `probe.html`  stage 0 runtime probe (kept as a development/verification page)
 * - `player.html` standalone game entry point, the same runtime the export ships
 *
 * `base: './'` keeps every emitted URL relative, so builds work under a nested path
 * (plan §14: "Test the finished game under a nested path, not only at a host's root").
 */
export default defineConfig({
  base: './',
  plugins: [box3dWasmPlugin(), stylex(), react()],
  resolve: {
    alias: aliases,
  },
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolvePath('./index.html'),
        probe: resolvePath('./probe.html'),
        player: resolvePath('./player.html'),
      },
    },
  },
});
