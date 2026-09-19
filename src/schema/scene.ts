import { z } from 'zod';
import { componentSchema } from './components.js';
import { entityId, finiteNumber, hexColor, quat, vec3 } from './fields.js';

/**
 * Scene document (plan §7).
 *
 * A scene stores stable entity IDs, display names, parent IDs, local transforms,
 * explicit sibling order, enabled state, and typed component records. It also names
 * the active game camera. Editor-only visibility/locking is kept apart from `enabled`
 * so hiding a helper never disables gameplay content.
 */

export const SCENE_SCHEMA_VERSION = 1;

export const transformSchema = z.object({
  position: vec3.default([0, 0, 0]),
  /** Normalised quaternion [x, y, z, w]. */
  rotation: quat.default([0, 0, 0, 1]),
  scale: vec3.default([1, 1, 1]),
});

export const editorStateSchema = z.object({
  /** Editor-only visibility. Does not affect gameplay. */
  visible: z.boolean().default(true),
  /** Editor-only lock. Prevents accidental selection/transform. */
  locked: z.boolean().default(false),
  /** Optional folder colour used by the hierarchy tree. */
  color: hexColor.nullable().default(null),
  /** Editor-only helper flag (grid markers, spawn points) — never gameplay content. */
  helper: z.boolean().default(false),
});

export const entitySchema = z.object({
  id: entityId,
  name: z.string().min(1).max(200),
  parentId: entityId.nullable().default(null),
  /** Explicit sibling order within the parent. */
  order: finiteNumber.default(0),
  /** Whether the entity participates in the game at all. */
  enabled: z.boolean().default(true),
  transform: transformSchema.prefault({}),
  components: z.array(componentSchema).default([]),
  editor: editorStateSchema.prefault({}),
});

export const fogSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('linear'),
    color: hexColor.default('#dfe6ee'),
    near: finiteNumber.min(0).default(10),
    far: finiteNumber.min(0).default(80),
  }),
  z.object({
    type: z.literal('exponential'),
    color: hexColor.default('#dfe6ee'),
    density: finiteNumber.min(0).default(0.02),
  }),
]);

/**
 * The procedural sky: an atmosphere shaded from a sun direction. It is a document setting rather
 * than an asset so a game gets a believable sky and image-based lighting without importing an HDR.
 */
export const skySchema = z.object({
  /** Sun height above the horizon in degrees; below zero is dusk. */
  elevation: finiteNumber.min(-10).max(90).default(20),
  /** Sun heading in degrees, clockwise from +Z. */
  azimuth: finiteNumber.min(0).max(360).default(180),
  /** Haze, 1 (clear) to 20 (overcast). */
  turbidity: finiteNumber.min(1).max(20).default(6),
  /** Blue-sky scattering, 0 to 4. */
  rayleigh: finiteNumber.min(0).max(4).default(1.5),
});

/**
 * Image-based lighting applied to every PBR material: `studio` is a neutral indoor light box,
 * `sky` lights the scene from the procedural sky above (so the sun's colour reaches the ground).
 */
export const environmentLightingSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('studio'), intensity: finiteNumber.min(0).max(10).default(1) }),
  z.object({ type: z.literal('sky'), intensity: finiteNumber.min(0).max(10).default(1) }),
]);

export const environmentSchema = z.object({
  background: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('color'), color: hexColor.default('#202431') }),
      z.object({ type: z.literal('sky'), blur: finiteNumber.min(0).max(1).default(0) }),
      z.object({ type: z.literal('none') }),
    ])
    .default({ type: 'color', color: '#202431' }),
  sky: skySchema.prefault({}),
  lighting: environmentLightingSchema.default({ type: 'none' }),
  fog: fogSchema.default({ type: 'none' }),
  /** Scene-level gravity in metres per second squared. */
  gravity: vec3.default([0, -9.81, 0]),
});

export const sceneSchema = z.object({
  schemaVersion: z.number().int().positive(),
  /** Document revision, used to detect concurrent edits. Distinct from schemaVersion. */
  revision: finiteNumber.int().min(0).default(0),
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  /** Entity used as the game camera; null falls back to the first camera entity. */
  activeCameraId: entityId.nullable().default(null),
  environment: environmentSchema.prefault({}),
  entities: z.array(entitySchema).default([]),
});

export type Transform = z.infer<typeof transformSchema>;
export type EditorState = z.infer<typeof editorStateSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type SceneDocument = z.infer<typeof sceneSchema>;
export type SceneDocumentInput = z.input<typeof sceneSchema>;
export type Environment = z.infer<typeof environmentSchema>;
export type Fog = z.infer<typeof fogSchema>;
export type Sky = z.infer<typeof skySchema>;
export type EnvironmentLighting = z.infer<typeof environmentLightingSchema>;
