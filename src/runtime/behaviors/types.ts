import type { EntityId, JsonValue } from '@schema/index.js';

/**
 * Behavior contract (plan §10).
 *
 * Registered behaviors, not a large entity-component framework and not a visual
 * scripting language. The runtime needs exactly five predictable hooks: creation,
 * start, fixed update, frame update, and disposal. Property metadata lives in
 * `scripts/registry.json` and is mirrored here so the inspector, the validator, and the
 * build-time check all read one description.
 */

export type BehaviorPropertyType = 'number' | 'boolean' | 'text' | 'enum' | 'entity' | 'asset';

export interface BehaviorPropertyDescriptor {
  key: string;
  label: string;
  type: BehaviorPropertyType;
  /** Default used when a scene omits the property. */
  default: JsonValue;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Allowed values for `enum` properties. */
  options?: string[];
  /** Group heading in the inspector; advanced groups start collapsed. */
  group?: string;
}

export interface BehaviorContext {
  /** This behavior instance's entity. */
  readonly entityId: EntityId;
  /** Read the entity's current world transform into `out` (x, y, z, qx, qy, qz, qw). */
  readTransform(entityId: EntityId, out: Float32Array): boolean;
  readVelocity(entityId: EntityId, out: Float32Array): boolean;
  /** Move a kinematic body (characters move through the physics adapter, never around it). */
  moveKinematic(entityId: EntityId, position: [number, number, number], rotation: [number, number, number, number]): void;
  applyImpulse(entityId: EntityId, impulse: [number, number, number], point?: [number, number, number]): void;
  setLinearVelocity(entityId: EntityId, velocity: [number, number, number]): void;
  raycast(
    origin: [number, number, number],
    direction: [number, number, number],
    maxDistance: number,
  ): { hit: boolean; entityId: EntityId | null; distance: number; point: [number, number, number]; normal: [number, number, number] };
  /** Input actions, defined independently from key bindings. */
  isActionDown(action: string): boolean;
  wasActionPressed(action: string): boolean;
  wasActionReleased(action: string): boolean;
  /** Game state shared by behaviors and HUD bindings. */
  getState<T = JsonValue>(key: string): T | undefined;
  setState(key: string, value: JsonValue): void;
  /** Request a scene transition or a restart; applied after the current step. */
  requestScene(sceneId: string): void;
  requestRestart(): void;
  /** Runtime logging that lands in the editor console with the entity attached. */
  log(message: string, data?: JsonValue): void;
  /** Emit a named event other behaviors can subscribe to. */
  emit(event: string, payload?: JsonValue): void;
}

export interface BehaviorInstance {
  /** Called once after construction, before the first update. */
  start?(): void;
  /** Fixed-timestep update; the only place gameplay should mutate physics. */
  fixedUpdate?(fixedDelta: number): void;
  /** Per-frame update for camera smoothing and presentation. Never step physics here. */
  update?(frameDelta: number): void;
  /** Physics events involving this entity. */
  onPhysicsEvent?(event: {
    kind: 'begin' | 'end' | 'hit' | 'sensorBegin' | 'sensorEnd';
    other: EntityId | null;
    approachSpeed?: number;
    point?: [number, number, number];
    normal?: [number, number, number];
  }): void;
  /** Release listeners, audio, and any per-instance resources. */
  dispose?(): void;
}

export interface BehaviorDefinition {
  id: string;
  name: string;
  description: string;
  properties: BehaviorPropertyDescriptor[];
  create(context: BehaviorContext): BehaviorInstance;
}

/** A behavior registration with its metadata, as stored in `scripts/registry.json`. */
export interface BehaviorEntry {
  id: string;
  name: string;
  description: string;
  properties: BehaviorPropertyDescriptor[];
  /** Executable definition; absent in metadata-only contexts. */
  definition?: BehaviorDefinition;
  /** Source file the behavior was registered from, for error reporting. */
  source?: string;
}
