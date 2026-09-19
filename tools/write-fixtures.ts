import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { draco, meshopt } from '@gltf-transform/functions';
import draco3d from 'draco3d';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

/**
 * Writes the binary fixtures the asset tests need. Generating them from code keeps the
 * fixtures reproducible and reviewable instead of shipping opaque binaries nobody can
 * regenerate.
 *
 * Run with: pnpm tsx tools/write-fixtures.ts
 *
 * Fixtures:
 *   models/animated-limb.glb  - skinned mesh with a one-second clip (independent instances)
 *   models/spinning-crate.glb - plain mesh with a node-transform clip
 *   models/draco-required.glb - a valid GLB that merely declares Draco (its geometry is plain)
 *   models/draco-crate.glb    - the crate with its geometry really Draco-compressed
 *   models/meshopt-crate.glb  - the crate with its geometry really meshopt-compressed
 *   models/not-a-model.glb    - bytes that are not a GLB at all
 *   images/swatch.png         - a small opaque image
 *   audio/beep.wav            - a short 16-bit PCM tone
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturesRoot = join(root, 'tests', 'fixtures');

/**
 * GLTFExporter's binary path uses `FileReader`, which Node does not provide. The shim is
 * only for fixture generation in Node; the browser has the real thing.
 */
class FileReaderShim {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  onerror: ((error: Error) => void) | null = null;

  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = buffer;
        this.onloadend?.();
      },
      (error) => this.onerror?.(error),
    );
  }

  readAsDataURL(blob: Blob): void {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onloadend?.();
      },
      (error) => this.onerror?.(error),
    );
  }
}

(globalThis as { FileReader?: unknown }).FileReader ??= FileReaderShim;

async function write(relativePath: string, contents: Uint8Array): Promise<void> {
  const target = join(fixturesRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
  process.stdout.write(`wrote ${relativePath} (${contents.byteLength} bytes)\n`);
}

async function exportGlb(root3d: THREE.Object3D, animations: THREE.AnimationClip[]): Promise<Uint8Array> {
  const exporter = new GLTFExporter();
  const result = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(root3d, (output) => resolve(output as ArrayBuffer), (error) => reject(error), {
      binary: true,
      animations,
    });
  });
  return new Uint8Array(result);
}

/** A generated fixture: the object graph to export and the clip that animates it. */
interface BuiltFixture {
  scene: THREE.Object3D;
  clip: THREE.AnimationClip;
}

/** A two-bone skinned limb: the case where instances must not share skeleton state. */
function buildSkinnedLimb(): BuiltFixture {
  const geometry = new THREE.CylinderGeometry(0.15, 0.15, 1, 8, 8);
  geometry.translate(0, 0.5, 0);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  for (let index = 0; index < position.count; index += 1) {
    const weight = THREE.MathUtils.clamp(position.getY(index), 0, 1);
    skinIndices.push(0, 1, 0, 0);
    skinWeights.push(1 - weight, weight, 0, 0);
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

  const rootBone = new THREE.Bone();
  rootBone.name = 'upperArm';
  const forearm = new THREE.Bone();
  forearm.name = 'forearm';
  forearm.position.y = 1;
  rootBone.add(forearm);

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ color: 0x88aaff, roughness: 0.6 }));
  mesh.name = 'limb';
  mesh.add(rootBone);
  mesh.bind(new THREE.Skeleton([rootBone, forearm]));

  const scene = new THREE.Group();
  scene.name = 'LimbRoot';
  scene.add(mesh);

  const half = Math.sin(Math.PI / 8);
  const clip = new THREE.AnimationClip('Wave', 1, [
    new THREE.QuaternionKeyframeTrack(
      'forearm.quaternion',
      [0, 0.5, 1],
      [0, 0, 0, 1, 0, 0, half, Math.cos(Math.PI / 8), 0, 0, 0, 1],
    ),
  ]);
  return { scene, clip };
}

/** A plain crate with a movement clip: the simple, non-skinned animation case. */
function buildSpinningCrate(): BuiltFixture {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xd98b5b, roughness: 0.5 }),
  );
  mesh.name = 'Crate';
  const scene = new THREE.Group();
  scene.name = 'CrateRoot';
  scene.add(mesh);

  const clip = new THREE.AnimationClip('Hop', 0.8, [
    new THREE.VectorKeyframeTrack('Crate.position', [0, 0.4, 0.8], [0, 0, 0, 0, 0.6, 0, 0, 0, 0]),
    new THREE.QuaternionKeyframeTrack(
      'Crate.quaternion',
      [0, 0.8],
      [0, 0, 0, 1, 0, Math.sin(Math.PI / 2), 0, Math.cos(Math.PI / 2)],
    ),
  ]);
  return { scene, clip };
}

