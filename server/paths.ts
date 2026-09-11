import { realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { JsonValue } from '@schema/index.js';
import { isJsonString } from './json.js';

/**
 * Path safety for the workspace service (plan §13): every path the browser can influence
 * must stay inside the configured workspace, with no traversal and no symlink escape.
 */

export class UnsafePathError extends Error {
  readonly requested: string;

  constructor(requested: string, message: string) {
    super(message);
    this.name = 'UnsafePathError';
    this.requested = requested;
  }
}

/** Project ids and scene ids become path segments, so they are deliberately narrow. */
const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Validate one path segment.
 *
 * Ids reach the service from routes, JSON bodies, and the CLI, so the value is treated as unparsed:
 * anything that is not a string is refused with the same `UnsafePathError` an unsafe string
 * produces, instead of reaching `node:path` as a number or `undefined`.
 */
export function assertSafeSegment(value: JsonValue, label: string): string {
  if (!isJsonString(value) || value.length === 0 || value.length > 128) {
    throw new UnsafePathError(String(value), `${label} must be 1-128 characters`);
  }
  if (!SEGMENT_PATTERN.test(value) || value.includes('..')) {
    throw new UnsafePathError(value, `${label} "${value}" contains unsupported characters`);
  }
  return value;
}

/**
 * Resolve `segments` inside `root`, refusing anything that escapes it.
 *
 * `allowMissing` permits paths that do not exist yet (project creation); when the path
 * exists its real path is checked, which also catches symlinks pointing outside.
 */
export async function resolveInside(root: string, segments: string[], options: { allowMissing?: boolean } = {}): Promise<string> {
  const realRoot = await realpath(resolve(root)).catch(() => resolve(root));
  const candidate = resolve(join(realRoot, ...segments));
  if (candidate !== realRoot && !candidate.startsWith(realRoot + sep)) {
    throw new UnsafePathError(candidate, 'path escapes the workspace directory');
  }
  if (existsSync(candidate)) {
    const realCandidate = await realpath(candidate);
    if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
      throw new UnsafePathError(candidate, 'path resolves outside the workspace directory (symlink escape)');
    }
    return realCandidate;
  }
  if (!options.allowMissing) {
    throw new UnsafePathError(candidate, 'path does not exist');
  }
  return candidate;
}

/** Project-relative POSIX path used inside documents (`scenes/main.scene.json`). */
export function toProjectRelative(projectRoot: string, absolutePath: string): string {
  const value = relative(projectRoot, absolutePath).split(sep).join('/');
  return normalize(value).split(sep).join('/');
}

/** Reject a document-supplied relative path that is absolute or climbs upward. */
export function assertProjectRelative(relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new UnsafePathError(relativePath, 'paths inside a project must be relative');
  }
  const normalized = normalize(relativePath).split(sep).join('/');
  if (normalized.startsWith('..') || normalized.includes('../')) {
    throw new UnsafePathError(relativePath, 'paths inside a project cannot traverse upward');
  }
  return normalized;
}
