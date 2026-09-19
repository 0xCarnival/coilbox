import { z } from 'zod';
import {
  assetId,
  behaviorId,
  entityId,
  finiteNumber,
  hexColor,
  jsonObject,
  positiveVec3,
  quat,
  unitInterval,
  vec2,
  vec3,
} from './fields.js';

/**
 * Typed component union for scene entities (plan §7).
 *
 * Deliberately small: renderable primitive/model, material override, camera, light,
 * rigid body, collider, animation, audio, and behavior reference. A behavior stores a
 * registered ID plus serialisable properties — never a function or source string.
 */

export const primitiveShape = z.enum(['box', 'sphere', 'plane', 'capsule', 'cylinder']);
export type PrimitiveShape = z.infer<typeof primitiveShape>;

export const primitiveComponent = z.object({
  type: z.literal('primitive'),
  shape: primitiveShape,
  /** Full size in metres: box/plane = extents, sphere = diameter, capsule/cylinder = height. */
  size: positiveVec3,
  castShadow: z.boolean().default(true),
  receiveShadow: z.boolean().default(true),
});

export const modelComponent = z.object({
  type: z.literal('model'),
  assetId,
  castShadow: z.boolean().default(true),
  receiveShadow: z.boolean().default(true),
});

export const materialComponent = z.object({
  type: z.literal('material'),
  color: hexColor.default('#cccccc'),
  roughness: unitInterval.default(0.8),
  metalness: unitInterval.default(0),
  emissive: hexColor.default('#000000'),
  emissiveIntensity: finiteNumber.min(0).default(1),
  opacity: unitInterval.default(1),
  map: assetId.nullable().default(null),
  normalMap: assetId.nullable().default(null),
  emissiveMap: assetId.nullable().default(null),
  textureRepeat: vec2.default([1, 1]),
  textureOffset: vec2.default([0, 0]),
  transparent: z.boolean().default(false),
  doubleSided: z.boolean().default(false),
  flatShading: z.boolean().default(false),
  visible: z.boolean().default(true),
});

export const cameraMode = z.enum(['free', 'follow', 'fixed']);
export const cameraComponent = z.object({
  type: z.literal('camera'),
  mode: cameraMode.default('free'),
  fov: finiteNumber.min(1).max(179).default(60),
  near: finiteNumber.positive().default(0.1),
  far: finiteNumber.positive().default(1000),
  /** Entity the camera follows or looks at, depending on mode. */
  targetId: entityId.nullable().default(null),
  /** Follow-mode framing distances in metres. */
  distance: finiteNumber.min(0).default(8),
  height: finiteNumber.min(0).default(5),
  /** Fixed-mode world offset from the target. */
  offset: vec3.default([0, 0, 0]),
  /** Smoothing half-life in seconds; 0 disables smoothing. */
  damping: finiteNumber.min(0).default(0.12),
});

export const lightKind = z.enum(['directional', 'ambient', 'hemisphere', 'point', 'spot']);
export const lightComponent = z.object({
  type: z.literal('light'),
  kind: lightKind.default('directional'),
  color: hexColor.default('#ffffff'),
  intensity: finiteNumber.min(0).default(1),
  /** Ambient/hemisphere sky-to-ground tint. */
  groundColor: hexColor.default('#444444'),
  castShadow: z.boolean().default(false),
  shadowMapSize: z.union([z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096)]).default(1024),
  shadowBias: finiteNumber.default(-0.0005),
  /** Orthographic shadow-camera half-extent for directional lights, in metres. */
  shadowExtent: finiteNumber.positive().default(25),
  range: finiteNumber.positive().default(20),
  decay: finiteNumber.min(0).default(2),
  coneAngleDegrees: finiteNumber.min(1).max(89).default(30),
});

