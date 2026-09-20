import { crc32, deflateRawSync } from 'node:zlib';
import { ArchiveError, assertSafeArchivePath, type ArchiveEntry } from './archive.js';

/**
 * Minimal ZIP writer for packaged game exports (plan §14).
 *
 * Source projects travel as tar.gz because they round-trip through our own importer. An exported
 * game travels to a hosting provider or a friend instead, and there ZIP is the format every
 * operating system and static host opens without a tool. This writes the classic (non-Zip64)
 * layout: local headers, deflated or stored data, one central directory, end record. It refuses
 * archives that layout cannot describe rather than producing a file that unzips wrong.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
const VERSION_NEEDED = 20;
/** Bit 11: file names are UTF-8. */
const GENERAL_FLAGS = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const MAX_UINT32 = 0xffffffff;
const MAX_UINT16 = 0xffff;

export interface ZipOptions {
  /** Timestamp stamped on every entry; ZIP has no timezone, so local time is used as DOS does. */
  modified?: Date;
}

interface DosDateTime {
  date: number;
  time: number;
}

interface PackedEntry {
  name: Uint8Array;
  crc: number;
  method: number;
  compressed: Uint8Array;
  uncompressedBytes: number;
  localOffset: number;
}

export function createZip(entries: ArchiveEntry[], options: ZipOptions = {}): Uint8Array {
  if (entries.length > MAX_UINT16) {
    throw new ArchiveError('too-many-entries', `a zip archive holds at most ${MAX_UINT16} files, got ${entries.length}`);
  }
  const { date, time } = dosDateTime(options.modified ?? new Date());
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const chunks: Uint8Array[] = [];
  const packed: PackedEntry[] = [];
  let offset = 0;

  for (const entry of entries) {
    assertSafeArchivePath(entry.path);
    if (seen.has(entry.path)) throw new ArchiveError('duplicate-entry', `"${entry.path}" appears twice`);
    seen.add(entry.path);
    if (entry.bytes.byteLength > MAX_UINT32) {
      throw new ArchiveError('entry-too-large', `"${entry.path}" exceeds the 4 GiB zip entry limit`);
    }
    const deflated = new Uint8Array(deflateRawSync(entry.bytes, { level: 6 }));
    const useDeflate = deflated.byteLength < entry.bytes.byteLength;
    const item: PackedEntry = {
      name: encoder.encode(entry.path),
      crc: crc32(entry.bytes),
      method: useDeflate ? METHOD_DEFLATED : METHOD_STORED,
      compressed: useDeflate ? deflated : entry.bytes,
      uncompressedBytes: entry.bytes.byteLength,
      localOffset: offset,
    };
    if (item.name.byteLength > MAX_UINT16) throw new ArchiveError('name-too-long', `"${entry.path}" is too long for zip`);
    const header = new Uint8Array(30 + item.name.byteLength);
    const view = new DataView(header.buffer);
    view.setUint32(0, LOCAL_HEADER, true);
    view.setUint16(4, VERSION_NEEDED, true);
    view.setUint16(6, GENERAL_FLAGS, true);
    view.setUint16(8, item.method, true);
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, item.crc, true);
    view.setUint32(18, item.compressed.byteLength, true);
    view.setUint32(22, item.uncompressedBytes, true);
    view.setUint16(26, item.name.byteLength, true);
    view.setUint16(28, 0, true);
    header.set(item.name, 30);
    chunks.push(header, item.compressed);
    offset += header.byteLength + item.compressed.byteLength;
    packed.push(item);
  }

  const centralStart = offset;
  for (const item of packed) {
    const record = new Uint8Array(46 + item.name.byteLength);
    const view = new DataView(record.buffer);
    view.setUint32(0, CENTRAL_HEADER, true);
    view.setUint16(4, VERSION_NEEDED, true);
    view.setUint16(6, VERSION_NEEDED, true);
    view.setUint16(8, GENERAL_FLAGS, true);
    view.setUint16(10, item.method, true);
    view.setUint16(12, time, true);
    view.setUint16(14, date, true);
    view.setUint32(16, item.crc, true);
    view.setUint32(20, item.compressed.byteLength, true);
    view.setUint32(24, item.uncompressedBytes, true);
    view.setUint16(28, item.name.byteLength, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, item.localOffset, true);
    record.set(item.name, 46);
    chunks.push(record);
    offset += record.byteLength;
  }
  const centralBytes = offset - centralStart;
  if (offset + 22 > MAX_UINT32) throw new ArchiveError('archive-too-large', 'the export exceeds the 4 GiB zip limit');

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_RECORD, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, packed.length, true);
  endView.setUint16(10, packed.length, true);
  endView.setUint32(12, centralBytes, true);
  endView.setUint32(16, centralStart, true);
  endView.setUint16(20, 0, true);
  chunks.push(end);

  const zip = new Uint8Array(offset + end.byteLength);
  let cursor = 0;
  for (const chunk of chunks) {
    zip.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return zip;
}

/** MS-DOS date/time fields; the format has two-second resolution and starts in 1980. */
function dosDateTime(value: Date): DosDateTime {
  const year = Math.min(Math.max(value.getFullYear(), 1980), 2107);
  const date = ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate();
  const time = (value.getHours() << 11) | (value.getMinutes() << 5) | (value.getSeconds() >> 1);
  return { date, time };
}
