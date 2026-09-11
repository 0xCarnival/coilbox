/// <reference types="vite/client" />

/** URL of the Box3D WASM binary, provided by tools/vite-plugin-box3d-wasm.ts. */
declare module 'virtual:box3d-wasm-url' {
  const url: string;
  export default url;
}

/** Injected by the export build: the project documents' location relative to the player. */
declare const __COILBOX_PROJECT__: string | undefined;
