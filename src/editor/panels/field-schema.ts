import type { Component, ComponentType } from '@schema/index.js';
import { COMPONENT_LABELS } from '@schema/index.js';

/**
 * Inspector field descriptions.
 *
 * One description drives the rendered control, the validation hint, and the property name
 * written by the command. Labels are the words an author uses ("Move speed", "Collision
 * shape"), and advanced rendering/physics fields start collapsed (plan §3).
 */

export type FieldKind =
  | 'number'
  | 'boolean'
  | 'text'
  | 'color'
  | 'enum'
  | 'vec3'
  | 'positive-vec3'
  | 'quaternion-degrees'
  | 'entity-reference'
  | 'asset-reference'
  | 'clip-reference';

export interface FieldDescriptor {
  key: string;
  label: string;
  kind: FieldKind;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
  /** Advanced fields are collapsed by default. */
  advanced?: boolean;
}

export interface ComponentDescriptor {
  type: ComponentType;
  label: string;
  /** Short line shown in the component header. */
  summary: (component: Component) => string;
  fields: FieldDescriptor[];
  /** Component types that may only appear once per entity. */
  singleton: boolean;
}

const shadowField: FieldDescriptor = { key: 'castShadow', label: 'Cast shadow', kind: 'boolean' };

export const COMPONENT_DESCRIPTORS: Record<ComponentType, ComponentDescriptor> = {
  primitive: {
    type: 'primitive',
    label: 'Shape',
    singleton: true,
    summary: (component) => (component.type === 'primitive' ? `${component.shape} ${component.size.join(' x ')} m` : ''),
    fields: [
      {
        key: 'shape',
        label: 'Shape',
        kind: 'enum',
        options: [
          { value: 'box', label: 'Box' },
          { value: 'sphere', label: 'Sphere' },
          { value: 'plane', label: 'Plane' },
          { value: 'capsule', label: 'Capsule' },
          { value: 'cylinder', label: 'Cylinder' },
        ],
      },
      { key: 'size', label: 'Size (m)', kind: 'positive-vec3' },
      shadowField,
      { key: 'receiveShadow', label: 'Receive shadow', kind: 'boolean' },
    ],
  },
  model: {
    type: 'model',
    label: 'Model',
    singleton: true,
    summary: (component) => (component.type === 'model' ? component.assetId : ''),
    fields: [
      { key: 'assetId', label: 'Asset', kind: 'asset-reference', help: 'Import a .glb in the Assets tab, then choose it here.' },
      shadowField,
      { key: 'receiveShadow', label: 'Receive shadow', kind: 'boolean' },
    ],
  },
  material: {
    type: 'material',
    label: 'Material',
    singleton: false,
    summary: (component) => (component.type === 'material' ? component.color : ''),
    fields: [
      { key: 'color', label: 'Colour', kind: 'color' },
      { key: 'roughness', label: 'Roughness', kind: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'metalness', label: 'Metalness', kind: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'opacity', label: 'Opacity', kind: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'emissive', label: 'Emissive', kind: 'color', advanced: true },
      { key: 'emissiveIntensity', label: 'Emissive intensity', kind: 'number', min: 0, step: 0.1, advanced: true },
      { key: 'transparent', label: 'Transparent', kind: 'boolean', advanced: true },
      { key: 'doubleSided', label: 'Double sided', kind: 'boolean', advanced: true },
      { key: 'flatShading', label: 'Flat shading', kind: 'boolean', advanced: true },
    ],
  },
  camera: {
    type: 'camera',
    label: 'Camera',
    singleton: true,
    summary: (component) => (component.type === 'camera' ? `${component.mode} · ${component.fov}°` : ''),
    fields: [
      {
        key: 'mode',
        label: 'Mode',
        kind: 'enum',
        options: [
          { value: 'free', label: 'Free (authored transform)' },
          { value: 'follow', label: 'Follow a target' },
          { value: 'fixed', label: 'Fixed offset from a target' },
        ],
      },
      { key: 'targetId', label: 'Target', kind: 'entity-reference', help: 'Used by follow and fixed modes.' },
      { key: 'distance', label: 'Distance', kind: 'number', min: 0, step: 0.5 },
      { key: 'height', label: 'Height', kind: 'number', min: 0, step: 0.5 },
      { key: 'damping', label: 'Smoothing', kind: 'number', min: 0, step: 0.02 },
      { key: 'fov', label: 'Field of view', kind: 'number', min: 1, max: 179, step: 1 },
      { key: 'near', label: 'Near plane', kind: 'number', min: 0.001, step: 0.05, advanced: true },
      { key: 'far', label: 'Far plane', kind: 'number', min: 1, step: 10, advanced: true },
      { key: 'offset', label: 'Offset', kind: 'vec3', advanced: true },
    ],
  },
  light: {
    type: 'light',
    label: 'Light',
    singleton: true,
    summary: (component) => (component.type === 'light' ? `${component.kind} · ${component.intensity}` : ''),
    fields: [
      {
        key: 'kind',
        label: 'Type',
        kind: 'enum',
        options: [
          { value: 'directional', label: 'Directional (sun)' },
          { value: 'ambient', label: 'Ambient' },
          { value: 'hemisphere', label: 'Hemisphere' },
          { value: 'point', label: 'Point' },
          { value: 'spot', label: 'Spot' },
        ],
      },
      { key: 'color', label: 'Colour', kind: 'color' },
      { key: 'intensity', label: 'Intensity', kind: 'number', min: 0, step: 0.1 },
      { key: 'groundColor', label: 'Ground colour', kind: 'color' },
      shadowField,
      { key: 'shadowMapSize', label: 'Shadow resolution', kind: 'enum', options: [512, 1024, 2048, 4096].map((size) => ({ value: String(size), label: `${size} x ${size}` })), advanced: true },
      { key: 'shadowExtent', label: 'Shadow extent (m)', kind: 'number', min: 1, step: 1, advanced: true },
      { key: 'shadowBias', label: 'Shadow bias', kind: 'number', step: 0.0001, advanced: true },
      { key: 'range', label: 'Range (m)', kind: 'number', min: 0.1, step: 1, advanced: true },
      { key: 'decay', label: 'Decay', kind: 'number', min: 0, step: 0.5, advanced: true },
      { key: 'coneAngleDegrees', label: 'Cone angle', kind: 'number', min: 1, max: 89, step: 1, advanced: true },
    ],
  },
  rigidBody: {
    type: 'rigidBody',
    label: 'Rigid body',
    singleton: true,
    summary: (component) => (component.type === 'rigidBody' ? component.bodyType : ''),
    fields: [
      {
        key: 'bodyType',
        label: 'Body type',
        kind: 'enum',
        options: [
          { value: 'static', label: 'Static (never moves)' },
          { value: 'dynamic', label: 'Dynamic (physics moves it)' },
          { value: 'kinematic', label: 'Kinematic (code moves it)' },
        ],
      },
      { key: 'gravityScale', label: 'Gravity scale', kind: 'number', step: 0.1 },
      { key: 'lockRotation', label: 'Lock rotation', kind: 'boolean' },
      { key: 'mass', label: 'Mass (kg)', kind: 'number', min: 0.001, step: 0.1, advanced: true, help: 'Empty uses the collider density.' },
      { key: 'linearDamping', label: 'Linear damping', kind: 'number', min: 0, step: 0.05, advanced: true },
      { key: 'angularDamping', label: 'Angular damping', kind: 'number', min: 0, step: 0.05, advanced: true },
      { key: 'continuous', label: 'Continuous collision', kind: 'boolean', advanced: true },
    ],
  },
  collider: {
    type: 'collider',
    label: 'Collider',
    singleton: true,
    summary: (component) => (component.type === 'collider' ? `${component.shape} ${component.size.join(' x ')} m` : ''),
    fields: [
      {
        key: 'shape',
        label: 'Collision shape',
        kind: 'enum',
        options: [
          { value: 'box', label: 'Box (bounds-fitted)' },
          { value: 'sphere', label: 'Sphere' },
          { value: 'capsule', label: 'Capsule' },
        ],
      },
      { key: 'size', label: 'Size (m)', kind: 'positive-vec3', help: 'A fitted box, not an exact shape.' },
      { key: 'offset', label: 'Offset (m)', kind: 'vec3' },
      { key: 'isSensor', label: 'Sensor (no collision response)', kind: 'boolean' },
      { key: 'friction', label: 'Friction', kind: 'number', min: 0, step: 0.05 },
      { key: 'restitution', label: 'Bounciness', kind: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'density', label: 'Density', kind: 'number', min: 0.001, step: 0.1, advanced: true },
      { key: 'reportContacts', label: 'Report contacts', kind: 'boolean', advanced: true },
      { key: 'localRotation', label: 'Local rotation', kind: 'quaternion-degrees', advanced: true },
    ],
  },
  animation: {
    type: 'animation',
    label: 'Animation',
    singleton: true,
    summary: (component) => (component.type === 'animation' ? component.clip ?? 'first clip' : ''),
    fields: [
      { key: 'clip', label: 'Clip', kind: 'clip-reference', help: 'Empty plays the first clip in the model.' },
      { key: 'playing', label: 'Playing', kind: 'boolean' },
      { key: 'loop', label: 'Loop', kind: 'boolean' },
      { key: 'speed', label: 'Speed', kind: 'number', min: 0, step: 0.1 },
      { key: 'autoplay', label: 'Play on start', kind: 'boolean' },
    ],
  },
  audio: {
    type: 'audio',
    label: 'Audio',
    singleton: true,
    summary: (component) => (component.type === 'audio' ? component.assetId : ''),
    fields: [
      { key: 'assetId', label: 'Asset', kind: 'asset-reference' },
      { key: 'volume', label: 'Volume', kind: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'loop', label: 'Loop', kind: 'boolean' },
      { key: 'autoplay', label: 'Play on start', kind: 'boolean' },
      { key: 'spatial', label: '3D sound', kind: 'boolean', advanced: true },
    ],
  },
  behavior: {
    type: 'behavior',
    label: 'Behavior',
    singleton: false,
    summary: (component) => (component.type === 'behavior' ? component.behaviorId : ''),
    fields: [],
  },
};

