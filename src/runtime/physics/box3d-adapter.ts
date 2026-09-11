/**
 * Box3D adapter — the only module in the studio allowed to import the vendor binding.
 *
 * Binding: `box3d.js@0.1.1` (isaac-mason/box3d.js), non-multithreaded build, MIT.
 * Docs and types: node_modules/box3d.js/dist/box3d.d.ts
 *
 * Ownership rules followed here (plan §9):
 * - The world owns bodies and shapes; `b3DestroyWorld` tears the whole graph down.
 * - The events buffer is a separate allocation and is explicitly destroyed on dispose.
 * - Hulls built for offset box colliders are temporary and destroyed right after the
 *   shape copies them.
 * - Every handle handed to callers is a plain number; vendor structs never escape.
 *
 * Engine quirks discovered by probing `box3d.js@0.1.1` (recorded so they are not
 * rediscovered later):
 * - `b3CreateBoxShape` has no offset/rotation parameter: a box collider is always
 *   centred on the body origin. Offset or rotated boxes go through a transformed hull.
 * - `b3CreateSphereShape` and `b3CreateCapsuleShape` do take local centres, so no hull
 *   is needed for offset spheres/capsules; capsule rotation is baked into the centres.
 * - Shape density is set on the shape definition; there is no separate mass call needed.
 * - Sensor touch events need `enableSensorEvents` on both the sensor shape and the
 *   visitor shape, so the flag is set on every shape.
 * - `b3World_CastRayClosest` takes a displacement vector, so the caller's normalised
 *   direction is multiplied by the maximum distance before the call.
 */

import Box3DFactory, { type Box3DModule, type b3BodyId, type b3ShapeId, type b3WorldId } from 'box3d.js';
import type { Quat, Vec3 } from '@schema/primitives.js';
import type {
  ColliderShapeSpec,
  ContactEvent,
  PhysicsBackend,
  PhysicsBodySpec,
  PhysicsBodyType,
  PhysicsCounters,
  PhysicsWorldHandle,
  MoverCastRequest,
  MoverCastResult,
  PhysicsWorldOptions,
  RaycastHit,
} from './types.js';

export const BOX3D_BINDING = 'box3d.js@0.1.1';

let modulePromise: Promise<Box3DModule> | null = null;

/**
 * Load (once) and return the Box3D WASM module.
 *
 * `locateFile` lets the bundler place `box3d.wasm` wherever it likes — Vite emits it
 * as an asset and the caller passes the emitted URL through. With no options the
 * binding falls back to its own `new URL('box3d.wasm', import.meta.url)` lookup,
 * which only works when the module file sits next to the wasm file.
 */
export function loadBox3D(options?: { locateFile?: (path: string) => string }): Promise<Box3DModule> {
  if (!modulePromise) {
    modulePromise = Box3DFactory(options ? { locateFile: options.locateFile } : {}).catch((cause: unknown) => {
      modulePromise = null;
      throw new Error(`Failed to initialise Box3D WASM (${BOX3D_BINDING}): ${String(cause)}`);
    });
  }
  return modulePromise;
}

/** Test hook: drop the cached module so a fresh WASM instance can be created. */
export function resetBox3DModuleForTests(): void {
  modulePromise = null;
}

function shapeKeyOf(shape: b3ShapeId): string {
  return `${shape.world0}:${shape.index1}:${shape.generation}`;
}

function bodyKeyOf(body: b3BodyId): string {
  return `${body.world0}:${body.index1}:${body.generation}`;
}

const EPSILON = 1e-6;

function isZero(v: Vec3): boolean {
  return Math.abs(v[0]) < EPSILON && Math.abs(v[1]) < EPSILON && Math.abs(v[2]) < EPSILON;
}

function isIdentityQuat(q: Quat): boolean {
  return Math.abs(q[0]) < EPSILON && Math.abs(q[1]) < EPSILON && Math.abs(q[2]) < EPSILON && Math.abs(Math.abs(q[3]) - 1) < EPSILON;
}

