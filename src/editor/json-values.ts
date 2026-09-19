import type { JsonValue } from '@schema/index.js';

/**
 * Readers for JSON that arrived from outside the authored document's typed model: the workspace
 * service's responses and events, the layout remembered in browser storage, and the free-form
 * property bags the document format validates as JSON.
 *
 * Every `typeof` that narrows a representation lives in these predicates, which makes each one a
 * named type guard a reader can reuse instead of an ad-hoc check at the point of use. Nothing here
 * converts a value: a reader either narrows it or reports that it does not match.
 */

/** A JSON object: string keys, JSON values. */
export type JsonObject = { [key: string]: JsonValue };

/** A value parsed from JSON text, before anything has been read out of it. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === 'string';
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === 'boolean';
}

/** Finite JSON number: rejects NaN and ±Infinity, which the document format never stores. */
export function isFiniteJsonNumber(value: JsonValue | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The JSON value at `key`, or null when the payload is not an object or the key is absent. */
export function jsonField(payload: JsonValue, key: string): JsonValue {
  if (!isJsonObject(payload)) return null;
  return payload[key] ?? null;
}

/** A `[number, number, number]` read from a property bag; anything else yields null. */
export function jsonVec3(value: JsonValue | undefined): [number, number, number] | null {
  if (!Array.isArray(value)) return null;
  const [x, y, z] = value;
  return isFiniteJsonNumber(x) && isFiniteJsonNumber(y) && isFiniteJsonNumber(z) ? [x, y, z] : null;
}

export function jsonVec2(value: JsonValue | undefined): [number, number] | null {
  if (!Array.isArray(value)) return null;
  const [x, y] = value;
  return isFiniteJsonNumber(x) && isFiniteJsonNumber(y) ? [x, y] : null;
}

/** A normalised quaternion read from a property bag; anything else yields null. */
export function jsonQuaternion(value: JsonValue | undefined): [number, number, number, number] | null {
  if (!Array.isArray(value)) return null;
  const [x, y, z, w] = value;
  return isFiniteJsonNumber(x) && isFiniteJsonNumber(y) && isFiniteJsonNumber(z) && isFiniteJsonNumber(w)
    ? [x, y, z, w]
    : null;
}
