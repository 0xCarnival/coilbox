import { z } from 'zod';
import type { JsonValue } from './primitives.js';

/** Finite number: rejects NaN and ±Infinity, which would corrupt transforms and physics. */
export const finiteNumber = z.number().finite();

export const vec3 = z.tuple([finiteNumber, finiteNumber, finiteNumber]);
export const vec2 = z.tuple([finiteNumber, finiteNumber]);
export const quat = z
  .tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber])
  .refine((q) => Math.abs(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] - 1) < 1e-3, {
    message: 'rotation quaternion must be normalised',
  });

/** Positive, non-zero vector component (sizes, extents). */
export const positiveVec3 = z.tuple([
  finiteNumber.positive(),
  finiteNumber.positive(),
  finiteNumber.positive(),
]);

export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');

export const unitInterval = finiteNumber.min(0).max(1);

export const entityId = z.string().min(1).max(128);
export const assetId = z.string().min(1).max(128);
export const behaviorId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'behavior ids are lowercase kebab/dot ids');

/**
 * An arbitrary authored JSON value.
 *
 * Both type arguments name the same domain on purpose: the schema accepts exactly the JSON forms
 * and produces exactly the JSON forms, so `z.input` and `z.infer` of a document that carries a
 * `jsonObject` (behavior properties, HUD state, asset metadata) stay JSON-representable. Annotating
 * it as `z.ZodType<unknown>` would erase that and make an authored document — or anything built from
 * `JSON.parse` — refuse to typecheck against `JsonValue` (see `validate.ts`).
 */
export const jsonValue: z.ZodType<JsonValue, JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

export const jsonObject = z.record(z.string(), jsonValue);