/** Rotate a vector by a normalised quaternion. */
function rotateVec(q: Quat, v: Vec3, out: [number, number, number]): [number, number, number] {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 * (q_vec x v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
  return out;
}

class Box3DWorld implements PhysicsWorldHandle {
  readonly id: number;
  private readonly module: Box3DModule;
  private readonly worldId: b3WorldId;
  private readonly events: ReturnType<Box3DModule['createEventsBuffer']>;
  private readonly options: PhysicsWorldOptions;

  private readonly bodies = new Map<string, b3BodyId>();
  private readonly bodyKeys = new Map<string, string>();
  private readonly shapeKeys = new Map<string, string>();
  private readonly sensorShapes = new Set<string>();

  // Reusable scratch values: the adapter must not allocate on the hot path.
  private readonly scratchVec: [number, number, number] = [0, 0, 0];
  private readonly scratchQuat: [number, number, number, number] = [0, 0, 0, 1];
  private readonly scratchAxis: [number, number, number] = [0, 0, 0];
  private readonly contactBeginOut: ReturnType<Box3DModule['createContactTouchEvent']>;
  private readonly contactEndOut: ReturnType<Box3DModule['createContactTouchEvent']>;
  private readonly contactHitOut: ReturnType<Box3DModule['createContactHitEvent']>;
  private readonly sensorBeginOut: ReturnType<Box3DModule['createSensorTouchEvent']>;
  private readonly sensorEndOut: ReturnType<Box3DModule['createSensorTouchEvent']>;

  private isDisposed = false;

  constructor(module: Box3DModule, options: PhysicsWorldOptions) {
    this.module = module;
    this.options = options;
    const worldDef = module.b3DefaultWorldDef();
    worldDef.gravity = [options.gravity[0], options.gravity[1], options.gravity[2]];
    worldDef.enableSleep = options.enableSleep;
    worldDef.hitEventThreshold = options.hitEventThreshold;
    this.worldId = module.b3CreateWorld(worldDef);
    if (!module.b3World_IsValid(this.worldId)) {
      throw new Error('Box3D refused to create a physics world');
    }
    this.id = this.worldId.index1;
    this.events = module.createEventsBuffer();
    this.contactBeginOut = module.createContactTouchEvent();
    this.contactEndOut = module.createContactTouchEvent();
    this.contactHitOut = module.createContactHitEvent();
    this.sensorBeginOut = module.createSensorTouchEvent();
    this.sensorEndOut = module.createSensorTouchEvent();
  }

  createBody(spec: PhysicsBodySpec): void {
    this.assertLive();
    if (this.bodies.has(spec.key)) {
      throw new Error(`physics body for "${spec.key}" already exists`);
    }
    const m = this.module;
    const def = m.b3DefaultBodyDef();
    def.type =
      spec.bodyType === 'static'
        ? m.b3BodyType.b3_staticBody
        : spec.bodyType === 'kinematic'
          ? m.b3BodyType.b3_kinematicBody
          : m.b3BodyType.b3_dynamicBody;
    def.position = [spec.position[0], spec.position[1], spec.position[2]];
    def.rotation = [spec.rotation[0], spec.rotation[1], spec.rotation[2], spec.rotation[3]];
    def.gravityScale = spec.gravityScale;
    def.linearDamping = spec.linearDamping;
    def.angularDamping = spec.angularDamping;
    def.isBullet = spec.continuous;
    def.enableSleep = this.options.enableSleep && spec.bodyType === 'dynamic';
    def.motionLocks = {
      linearX: false,
      linearY: false,
      linearZ: false,
      angularX: spec.lockRotation,
      angularY: spec.lockRotation,
      angularZ: spec.lockRotation,
    };

    const body = m.b3CreateBody(this.worldId, def);
    this.bodies.set(spec.key, body);
    this.bodyKeys.set(bodyKeyOf(body), spec.key);

    for (const collider of spec.colliders) {
      const shapeDef = m.b3DefaultShapeDef();
      shapeDef.density = collider.density;
      shapeDef.baseMaterial.friction = collider.friction;
      shapeDef.baseMaterial.restitution = collider.restitution;
      shapeDef.isSensor = collider.isSensor;
      shapeDef.enableContactEvents = collider.reportContacts;
      // Measured with box3d.js@0.1.1: a sensor touch event is only delivered when BOTH
      // the sensor shape and the visiting shape have sensor events enabled. Leaving the
      // flag off the visitor silently produces zero events, so it is set on every shape.
      shapeDef.enableSensorEvents = true;
      shapeDef.enableHitEvents = collider.reportHits && !collider.isSensor;
      const shape = this.createShape(body, shapeDef, collider.shape, collider.offset, collider.rotation);
      this.shapeKeys.set(shapeKeyOf(shape), spec.key);
      // A sensor is a trigger, not an obstacle: the mover cast has to be told to pass through it.
      if (collider.isSensor) this.sensorShapes.add(shapeKeyOf(shape));
    }
  }

  private createShape(
    body: b3BodyId,
    shapeDef: ReturnType<Box3DModule['b3DefaultShapeDef']>,
    shape: ColliderShapeSpec,
    offset: Vec3,
    rotation: Quat,
  ): b3ShapeId {
    const m = this.module;
    switch (shape.kind) {
      case 'box': {
        if (isZero(offset) && isIdentityQuat(rotation)) {
          return m.b3CreateBoxShape(body, shapeDef, shape.halfExtents[0], shape.halfExtents[1], shape.halfExtents[2]);
        }
        // Offset/rotated box: build a temporary hull, transform it, and let the shape copy it.
        const [hx, hy, hz] = shape.halfExtents;
        const points = new Float32Array(24);
        let i = 0;
        for (const sx of [-hx, hx]) {
          for (const sy of [-hy, hy]) {
            for (const sz of [-hz, hz]) {
              points[i++] = sx;
              points[i++] = sy;
              points[i++] = sz;
            }
          }
        }
        const hull = m.b3CreateHull(points);
        if (!hull) throw new Error('Box3D could not build a hull for an offset box collider');
        const transformed = m.b3CloneAndTransformHull(hull, { position: [offset[0], offset[1], offset[2]], quaternion: rotation }, [1, 1, 1]);
        m.b3DestroyHull(hull);
        if (!transformed) throw new Error('Box3D could not transform an offset box collider');
        const created = m.b3CreateHullShape(body, shapeDef, transformed);
        m.b3DestroyHull(transformed);
        return created;
      }
      case 'sphere':
        return m.b3CreateSphereShape(body, shapeDef, { center: [offset[0], offset[1], offset[2]], radius: shape.radius });
      case 'capsule': {
        // The binding takes the two sphere centres, so the local rotation is baked in.
        rotateVec(rotation, [0, shape.halfHeight, 0], this.scratchAxis);
        const c1: [number, number, number] = [offset[0] - this.scratchAxis[0], offset[1] - this.scratchAxis[1], offset[2] - this.scratchAxis[2]];
        const c2: [number, number, number] = [offset[0] + this.scratchAxis[0], offset[1] + this.scratchAxis[1], offset[2] + this.scratchAxis[2]];
        return m.b3CreateCapsuleShape(body, shapeDef, { center1: c1, center2: c2, radius: shape.radius });
      }
      default: {
        const exhaustive: never = shape;
        throw new Error(`unsupported collider shape: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  destroyBody(key: string): void {
    if (this.isDisposed) return;
    const body = this.bodies.get(key);
    if (!body) return;
    this.module.b3DestroyBody(body);
    this.bodies.delete(key);
    this.bodyKeys.delete(bodyKeyOf(body));
    for (const [sk, value] of this.shapeKeys) {
      if (value === key) {
        this.shapeKeys.delete(sk);
        this.sensorShapes.delete(sk);
      }
    }
  }

  hasBody(key: string): boolean {
    return this.bodies.has(key);
  }

  getBodyCount(): number {
    return this.bodies.size;
  }

  step(): void {
    this.assertLive();
    this.module.b3World_Step(this.worldId, this.options.fixedTimeStep, this.options.subStepCount);
  }

  readTransform(key: string, out: Float32Array): boolean {
    const body = this.bodies.get(key);
    if (!body || this.isDisposed) return false;
    const [, rot] = this.module.b3Body_GetTransform(this.scratchVec, this.scratchQuat, body);
    out[0] = this.scratchVec[0];
    out[1] = this.scratchVec[1];
    out[2] = this.scratchVec[2];
    out[3] = rot[0];
    out[4] = rot[1];
    out[5] = rot[2];
    out[6] = rot[3];
    return true;
  }

  readVelocity(key: string, out: Float32Array): boolean {
    const body = this.bodies.get(key);
    if (!body || this.isDisposed) return false;
    const linear = this.module.b3Body_GetLinearVelocity(this.scratchVec, body);
    out[0] = linear[0];
    out[1] = linear[1];
    out[2] = linear[2];
    return true;
  }

  setTransform(key: string, position: Vec3, rotation: Quat): void {
    const body = this.bodies.get(key);
    if (!body || this.isDisposed) return;
    this.module.b3Body_SetTransform(
      body,
      [position[0], position[1], position[2]],
      [rotation[0], rotation[1], rotation[2], rotation[3]],
    );
  }

  setLinearVelocity(key: string, velocity: Vec3): void {
    const body = this.bodies.get(key);
    if (!body || this.isDisposed) return;
    this.module.b3Body_SetLinearVelocity(body, [velocity[0], velocity[1], velocity[2]]);
  }

  setAngularVelocity(key: string, velocity: Vec3): void {
    const body = this.bodies.get(key);
    if (!body || this.isDisposed) return;
    this.module.b3Body_SetAngularVelocity(body, [velocity[0], velocity[1], velocity[2]]);
  }

  setBodyType(key: string, type: PhysicsBodyType): void {
    const body = this.bodies.get(key);
    if (!body || this.isDisposed) return;
    this.module.b3Body_SetType(
      body,
      type === 'static'
        ? this.module.b3BodyType.b3_staticBody
        : type === 'kinematic'
          ? this.module.b3BodyType.b3_kinematicBody
          : this.module.b3BodyType.b3_dynamicBody,
    );
  }

  setBodyEnabled(key: string, enabled: boolean): void {
    const body = this.bodies.get(key);
    if (!body || this.isDisposed) return;
    if (enabled) this.module.b3Body_Enable(body);
    else this.module.b3Body_Disable(body);
  }

  applyImpulse(key: string, impulse: Vec3, point?: Vec3): void {
    const body = this.bodies.get(key);
    if (!body || this.isDisposed) return;
    const v: [number, number, number] = [impulse[0], impulse[1], impulse[2]];
    if (point) {
      this.module.b3Body_ApplyLinearImpulse(body, v, [point[0], point[1], point[2]], true);
    } else {
      this.module.b3Body_ApplyLinearImpulseToCenter(body, v, true);
    }
  }

  applyForce(key: string, force: Vec3, point?: Vec3): void {
    const body = this.bodies.get(key);
    if (!body || this.isDisposed) return;
    const v: [number, number, number] = [force[0], force[1], force[2]];
    if (point) {
      this.module.b3Body_ApplyForce(body, v, [point[0], point[1], point[2]], true);
    } else {
      this.module.b3Body_ApplyForceToCenter(body, v, true);
    }
  }

  drainEvents(): ContactEvent[] {
    if (this.isDisposed) return [];
    const m = this.module;
    const out: ContactEvent[] = [];
    m.getEvents(this.events, this.worldId);

    const begin = m.getNumContactBeginEvents(this.events);
    for (let i = 0; i < begin; i += 1) {
      const event = m.getContactBeginEventAt(this.contactBeginOut, this.events, i);
      out.push({ kind: 'begin', a: this.keyForShape(event.shapeIdA), b: this.keyForShape(event.shapeIdB) });
    }
    const end = m.getNumContactEndEvents(this.events);
    for (let i = 0; i < end; i += 1) {
      const event = m.getContactEndEventAt(this.contactEndOut, this.events, i);
      out.push({ kind: 'end', a: this.keyForShape(event.shapeIdA), b: this.keyForShape(event.shapeIdB) });
    }
    const hits = m.getNumContactHitEvents(this.events);
    for (let i = 0; i < hits; i += 1) {
      const event = m.getContactHitEventAt(this.contactHitOut, this.events, i);
      out.push({
        kind: 'hit',
        a: this.keyForShape(event.shapeIdA),
        b: this.keyForShape(event.shapeIdB),
        approachSpeed: event.approachSpeed,
        point: [event.point[0], event.point[1], event.point[2]],
        normal: [event.normal[0], event.normal[1], event.normal[2]],
      });
    }
    const sensorBegin = m.getNumSensorBeginEvents(this.events);
    for (let i = 0; i < sensorBegin; i += 1) {
      const event = m.getSensorBeginEventAt(this.sensorBeginOut, this.events, i);
      out.push({ kind: 'sensorBegin', a: this.keyForShape(event.sensorShapeId), b: this.keyForShape(event.visitorShapeId) });
    }
    const sensorEnd = m.getNumSensorEndEvents(this.events);
    for (let i = 0; i < sensorEnd; i += 1) {
      const event = m.getSensorEndEventAt(this.sensorEndOut, this.events, i);
      out.push({ kind: 'sensorEnd', a: this.keyForShape(event.sensorShapeId), b: this.keyForShape(event.visitorShapeId) });
    }
    return out;
  }

  private keyForShape(shape: b3ShapeId): string | null {
    return this.shapeKeys.get(shapeKeyOf(shape)) ?? null;
  }

  raycastClosest(origin: Vec3, direction: Vec3, maxDistance: number): RaycastHit {
    if (this.isDisposed) return { hit: false, key: null, distance: 0, point: [0, 0, 0], normal: [0, 0, 0] };
    const filter = this.module.b3DefaultQueryFilter();
    // `translation` is the ray's displacement, not a normalised direction: a unit vector
    // would only search one metre ahead.
    const result = this.module.b3World_CastRayClosest(
      this.worldId,
      [origin[0], origin[1], origin[2]],
      [direction[0] * maxDistance, direction[1] * maxDistance, direction[2] * maxDistance],
      filter,
    );
    if (!result.hit) {
      return { hit: false, key: null, distance: 0, point: [0, 0, 0], normal: [0, 0, 0] };
    }
    return {
      hit: true,
      key: this.keyForShape(result.shapeId),
      distance: result.fraction * maxDistance,
      point: [result.point[0], result.point[1], result.point[2]],
      normal: [result.normal[0], result.normal[1], result.normal[2]],
    };
  }

  /**
   * Sweep an upright capsule along a translation (Box3D's mover cast).
   *
   * Measured with box3d.js@0.1.1: the return value is the fraction of the translation the capsule
   * can travel before its first touch — not a hit count — and the callback is handed the shape id
   * of every shape the broad phase considered. Shapes the capsule already overlaps at the start
   * (its own body, most importantly) do not stop the sweep, which is why this can drive a
   * character without the character colliding with itself.
   */
  castMover(request: MoverCastRequest): MoverCastResult {
    if (this.isDisposed) return { fraction: 1, keys: [] };
    const m = this.module;
    const keys: string[] = [];
    const sensorShapes = this.sensorShapes;
    const filter = m.b3DefaultQueryFilter();
    const fraction = m.b3World_CastMover(
      this.worldId,
      [request.origin[0], request.origin[1], request.origin[2]],
      {
        center1: [request.capsule.center1[0], request.capsule.center1[1], request.capsule.center1[2]],
        center2: [request.capsule.center2[0], request.capsule.center2[1], request.capsule.center2[2]],
        radius: request.capsule.radius,
      },
      [request.translation[0], request.translation[1], request.translation[2]],
      filter,
      (shapeId: b3ShapeId) => {
        if (sensorShapes.has(shapeKeyOf(shapeId))) return false;
        const key = this.keyForShape(shapeId);
        if (request.excludeKey !== undefined && key === request.excludeKey) return false;
        if (key) keys.push(key);
        return true;
      },
    );
    return { fraction: Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 1, keys };
  }

  getCounters(): PhysicsCounters {
    if (this.isDisposed) {
      return { bodyCount: 0, shapeCount: 0, contactCount: 0, jointCount: 0, islandCount: 0, awakeBodyCount: 0, byteCount: 0 };
    }
    const counters = this.module.b3World_GetCounters(this.worldId);
    return {
      bodyCount: counters.bodyCount,
      shapeCount: counters.shapeCount,
      contactCount: counters.contactCount,
      jointCount: counters.jointCount,
      islandCount: counters.islandCount,
      awakeBodyCount: this.module.b3World_GetAwakeBodyCount(this.worldId),
      byteCount: this.module.b3GetByteCount(),
    };
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.module.destroyEventsBuffer(this.events);
    this.module.b3DestroyWorld(this.worldId);
    this.bodies.clear();
    this.bodyKeys.clear();
    this.shapeKeys.clear();
    this.sensorShapes.clear();
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  private assertLive(): void {
    if (this.isDisposed) throw new Error('physics world has been disposed');
  }
}

class Box3DBackend implements PhysicsBackend {
  readonly name = BOX3D_BINDING;
  readonly version: string;
  readonly doublePrecision: boolean;
  private readonly module: Box3DModule;

  constructor(module: Box3DModule) {
    this.module = module;
    const version = module.b3GetVersion();
    this.version = `${version.major}.${version.minor}.${version.revision}`;
    this.doublePrecision = module.b3IsDoublePrecision();
  }

  getWorldCount(): number {
    return this.module.b3GetWorldCount();
  }

  getByteCount(): number {
    return this.module.b3GetByteCount();
  }

  createWorld(options: PhysicsWorldOptions): PhysicsWorldHandle {
    return new Box3DWorld(this.module, options);
  }
}

/** Load the Box3D binding and wrap it in the studio's backend interface. */
export async function createBox3DBackend(options?: { locateFile?: (path: string) => string }): Promise<PhysicsBackend> {
  const module = await loadBox3D(options);
  return new Box3DBackend(module);
}
