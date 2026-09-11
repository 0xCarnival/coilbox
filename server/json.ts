import type { JsonValue } from '@schema/index.js';

/**
 * The workspace service's JSON boundary.
 *
 * Every document the service reads from disk or receives over HTTP arrives as text. `parseJson`
 * turns that text into `JsonValue` — the schema's own contract for unparsed JSON — so the modules
 * below branch on parsed values instead of re-checking the representation with ad-hoc `typeof`.
 */

/** A JSON object: the one shape `JsonValue` needs named separately for type predicates. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Parse JSON text. Malformed text throws a `SyntaxError`, exactly as `JSON.parse` does, so each
 * caller keeps mapping that failure to its own error code and message.
 */
export function parseJson(text: string): JsonValue {
  // SAFETY: JSON.parse either throws or returns a value built only from null, booleans, finite
  // numbers, strings, arrays of those, and plain objects of those — which is exactly JsonValue.
  return JSON.parse(text) as JsonValue;
}

/** Whether the value is a JSON object: an object that is neither null nor an array. */
export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the value is a JSON string. */
export function isJsonString(value: JsonValue): value is string {
  return typeof value === 'string';
}

/** Whether the value is a JSON number. */
export function isJsonNumber(value: JsonValue): value is number {
  return typeof value === 'number';
}

function isJsonArray(value: JsonValue): value is JsonValue[] {
  return Array.isArray(value);
}

/** The string at `key` of a JSON object; `undefined` for any other value. */
export function jsonString(value: JsonValue, key: string): string | undefined {
  if (!isJsonObject(value)) return undefined;
  const field = value[key];
  return isJsonString(field) ? field : undefined;
}

/** The number at `key` of a JSON object; `undefined` for any other value. */
export function jsonNumber(value: JsonValue, key: string): number | undefined {
  if (!isJsonObject(value)) return undefined;
  const field = value[key];
  return isJsonNumber(field) ? field : undefined;
}

/** The array at `key` of a JSON object; `undefined` when the key is absent or holds anything else. */
export function jsonArray(value: JsonValue, key: string): JsonValue[] | undefined {
  if (!isJsonObject(value)) return undefined;
  const field = value[key];
  return isJsonArray(field) ? field : undefined;
}