export const bodyType = z.enum(['static', 'dynamic', 'kinematic']);
export const rigidBodyComponent = z.object({
  type: z.literal('rigidBody'),
  bodyType: bodyType.default('dynamic'),
  /** null = derive mass from collider density. */
  mass: finiteNumber.positive().nullable().default(null),
  gravityScale: finiteNumber.default(1),
  linearDamping: finiteNumber.min(0).default(0),
  angularDamping: finiteNumber.min(0).default(0.05),
  /** Lock rotation (upright characters, crates that must not tip). */
  lockRotation: z.boolean().default(false),
  /** Continuous collision detection for fast movers. */
  continuous: z.boolean().default(false),
  /** Kinematic bodies follow their authored transform each tick. */
  moveWithPhysics: z.boolean().default(true),
});

export const colliderShape = z.enum(['box', 'sphere', 'capsule']);
export const colliderComponent = z.object({
  type: z.literal('collider'),
  shape: colliderShape.default('box'),
  /** Full extents in metres, before scaling; this is a bounds-fitted box, not an exact shape. */
  size: positiveVec3.default([1, 1, 1]),
  offset: vec3.default([0, 0, 0]),
  localRotation: quat.default([0, 0, 0, 1]),
  isSensor: z.boolean().default(false),
  friction: finiteNumber.min(0).default(0.6),
  restitution: unitInterval.default(0),
  density: finiteNumber.positive().default(1),
  /** Report collision events for this collider (sensors report touch events separately). */
  reportContacts: z.boolean().default(false),
});

export const animationComponent = z.object({
  type: z.literal('animation'),
  /** Clip name from the entity's model asset; null = first clip. */
  clip: z.string().nullable().default(null),
  playing: z.boolean().default(true),
  loop: z.boolean().default(true),
  /** Playback rate multiplier. */
  speed: finiteNumber.min(0).default(1),
  /** Start playing when the world starts (false = behavior-controlled). */
  autoplay: z.boolean().default(true),
});

export const audioComponent = z.object({
  type: z.literal('audio'),
  assetId,
  loop: z.boolean().default(false),
  autoplay: z.boolean().default(false),
  volume: unitInterval.default(1),
  spatial: z.boolean().default(false),
  maxDistance: finiteNumber.positive().default(20),
});

export const behaviorComponent = z.object({
  type: z.literal('behavior'),
  behaviorId,
  properties: jsonObject.default({}),
});

export const componentSchema = z.discriminatedUnion('type', [
  primitiveComponent,
  modelComponent,
  materialComponent,
  cameraComponent,
  lightComponent,
  rigidBodyComponent,
  colliderComponent,
  animationComponent,
  audioComponent,
  behaviorComponent,
]);

export type Component = z.infer<typeof componentSchema>;
export type ComponentType = Component['type'];
export type PrimitiveComponent = z.infer<typeof primitiveComponent>;
export type ModelComponent = z.infer<typeof modelComponent>;
export type MaterialComponent = z.infer<typeof materialComponent>;
export type CameraComponent = z.infer<typeof cameraComponent>;
export type LightComponent = z.infer<typeof lightComponent>;
export type RigidBodyComponent = z.infer<typeof rigidBodyComponent>;
export type ColliderComponent = z.infer<typeof colliderComponent>;
export type AnimationComponent = z.infer<typeof animationComponent>;
export type AudioComponent = z.infer<typeof audioComponent>;
export type BehaviorComponent = z.infer<typeof behaviorComponent>;

export const COMPONENT_TYPES: ComponentType[] = [
  'primitive',
  'model',
  'material',
  'camera',
  'light',
  'rigidBody',
  'collider',
  'animation',
  'audio',
  'behavior',
];

/** Human-facing labels used by the inspector and the Add Component menu. */
export const COMPONENT_LABELS: Record<ComponentType, string> = {
  primitive: 'Primitive',
  model: 'Model',
  material: 'Material',
  camera: 'Camera',
  light: 'Light',
  rigidBody: 'Rigid Body',
  collider: 'Collider',
  animation: 'Animation',
  audio: 'Audio',
  behavior: 'Behavior',
};