/** A 32x32 opaque PNG written by hand so the fixture needs no image library. */
function buildPng(): Uint8Array {
  const size = 32;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      raw[offset++] = Math.round((x / (size - 1)) * 255);
      raw[offset++] = Math.round((y / (size - 1)) * 255);
      raw[offset++] = 128;
      raw[offset++] = 255;
    }
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([length, body, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

let crcTable: number[] | null = null;
function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A short 16-bit PCM tone; the audio formats the studio claims to support end here. */
function buildWav(): Uint8Array {
  const sampleRate = 22050;
  const seconds = 0.3;
  const samples = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(1, index / 400) * Math.min(1, (samples - index) / 400);
    data.writeInt16LE(Math.round(Math.sin((index / sampleRate) * 440 * Math.PI * 2) * 12000 * envelope), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
}

/** Re-encode a GLB's geometry with a real compression codec, so the decoders have work to do. */
async function compressGlb(glb: Uint8Array, codec: 'draco' | 'meshopt'): Promise<Uint8Array> {
  const io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression, EXTMeshoptCompression])
    .registerDependencies({
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'meshopt.encoder': MeshoptEncoder,
      'meshopt.decoder': MeshoptDecoder,
    });
  const document = await io.readBinary(glb);
  await document.transform(codec === 'draco' ? draco() : meshopt({ encoder: MeshoptEncoder }));
  return io.writeBinary(document);
}

/**
 * Rebuild a GLB with an extra required extension declared, so the loader path for a codec
 * no decoder was supplied for can be tested. Parse both chunks and reassemble: patching in place only
 * works while the JSON stays the same length, which it does not.
 */
function declareRequiredExtension(glb: Uint8Array, extension: string): Uint8Array {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const totalLength = view.getUint32(8, true);
  const jsonLength = view.getUint32(12, true);
  const jsonStart = 20;
  const binHeaderStart = jsonStart + jsonLength;
  const binLength = view.getUint32(binHeaderStart, true);
  const binStart = binHeaderStart + 8;

  const json = JSON.parse(
    new TextDecoder().decode(glb.subarray(jsonStart, jsonStart + jsonLength)).trim(),
  ) as { extensionsRequired?: string[]; extensionsUsed?: string[] };
  json.extensionsRequired = [extension];
  json.extensionsUsed = [extension];

  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const paddedJson = new Uint8Array(Math.ceil(encoded.length / 4) * 4);
  paddedJson.fill(0x20);
  paddedJson.set(encoded);
  const binary = glb.subarray(binStart, binStart + binLength);

  const total = 12 + 8 + paddedJson.length + 8 + binary.length;
  if (total !== totalLength && totalLength !== glb.byteLength) {
    throw new Error('unexpected GLB layout');
  }
  const output = new Uint8Array(total);
  const outView = new DataView(output.buffer);
  output.set(new TextEncoder().encode('glTF'), 0);
  outView.setUint32(4, 2, true);
  outView.setUint32(8, total, true);
  outView.setUint32(12, paddedJson.length, true);
  outView.setUint32(16, 0x4e4f534a, true); // 'JSON'
  output.set(paddedJson, 20);
  const binHeader = 20 + paddedJson.length;
  outView.setUint32(binHeader, binary.length, true);
  outView.setUint32(binHeader + 4, 0x004e4942, true); // 'BIN\0'
  output.set(binary, binHeader + 8);
  return output;
}

const limb = buildSkinnedLimb();
await write('models/animated-limb.glb', await exportGlb(limb.scene, [limb.clip]));

const crate = buildSpinningCrate();
const crateGlb = await exportGlb(crate.scene, [crate.clip]);
await write('models/spinning-crate.glb', crateGlb);
await write('models/draco-required.glb', declareRequiredExtension(crateGlb, 'KHR_draco_mesh_compression'));
await write('models/draco-crate.glb', await compressGlb(crateGlb, 'draco'));
await write('models/meshopt-crate.glb', await compressGlb(crateGlb, 'meshopt'));
await write('models/not-a-model.glb', new Uint8Array([0x6e, 0x6f, 0x74, 0x20, 0x61, 0x20, 0x67, 0x6c, 0x62]));

await write('images/swatch.png', buildPng());
await write('audio/beep.wav', buildWav());