/** Rotation is stored as a quaternion and presented in degrees (plan §7). */
export function quaternionToEulerDegrees(quaternion: readonly number[]): [number, number, number] {
  const [x, y, z, w] = quaternion as [number, number, number, number];
  const sinrCosp = 2 * (w * x + y * z);
  const cosrCosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinrCosp, cosrCosp);
  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
  const sinyCosp = 2 * (w * z + x * y);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(sinyCosp, cosyCosp);
  return [radiansToDegrees(roll), radiansToDegrees(pitch), radiansToDegrees(yaw)];
}

export function eulerDegreesToQuaternion(degrees: readonly number[]): [number, number, number, number] {
  const [roll, pitch, yaw] = [degreesToRadians(degrees[0] ?? 0), degreesToRadians(degrees[1] ?? 0), degreesToRadians(degrees[2] ?? 0)];
  const c1 = Math.cos(roll / 2);
  const c2 = Math.cos(pitch / 2);
  const c3 = Math.cos(yaw / 2);
  const s1 = Math.sin(roll / 2);
  const s2 = Math.sin(pitch / 2);
  const s3 = Math.sin(yaw / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function componentLabel(component: Component): string {
  return COMPONENT_DESCRIPTORS[component.type]?.label ?? COMPONENT_LABELS[component.type] ?? component.type;
}
