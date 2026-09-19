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
 * is why it is bound late through `bindRenderer` rather than at construction. Loaders (and their
 * worker pools) are created on the first `configure` and released by `dispose`.
 */
export interface DecoderSelection {
  draco?: boolean;
  meshopt?: boolean;
  ktx2?: boolean;
}

export const DECODER_EXTENSIONS = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'] as const;
export type DecoderExtension = (typeof DECODER_EXTENSIONS)[number];

export class GltfDecoders {
  private readonly selection: DecoderSelection;
  private renderer: THREE.WebGLRenderer | null = null;
  private draco: DRACOLoader | null = null;
  private ktx2: KTX2Loader | null = null;

  constructor(selection: DecoderSelection = { draco: true, meshopt: true, ktx2: true }) {
    this.selection = selection;
  }

  /** KTX2 transcoding targets the formats this renderer's GPU accepts; call before the first load. */
  bindRenderer(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer;
  }

  supports(extension: string): boolean {
    switch (extension) {
      case 'KHR_draco_mesh_compression':
        return this.selection.draco === true;
      case 'EXT_meshopt_compression':
        return this.selection.meshopt === true;
      case 'KHR_texture_basisu':
        return this.selection.ktx2 === true && this.renderer !== null;
      default:
        return false;
    }
  }

  configure(loader: GLTFLoader): void {
    if (this.selection.draco) loader.setDRACOLoader((this.draco ??= new DRACOLoader()));
    if (this.selection.meshopt) loader.setMeshoptDecoder(MeshoptDecoder);
    if (this.selection.ktx2 && this.renderer) {
      loader.setKTX2Loader((this.ktx2 ??= new KTX2Loader().detectSupport(this.renderer)));
    }
  }

  /** Terminates the codec workers. The next `configure` starts fresh ones, so a host may reuse the object. */
  dispose(): void {
    this.draco?.dispose();
    this.draco = null;
    this.ktx2?.dispose();
    this.ktx2 = null;
  }
}
