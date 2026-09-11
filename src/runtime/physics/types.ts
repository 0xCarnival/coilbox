import type { Vec3, Quat } from '@schema/primitives.js';

/**
 * Backend-agnostic physics interface used by the runtime (plan §5).
 *
 * `runtime/physics/box3d-adapter.ts` is the only module allowed to import the vendor
 * binding. Everything else talks to these types, so the engine can be replaced or a
 * second backend added without touching gameplay code.
 */

export type PhysicsBodyType = 'static' | 'dynamic' | 'kinematic';

export type ColliderShapeSpec =
  | { kind: 'box'; halfExtents: Vec3 }
  | { kind: 'sphere'; radius: number }
  | { kind: 'capsule'; halfHeight: number; radius: number };

export interface ColliderSpec {
  shape: ColliderShapeSpec;
  /** Local offset from the body origin, in metres. */
  offset: Vec3;
  /** Local rotation of the collider, normalised quaternion. */
  rotation: Quat;
  density: number;
  friction: number;
  restitution: number;
  isSensor: boolean;
  /** Report begin/end touch events for this collider (sensors and non-sensors alike). */
  reportContacts: boolean;
  /** Report hit events (impact speed above the world hit threshold). */
  reportHits: boolean;
}

export interface PhysicsBodySpec {
  /** Caller-owned identity (scene entity id). */
  key: string;
  bodyType: PhysicsBodyType;
  position: Vec3;
  rotation: Quat;
  gravityScale: number;
  linearDamping: number;
  angularDamping: number;
  continuous: boolean;
  /** Lock angular motion around all axes. */
  lockRotation: boolean;
  colliders: ColliderSpec[];
}

export interface PhysicsWorldOptions {
  gravity: Vec3;
  fixedTimeStep: number;
  /** Solver sub-steps per fixed step. */
  subStepCount: number;
  enableSleep: boolean;
  hitEventThreshold: number;
}

export interface ContactEvent {
  /** Entity keys of the two bodies involved, or null when the shape is unknown. */
  a: string | null;
  b: string | null;
  kind: 'begin' | 'end' | 'hit' | 'sensorBegin' | 'sensorEnd';
  /** Impact speed for `hit` events, metres per second. */
  approachSpeed?: number;
  /** Contact point for `hit` events, world space. */
  point?: Vec3;
  /** Contact normal for `hit` events, world space. */
  normal?: Vec3;
}

export interface PhysicsCounters {
  bodyCount: number;
  shapeCount: number;
  contactCount: number;
  jointCount: number;
  islandCount: number;
  awakeBodyCount: number;
  /** Bytes currently allocated by the physics world. May not shrink after teardown. */
  byteCount: number;
}

export interface RaycastHit {
  hit: boolean;
  /** Entity key of the hit collider's body, when known. */
  key: string | null;
  distance: number;
  point: Vec3;
  normal: Vec3;
}

export interface PhysicsWorldHandle {
  readonly id: number;
  readonly disposed: boolean;
  createBody(spec: PhysicsBodySpec): void;
  destroyBody(key: string): void;
  hasBody(key: string): boolean;
  /** Advance the simulation by exactly one fixed step. */
  step(): void;
  getBodyCount(): number;
  /** Write the body's interpolatable transform into the caller's array (no allocation). */
  readTransform(key: string, out: Float32Array): boolean;
  readVelocity(key: string, out: Float32Array): boolean;
  setTransform(key: string, position: Vec3, rotation: Quat): void;
  setLinearVelocity(key: string, velocity: Vec3): void;
  setAngularVelocity(key: string, velocity: Vec3): void;
  setBodyType(key: string, type: PhysicsBodyType): void;
  /** Disable or re-enable a body without destroying it (collected pickups, opened doors). */
  setBodyEnabled(key: string, enabled: boolean): void;
  applyImpulse(key: string, impulse: Vec3, point?: Vec3): void;
  applyForce(key: string, force: Vec3, point?: Vec3): void;
  /** Drain physics events accumulated since the previous drain. */
  drainEvents(): ContactEvent[];
  raycastClosest(origin: Vec3, direction: Vec3, maxDistance: number): RaycastHit;
  getCounters(): PhysicsCounters;
  dispose(): void;
}

export interface PhysicsBackend {
  readonly name: string;
  readonly version: string;
  readonly doublePrecision: boolean;
  /** Number of live worlds; used by teardown tests to prove cleanup. */
  getWorldCount(): number;
  /** Bytes allocated by the WASM module across all worlds. */
  getByteCount(): number;
  createWorld(options: PhysicsWorldOptions): PhysicsWorldHandle;
}

export const EMPTY_COUNTERS: PhysicsCounters = {
  bodyCount: 0,
  shapeCount: 0,
  contactCount: 0,
  jointCount: 0,
  islandCount: 0,
  awakeBodyCount: 0,
  byteCount: 0,
};
