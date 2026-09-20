import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { inflateRawSync, crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchiveError } from '../../server/archive.js';
import { createZip } from '../../server/zip.js';
import { packageExport } from '../../server/build.js';
import { Workspace, WorkspaceError } from '../../server/workspace.js';

/**
 * Packaged game exports (plan §14): the zip a browser downloads must be one any unzip opens, and
 * it must contain exactly what the export folder holds.
 *
 * The reader below is an independent decode of the central directory rather than a call into the
 * writer, so a header mistake shows up as a failing test instead of a file that only our code
 * understands.
 */

const repositoryRoot = new URL('../../', import.meta.url).pathname;

interface ReadEntry {
  path: string;
  method: number;
  bytes: Uint8Array;
}

function readZip(zip: Uint8Array): ReadEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const endOffset = zip.byteLength - 22;
  expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
  const count = view.getUint16(endOffset + 10, true);
  let cursor = view.getUint32(endOffset + 16, true);
  const entries: ReadEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedBytes = view.getUint32(cursor + 20, true);
    const uncompressedBytes = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const path = new TextDecoder().decode(zip.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = zip.subarray(dataStart, dataStart + compressedBytes);
    const bytes = method === 8 ? new Uint8Array(inflateRawSync(compressed)) : new Uint8Array(compressed);
    expect(bytes.byteLength).toBe(uncompressedBytes);
    expect(crc32(bytes)).toBe(expectedCrc);
    entries.push({ path, method, bytes });
  }
  return entries;
}

describe('zip archives', () => {
  it('writes entries an independent reader decodes, deflating only when it helps', () => {
    const text = new TextEncoder().encode('{"kind":"game"}'.repeat(50));
    const noise = new Uint8Array(randomBytes(512));
    const zip = createZip([
      { path: 'demo/index.html', bytes: text },
      { path: 'demo/assets/blob.bin', bytes: noise },
      { path: 'demo/empty.txt', bytes: new Uint8Array() },
    ]);
    const read = readZip(zip);
    expect(read.map((entry) => entry.path)).toEqual(['demo/index.html', 'demo/assets/blob.bin', 'demo/empty.txt']);
    expect(read[0]!.method).toBe(8);
    expect(Array.from(read[0]!.bytes)).toEqual(Array.from(text));
    expect(read[1]!.method).toBe(0);
    expect(Array.from(read[1]!.bytes)).toEqual(Array.from(noise));
    expect(read[2]!.bytes.byteLength).toBe(0);
  });

  it('refuses unsafe and duplicate paths', () => {
    expect(() => createZip([{ path: '../escape.html', bytes: new Uint8Array() }])).toThrow(ArchiveError);
    expect(() => createZip([{ path: '/index.html', bytes: new Uint8Array() }])).toThrow(ArchiveError);
    expect(() =>
      createZip([
        { path: 'a.txt', bytes: new Uint8Array() },
        { path: 'a.txt', bytes: new Uint8Array() },
      ]),
    ).toThrow(/appears twice/);
  });

  it('stamps a DOS timestamp inside the format range', () => {
    const zip = createZip([{ path: 'a.txt', bytes: new Uint8Array([1]) }], { modified: new Date(2026, 8, 19, 18, 46, 31) });
    const view = new DataView(zip.buffer);
    const time = view.getUint16(10, true);
    const date = view.getUint16(12, true);
    expect(time >> 11).toBe(18);
    expect((time >> 5) & 0x3f).toBe(46);
    expect((time & 0x1f) * 2).toBe(30);
    expect((date >> 9) + 1980).toBe(2026);
    expect((date >> 5) & 0x0f).toBe(9);
    expect(date & 0x1f).toBe(19);
  });
});

describe('packageExport', () => {
  let workspaceRoot: string;
  let workspace: Workspace;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'coilbox-zip-'));
    workspace = new Workspace({ root: workspaceRoot, templatesRoot: join(repositoryRoot, 'templates') });
    await workspace.createProject({ id: 'demo', name: 'Demo', template: 'blank' });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('refuses a project that has not been exported', async () => {
    await expect(packageExport(workspace, 'demo')).rejects.toMatchObject<Partial<WorkspaceError>>({
      code: 'no-export',
      status: 404,
    });
  });

  it('packages the export folder under the project id, with nothing else', async () => {
    const outDir = join(workspaceRoot, 'demo', '.coilbox', 'export');
    await mkdir(join(outDir, 'project', 'scenes'), { recursive: true });
    await writeFile(join(outDir, 'index.html'), '<!doctype html>');
    await writeFile(join(outDir, 'project', 'game.json'), '{}');
    await writeFile(join(outDir, 'project', 'scenes', 'main.scene.json'), '{"entities":[]}');
    await writeFile(join(workspaceRoot, 'demo', 'notes.txt'), 'not part of the export');

    const packaged = await packageExport(workspace, 'demo');
    expect(packaged.fileName).toBe('demo.zip');
    expect(packaged.files).toBe(3);
    expect(packaged.totalBytes).toBe('<!doctype html>'.length + 2 + '{"entities":[]}'.length);
    const read = readZip(packaged.bytes);
    expect(read.map((entry) => entry.path)).toEqual([
      'demo/index.html',
      'demo/project/game.json',
      'demo/project/scenes/main.scene.json',
    ]);
    expect(new TextDecoder().decode(read[2]!.bytes)).toBe('{"entities":[]}');
  });
});
