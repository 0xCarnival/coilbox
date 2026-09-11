import { defineConfig } from 'vitest/config';
import { aliases } from './vite.config.js';
import { box3dWasmPlugin } from './tools/vite-plugin-box3d-wasm.js';

/**
 * Unit tests run the real Box3D WASM binding in Node — no browser, no mocks — so the
 * physics evidence is reproducible and fast. Browser-level checks live in
 * tools/verify-stage0.ts and tests/browser.
 */
export default defineConfig({
  plugins: [box3dWasmPlugin()],
  resolve: { alias: aliases },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The WASM module is instantiated once per worker; a single thread keeps that cheap
    // and keeps the output readable.
    pool: 'threads',
    maxWorkers: 1,
  },
});
