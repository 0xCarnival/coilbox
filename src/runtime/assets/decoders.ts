import type * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/**
 * The glTF compression decoders a host hands to `AssetCache`.
 *
 * Draco and Basis Universal transcode in web workers fed from script/wasm files that three
 * ships and locates relative to its own modules (`new URL(..., import.meta.url)`), so the
 * bundler emits them next to the runtime and a nested export path still finds them. meshopt is
 * a self-contained module. A cache created without decoders (Node tests, the headless runner)
 * keeps refusing compressed models with the recorded message instead of failing inside a
 * loader.
 *
 * KTX2 additionally needs a renderer to pick the GPU texture format to transcode into, which
 * is why it is bound late through `bindRenderer` rather than at construction.
 */
export interface DecoderSelection {
  draco?: boolean;
  meshopt?: boolean;
  ktx2?: boolean;
}

export const DECODER_EXTENSIONS = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'] as const;
export type DecoderExtension = (typeof DECODER_EXTENSIONS)[number];

export class GltfDecoders {
  private readonly draco: DRACOLoader | null;
  private readonly ktx2: KTX2Loader | null;
  private readonly meshopt: boolean;
  private rendererBound = false;

  constructor(selection: DecoderSelection = { draco: true, meshopt: true, ktx2: true }) {
    this.draco = selection.draco === true ? new DRACOLoader() : null;
    this.ktx2 = selection.ktx2 === true ? new KTX2Loader() : null;
    this.meshopt = selection.meshopt === true;
  }

  /** KTX2 transcoding targets the formats this renderer's GPU accepts; call before the first load. */
  bindRenderer(renderer: THREE.WebGLRenderer): void {
    if (!this.ktx2 || this.rendererBound) return;
    this.ktx2.detectSupport(renderer);
    this.rendererBound = true;
  }

  supports(extension: string): boolean {
    switch (extension) {
      case 'KHR_draco_mesh_compression':
        return this.draco !== null;
      case 'EXT_meshopt_compression':
        return this.meshopt;
      case 'KHR_texture_basisu':
        return this.ktx2 !== null && this.rendererBound;
      default:
        return false;
    }
  }

  configure(loader: GLTFLoader): void {
    if (this.draco) loader.setDRACOLoader(this.draco);
    if (this.meshopt) loader.setMeshoptDecoder(MeshoptDecoder);
    if (this.ktx2 && this.rendererBound) loader.setKTX2Loader(this.ktx2);
  }

  dispose(): void {
    this.draco?.dispose();
    this.ktx2?.dispose();
  }
}
