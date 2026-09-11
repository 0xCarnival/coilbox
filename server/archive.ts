import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Minimal tar + gzip archive support (plan §14, §4).
 *
 * Source-project export and import need one archive format and no third-party dependency, so
 * this is a small, strict ustar writer/reader. It deliberately supports only what project
 * archives contain — regular files and directories with a size limit — and refuses anything
 * else (symlinks, devices, absolute paths, `..` traversal) instead of extracting it.
 */

export interface ArchiveEntry {
  /** POSIX path inside the archive, no leading slash. */
  path: string;
  bytes: Uint8Array;
}

export interface ArchiveLimits {
  /** Maximum number of entries. */
  maxEntries: number;
  /** Maximum size of a single file after extraction. */
  maxEntryBytes: number;
  /** Maximum total uncompressed size. */
  maxTotalBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 5000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
};

export class ArchiveError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

const BLOCK_SIZE = 512;

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  for (let index = 0; index < length - 1; index += 1) target[offset + index] = text.charCodeAt(index);
  target[offset + length - 1] = 0;
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  let text = '';
  for (let index = 0; index < length; index += 1) {
    const byte = block[offset + index]!;
    if (byte === 0 || byte === 0x20) break;
    text += String.fromCharCode(byte);
  }
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

function writeString(target: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = new TextEncoder().encode(value);
  const length_ = Math.min(encoded.length, length);
  target.set(encoded.subarray(0, length_), offset);
}

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset + length;
  while (end > offset && block[end - 1] === 0) end -= 1;
  return new TextDecoder().decode(block.subarray(offset, end));
}

function headerFor(entry: ArchiveEntry, mode: number): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  const name = entry.path.length <= 100 ? entry.path : entry.path.slice(-100);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.bytes.byteLength);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  for (let index = 148; index < 156; index += 1) header[index] = 0x20;
  header[156] = mode === 0o755 ? '5'.charCodeAt(0) : '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar');
  header[262] = 0;
  writeString(header, 263, 2, '00');

  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeOctal(header, 148, 8, checksum);
  header[154] = 0x20;
  return header;
}

/** Build a gzipped tar from regular file entries. Paths are validated as relative. */
export function createTarGz(entries: ArchiveEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    assertSafeArchivePath(entry.path);
    chunks.push(headerFor(entry, 0o644));
    chunks.push(entry.bytes);
    const remainder = entry.bytes.byteLength % BLOCK_SIZE;
    if (remainder !== 0) chunks.push(new Uint8Array(BLOCK_SIZE - remainder));
  }
  // Two empty blocks terminate the archive.
  chunks.push(new Uint8Array(BLOCK_SIZE * 2));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Uint8Array(gzipSync(tar, { level: 6 }));
}

/** Read a gzipped tar, enforcing the limits. Refuses anything that is not a regular file. */
export function readTarGz(buffer: Uint8Array, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): ArchiveEntry[] {
  let tar: Uint8Array;
  try {
    tar = new Uint8Array(gunzipSync(buffer));
  } catch (cause) {
    throw new ArchiveError('invalid-archive', `the archive is not a gzipped tar: ${String(cause)}`);
  }
  if (tar.byteLength > limits.maxTotalBytes) {
    throw new ArchiveError('archive-too-large', `the archive expands to ${tar.byteLength} bytes, over the limit`);
  }

  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let total = 0;
  while (offset + BLOCK_SIZE <= tar.byteLength) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    const type = String.fromCharCode(header[156] ?? 0x30);
    const size = readOctal(header, 124, 12);
    offset += BLOCK_SIZE;

    if (type === '5' || path.endsWith('/')) {
      // Directory entry: nothing to store.
      continue;
    }
    if (type !== '0' && type !== '\0') {
      throw new ArchiveError(
        'unsupported-entry',
        `the archive contains a "${type}" entry (${path}); only regular files are supported`,
      );
    }
    if (size > limits.maxEntryBytes) {
      throw new ArchiveError('entry-too-large', `"${path}" is ${size} bytes, over the per-file limit`);
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new ArchiveError('archive-too-large', 'the archive contains more data than the limit allows');
    }
    if (entries.length >= limits.maxEntries) {
      throw new ArchiveError('too-many-entries', `the archive contains more than ${limits.maxEntries} files`);
    }

    const bytes = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    entries.push({ path: normalizeArchivePath(path), bytes: new Uint8Array(bytes) });
  }
  return entries;
}

/** Reject absolute paths, traversal, and Windows-style separators. */
export function assertSafeArchivePath(path: string): void {
  if (path.length === 0 || path.length > 512) {
    throw new ArchiveError('unsafe-path', `archive path "${path}" is empty or too long`);
  }
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw new ArchiveError('unsafe-path', `archive path "${path}" must be relative`);
  }
  if (path.includes('\\')) {
    throw new ArchiveError('unsafe-path', `archive path "${path}" must use forward slashes`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.' || segment.length === 0)) {
    throw new ArchiveError('unsafe-path', `archive path "${path}" contains an unsafe segment`);
  }
}

export function normalizeArchivePath(path: string): string {
  const cleaned = path.replace(/^\.\//, '').split('/').filter((segment) => segment.length > 0 && segment !== '.');
  assertSafeArchivePath(cleaned.join('/'));
  return cleaned.join('/');
}
