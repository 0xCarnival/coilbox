import type { JsonValue } from '@schema/index.js';

import type { BehaviorContext, BehaviorDefinition, BehaviorInstance, BehaviorPropertyDescriptor } from './types.js';

/**
 * Anti-gravity racing behaviors (the `racer.*` family).
 *
 * Four registered behaviors turn a scene of static track pieces and named waypoints into a
 * combat racer: a hover craft controller shared by the player and the AI rivals, a banking chase
 * camera, weapon/shield/boost pickups, and a race director that runs the countdown, ranks every
 * craft, and decides the finish.
 *
 * Craft are kinematic bodies. Each fixed step the controller integrates its own hover model,
 * sweeps the move through the physics world with `moveCharacter` (so rails and other craft block
 * it), and probes the track surface with a downward ray so elevation changes and drops come from
 * the scene geometry rather than from authored heights.
 *
 * Behaviors cannot see one another directly, so they talk through game-state keys:
 *
 * - `racer.crafts`   — comma-separated entity ids of every craft, written by the director.
 * - `racer.player`   — entity id of the player craft, written by the player craft.
 * - `racer.progress.<id>` — lap progress in waypoints, written by each craft every step.
 * - `racer.finished.<id>` — true once a craft has crossed the line on its final lap.
 * - `racer.damage.<id>`   — pending damage for a craft; the victim drains it every step.
 * - `racer.pickup.<id>`   — a pickup kind waiting to be applied to a craft.
 * - `racer.bank`, `racer.speed` — the player craft's roll and speed, read by the chase camera.
 */

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

const number = (
  key: string,
  label: string,
  value: number,
  extra: Partial<BehaviorPropertyDescriptor> = {},
): BehaviorPropertyDescriptor => ({ key, label, type: 'number', default: value, ...extra });
const text = (key: string, label: string, value: string, help?: string): BehaviorPropertyDescriptor => ({
  key,
  label,
  type: 'text',
  default: value,
  description: help,
});
const entity = (key: string, label: string, help?: string): BehaviorPropertyDescriptor => ({
  key,
  label,
  type: 'entity',
  default: null,
  description: help,
});
const choice = (key: string, label: string, value: string, options: string[], help?: string): BehaviorPropertyDescriptor => ({
  key,
  label,
  type: 'enum',
  default: value,
  options,
  description: help,
});

const isJsonNumber = (value: JsonValue | undefined): value is number => typeof value === 'number';
const isJsonString = (value: JsonValue | undefined): value is string => typeof value === 'string';

const numberProperty = (context: BehaviorContext, key: string, fallback: number): number => {
  const value = context.properties[key];
  return isJsonNumber(value) && Number.isFinite(value) ? value : fallback;
};
const stringProperty = (context: BehaviorContext, key: string, fallback: string): string => {
  const value = context.properties[key];
  return isJsonString(value) ? value : fallback;
};

const clamp = (value: number, low: number, high: number): number => (value < low ? low : value > high ? high : value);
const wrapAngle = (angle: number): number => {
  let result = angle;
  while (result > Math.PI) result -= Math.PI * 2;
  while (result < -Math.PI) result += Math.PI * 2;
  return result;
};
/** Frame-rate independent exponential approach. */
const approach = (current: number, target: number, rate: number, delta: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * delta));

/** Yaw of a quaternion's -Z forward axis, matching the engine's forward convention. */
function yawOf(q: Float32Array): number {
  const fx = -2 * (q[3] * q[5] + q[6] * q[4]);
  const fz = -(1 - 2 * (q[3] * q[3] + q[4] * q[4]));
  return Math.atan2(-fx, -fz);
}

/** Quaternion for yaw (about Y), then pitch (about local X), then roll (about local Z). */
function quatFromEuler(yaw: number, pitch: number, roll: number, out: Quat): Quat {
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  const cr = Math.cos(roll / 2);
  const sr = Math.sin(roll / 2);
  // q = (qy * qx) * qz, with qz = (0, 0, sr, cr)
  const ax = cy * sp;
  const ay = sy * cp;
  const az = -sy * sp;
  const aw = cy * cp;
  out[0] = ax * cr + ay * sr;
  out[1] = ay * cr - ax * sr;
  out[2] = aw * sr + az * cr;
  out[3] = aw * cr - az * sr;
  return out;
}

/** Quaternion aiming local -Z from `from` at `to`, rolled by `roll` about that axis. */
function quatLookAt(from: Vec3, to: Vec3, roll: number, out: Quat): Quat {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const horizontal = Math.hypot(dx, dz);
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, horizontal);
  return quatFromEuler(yaw, pitch, roll, out);
}

/** Resolve the ordered list of waypoint entities `"<prefix> 01"`, `"<prefix> 02"`, … */
function resolveWaypoints(context: BehaviorContext, prefix: string): Vec3[] {
  const points: Vec3[] = [];
  const sample = new Float32Array(7);
  for (let index = 1; index <= 999; index += 1) {
    const id = context.findEntityByName(`${prefix} ${String(index).padStart(2, '0')}`);
    if (!id || !context.readTransform(id, sample)) break;
    points.push([sample[0], sample[1], sample[2]]);
  }
  return points;
}

interface CraftIdCache {
  raw: string;
  ids: string[];
}
const createCraftIdCache = (): CraftIdCache => ({ raw: '', ids: [] });

/** The craft ids the director published, parsed once per change. */
function craftIds(context: BehaviorContext, cache: CraftIdCache): string[] {
  const raw = context.getState<string>('racer.crafts');
  const value = isJsonString(raw) ? raw : '';
  if (value !== cache.raw) {
    cache.raw = value;
    cache.ids = value.length > 0 ? value.split(',') : [];
  }
  return cache.ids;
}

const DOWN: Vec3 = [0, -1, 0];
/** Horizontal radius the hull keeps clear of rails and other craft. */
const HULL_RADIUS = 1.1;
/** Wall probes run this far below the collider centre so they cross the rails, not the air above them. */
const WALL_PROBE_DROP = 0.3;
const SIDES: readonly [-1, 1] = [-1, 1];

const progressKey = (id: string): string => `racer.progress.${id}`;
const finishedKey = (id: string): string => `racer.finished.${id}`;
const damageKey = (id: string): string => `racer.damage.${id}`;
const pickupKey = (id: string): string => `racer.pickup.${id}`;

interface CraftClass {
  name: string;
  topSpeed: number;
  acceleration: number;
  turnRate: number;
  grip: number;
  driftGrip: number;
  airbrakeTurn: number;
  boostPower: number;
  energy: number;
  armor: number;
  weaponDamage: number;
}

const CRAFT_CLASSES: Record<'speeder' | 'interceptor' | 'bulwark', CraftClass> = {
  speeder: {
    name: 'KITSUNE  ·  speeder',
    topSpeed: 82,
    acceleration: 34,
    turnRate: 2.7,
    grip: 6.5,
    driftGrip: 1.4,
    airbrakeTurn: 2.4,
    boostPower: 1.5,
    energy: 60,
    armor: 1.35,
    weaponDamage: 42,
  },
  interceptor: {
    name: 'TENGU  ·  interceptor',
    topSpeed: 74,
    acceleration: 28,
    turnRate: 2.5,
    grip: 7.5,
    driftGrip: 1.9,
    airbrakeTurn: 2.1,
    boostPower: 1.4,
    energy: 100,
    armor: 1,
    weaponDamage: 28,
  },
  bulwark: {
    name: 'ONI  ·  bulwark',
    topSpeed: 77,
    acceleration: 22,
    turnRate: 1.95,
    grip: 8.5,
    driftGrip: 2.4,
    airbrakeTurn: 1.7,
    boostPower: 1.55,
    energy: 150,
    armor: 0.7,
    weaponDamage: 22,
  },
};
type CraftClassId = keyof typeof CRAFT_CLASSES;
const CRAFT_CLASS_IDS: CraftClassId[] = ['speeder', 'interceptor', 'bulwark'];
const isCraftClassId = (value: string): value is CraftClassId => value in CRAFT_CLASSES;

const WEAPON_LABELS = {
  none: '—',
  pulse: 'PULSE CANNON',
  shock: 'SHOCKWAVE',
  shield: 'SHIELD',
} satisfies Record<string, string>;
type WeaponId = keyof typeof WEAPON_LABELS;
const isWeaponId = (value: string): value is WeaponId => value in WEAPON_LABELS;

const ORDINALS = ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH', '7TH', '8TH'];

/**
 * Hover craft: the player's ship and every AI rival share this controller.
 *
 * Movement is a world-space horizontal velocity split each step into a forward and a lateral
 * component in the craft's frame. Thrust and drag act on the forward part, grip bleeds the lateral
 * part — low grip while an air brake is held is what makes the craft drift through a corner nose
 * first. Height is a damped spring toward the track surface found by a downward ray, or gravity
 * when there is nothing under the craft.
 */
export const racerCraft: BehaviorDefinition = {
  id: 'racer.craft',
  name: 'Racer Craft',
  description: 'Anti-gravity hover craft with drift, air brakes, boost, weapons and shields. Pilot it or hand it to an AI rival.',
  properties: [
    choice('pilot', 'Pilot', 'player', ['player', 'rival'], 'Who flies this craft.'),
    choice('craftClass', 'Craft class', 'interceptor', CRAFT_CLASS_IDS, 'speeder: fragile and fast. interceptor: balanced. bulwark: heavy and armoured.'),
    text('waypointPrefix', 'Waypoint prefix', 'Waypoint', 'Waypoints are entities named "<prefix> 01", "<prefix> 02", … in lap order. Number 01 is the start line.'),
    entity('speederVisual', 'Speeder visual', 'Child entity shown when the speeder class is selected.'),
    entity('interceptorVisual', 'Interceptor visual', 'Child entity shown when the interceptor class is selected.'),
    entity('bulwarkVisual', 'Bulwark visual', 'Child entity shown when the bulwark class is selected.'),
    entity('bolt', 'Pulse bolt entity', 'Scene entity animated as this craft\'s pulse cannon shot.'),
    number('hoverHeight', 'Hover height', 1.25, { min: 0.5, max: 4, step: 0.05, group: 'Hover', description: 'Distance the collider centre rides above the track surface.' }),
    number('hoverStiffness', 'Hover stiffness', 60, { min: 5, max: 200, step: 5, group: 'Hover', advanced: true }),
    number('hoverDamping', 'Hover damping', 10, { min: 1, max: 40, step: 1, group: 'Hover', advanced: true }),
    number('gravity', 'Gravity', 28, { min: 0, max: 80, step: 1, group: 'Hover' }),
    number('killY', 'Respawn below Y', -40, { min: -500, max: 100, step: 5, group: 'Hover', description: 'A craft that falls below this height is put back on the track.' }),
    number('speedScale', 'Speed scale', 1, { min: 0.3, max: 2, step: 0.05, group: 'Tuning', description: 'Multiplies the class top speed and acceleration.' }),
    number('boostCharge', 'Boost charge', 100, { min: 0, max: 100, step: 5, group: 'Tuning', description: 'Boost meter at the start of the race.' }),
    number('difficulty', 'AI skill', 0.7, { min: 0, max: 1, step: 0.05, group: 'AI', description: 'Rival only: pace and precision.' }),
    number('aggression', 'AI aggression', 0.6, { min: 0, max: 1, step: 0.05, group: 'AI', description: 'Rival only: how eagerly it rams and fires at the player.' }),
    number('laneOffset', 'Lane offset', 0, { min: -6, max: 6, step: 0.5, group: 'AI', description: 'Rival only: metres right of the waypoint line it prefers.' }),
    number('rubberBand', 'Rubber banding', 0.05, { min: 0, max: 0.2, step: 0.01, group: 'AI', advanced: true, description: 'Rival only: speed bonus per waypoint it trails the player by.' }),
  ],
  create(context): BehaviorInstance {
    const transform = new Float32Array(7);
    const rotation: Quat = [0, 0, 0, 1];
    const position: Vec3 = [0, 0, 0];
    const spawn: Vec3 = [0, 0, 0];
    const desired: Vec3 = [0, 0, 0];
    const rayOrigin: Vec3 = [0, 0, 0];
    const rayDirection: Vec3 = [0, 0, 0];
    const boltPosition: Vec3 = [0, 0, 0];
    const boltRotation: Quat = [0, 0, 0, 1];
    const other = new Float32Array(7);
    const crafts = createCraftIdCache();

    let waypoints: Vec3[] = [];
    let classId: CraftClassId = 'interceptor';
    let stats = CRAFT_CLASSES.interceptor;
    let isPlayer = true;
    let yaw = 0;
    let spawnYaw = 0;
    let vx = 0;
    let vz = 0;
    let vy = 0;
    let roll = 0;
    let pitch = 0;
    let surfacePitch = 0;
    let grounded = false;
    let airTime = 0;
    let boost = 100;
    let boosting = false;
    let energy = 100;
    let weapon: WeaponId = 'none';
    let shieldTimer = 0;
    let stunTimer = 0;
    let respawnTimer = 0;
    let wrecked = false;
    let next = 0;
    let lap = 0;
    let finished = false;
    let progress = 0;
    let announceTimer = 0;
    let boltTimer = 0;
    let boltId: string | null = null;
    let wobble = 0;
    let stuckTimer = 0;
    let reverseTimer = 0;

    const ids = (): string[] => craftIds(context, crafts);

    const announce = (message: string) => {
      if (!isPlayer) return;
      context.setState('announce', message);
      announceTimer = 1.6;
    };

    const visualFor = (id: CraftClassId): string | null => {
      const configured = stringProperty(context, `${id}Visual`, '');
      if (configured.length === 0) return null;
      return context.findEntityById(configured) ?? context.findEntityByName(configured);
    };

    const applyClass = (id: CraftClassId) => {
      classId = id;
      stats = CRAFT_CLASSES[id];
      energy = Math.min(energy, stats.energy);
      for (const candidate of CRAFT_CLASS_IDS) {
        const visual = visualFor(candidate);
        if (visual) context.setBodyEnabled(visual, candidate === id);
      }
      if (isPlayer) context.setState('craft', stats.name);
    };

    const speed = (): number => Math.hypot(vx, vz);

    const placeAt = (point: Vec3, lift: number, facing: number) => {
      position[0] = point[0];
      position[1] = point[1] + lift;
      position[2] = point[2];
      yaw = facing;
      vx = 0;
      vz = 0;
      vy = 0;
      roll = 0;
      pitch = 0;
      quatFromEuler(yaw, 0, 0, rotation);
      context.moveKinematic(context.entityId, position, rotation);
    };

    const respawn = () => {
      wrecked = false;
      stunTimer = 0;
      shieldTimer = 2.5;
      energy = Math.max(energy, stats.energy * 0.6);
      context.setBodyEnabled(context.entityId, true);
      if (waypoints.length === 0 || (lap === 0 && next === 0)) {
        placeAt(spawn, 0, spawnYaw);
        return;
      }
      const count = waypoints.length;
      const previous = waypoints[(next - 1 + count) % count];
      const target = waypoints[next % count];
      placeAt(previous, numberProperty(context, 'hoverHeight', 1.25), Math.atan2(-(target[0] - previous[0]), -(target[2] - previous[2])));
    };

    const wreck = () => {
      wrecked = true;
      respawnTimer = 1.4;
      energy = 0;
      weapon = 'none';
      context.setBodyEnabled(context.entityId, false);
      announce('CRAFT DESTROYED');
    };

    const takeDamage = (amount: number) => {
      if (shieldTimer > 0 || wrecked || finished) return;
      energy -= amount * stats.armor;
      stunTimer = Math.max(stunTimer, 0.35);
      const scrub = 1 - clamp(amount / 100, 0.1, 0.5);
      vx *= scrub;
      vz *= scrub;
      if (energy <= 0) wreck();
    };

    const dealDamage = (targetId: string, amount: number) => {
      const key = damageKey(targetId);
      context.setState(key, (context.getState<number>(key) ?? 0) + amount);
    };

    const firePulse = () => {
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      let best: string | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const id of ids()) {
        if (id === context.entityId || !context.readTransform(id, other)) continue;
        const dx = other[0] - position[0];
        const dz = other[2] - position[2];
        const distance = Math.hypot(dx, dz);
        if (distance > 70 || distance < 0.01) continue;
        const along = (dx * fx + dz * fz) / distance;
        if (along < Math.cos(0.2)) continue;
        if (distance < bestDistance) {
          best = id;
          bestDistance = distance;
        }
      }
      if (best) {
        dealDamage(best, stats.weaponDamage);
        announce('PULSE HIT');
      }
      if (boltId) {
        boltTimer = 0.45;
        boltPosition[0] = position[0];
        boltPosition[1] = position[1];
        boltPosition[2] = position[2];
        quatFromEuler(yaw, 0, 0, boltRotation);
        context.setBodyEnabled(boltId, true);
        context.moveKinematic(boltId, boltPosition, boltRotation);
      }
    };

    const fireShock = () => {
      let hits = 0;
      for (const id of ids()) {
        if (id === context.entityId || !context.readTransform(id, other)) continue;
        const distance = Math.hypot(other[0] - position[0], other[1] - position[1], other[2] - position[2]);
        if (distance > 20) continue;
        dealDamage(id, stats.weaponDamage * 1.1);
        hits += 1;
      }
      announce(hits > 0 ? `SHOCKWAVE  ·  ${hits} HIT` : 'SHOCKWAVE');
    };

    const useWeapon = () => {
      if (weapon === 'none' || wrecked) return;
      const current = weapon;
      weapon = 'none';
      if (current === 'pulse') firePulse();
      else if (current === 'shock') fireShock();
      else if (current === 'shield') {
        shieldTimer = 5;
        announce('SHIELD UP');
      }
    };

    const applyPickup = (kind: string) => {
      if (kind === 'boost') {
        boost = Math.min(100, boost + 35);
        const surge = stats.topSpeed * numberProperty(context, 'speedScale', 1) * 0.35;
        vx += -Math.sin(yaw) * surge;
        vz += -Math.cos(yaw) * surge;
        announce('BOOST PAD');
      } else if (kind === 'energy') {
        energy = Math.min(stats.energy, energy + stats.energy * 0.4);
        announce('ENERGY +40%');
      } else if (isWeaponId(kind) && kind !== 'none') {
        weapon = kind;
        announce(`${WEAPON_LABELS[kind]} ACQUIRED`);
      }
    };

    /** Advance the waypoint cursor and lap counter; returns lap progress in waypoints. */
    const trackProgress = (): number => {
      const count = waypoints.length;
      if (count === 0) return 0;
      const target = waypoints[next % count];
      const after = waypoints[(next + 1) % count];
      const before = waypoints[(next - 1 + count) % count];
      let dirX = after[0] - target[0];
      let dirZ = after[2] - target[2];
      const dirLength = Math.hypot(dirX, dirZ) || 1;
      dirX /= dirLength;
      dirZ /= dirLength;
      const dx = position[0] - target[0];
      const dz = position[2] - target[2];
      const distance = Math.hypot(dx, dz);
      if (distance < 22 && dx * dirX + dz * dirZ > 0) {
        if (next === 0) {
          // Waypoint 01 is the start/finish line.
          lap += 1;
          const laps = context.getState<number>('laps') ?? 3;
          if (lap > laps && !finished) {
            finished = true;
            context.setState(finishedKey(context.entityId), true);
          } else if (isPlayer && lap > 1 && lap <= laps) {
            announce(lap === laps ? 'FINAL LAP' : `LAP ${lap}`);
          }
        }
        next = (next + 1) % count;
        return trackProgress();
      }
      const segment = Math.hypot(target[0] - before[0], target[2] - before[2]) || 1;
      const fraction = clamp(1 - distance / segment, 0, 0.999);
      return lap * count + next + fraction;
    };

    interface Controls {
      throttle: number;
      steer: number;
      airLeft: boolean;
      airRight: boolean;
      boost: boolean;
      fire: boolean;
    }
    const controls: Controls = { throttle: 0, steer: 0, airLeft: false, airRight: false, boost: false, fire: false };

    const readPlayerControls = () => {
      const axis = context.moveAxis();
      controls.throttle = context.isActionDown('moveForward') ? 1 : context.isActionDown('moveBackward') ? -1 : 0;
      controls.steer = -axis.x;
      controls.airLeft = context.isActionDown('airbrakeLeft');
      controls.airRight = context.isActionDown('airbrakeRight');
      controls.boost = context.isActionDown('boost');
      controls.fire = context.wasActionPressed('fire');
      if (context.wasActionPressed('craft1')) applyClass('speeder');
      if (context.wasActionPressed('craft2')) applyClass('interceptor');
      if (context.wasActionPressed('craft3')) applyClass('bulwark');
    };

    const readRivalControls = (delta: number, racing: boolean) => {
      const count = waypoints.length;
      controls.throttle = 1;
      controls.steer = 0;
      controls.airLeft = false;
      controls.airRight = false;
      controls.boost = false;
      controls.fire = false;
      if (count === 0) return;
      // Boxed in against a rail or another hull: back out for a moment, steering the other way.
      if (racing && !finished && speed() < 4) stuckTimer += delta;
      else stuckTimer = 0;
      if (stuckTimer > 1.2) {
        stuckTimer = 0;
        reverseTimer = 0.9;
      }
      const skill = clamp(numberProperty(context, 'difficulty', 0.7), 0, 1);
      const aggression = clamp(numberProperty(context, 'aggression', 0.6), 0, 1);
      wobble += delta;
      const lane = numberProperty(context, 'laneOffset', 0) + Math.sin(wobble * 0.7) * (1.5 - skill);

      const target = waypoints[next % count];
      const after = waypoints[(next + 1) % count];
      const nearTarget = Math.hypot(target[0] - position[0], target[2] - position[2]) < 16 + speed() * 0.25;
      const aim = nearTarget ? after : target;
      const from = nearTarget ? target : waypoints[(next - 1 + count) % count];
      let segX = aim[0] - from[0];
      let segZ = aim[2] - from[2];
      const segLength = Math.hypot(segX, segZ) || 1;
      segX /= segLength;
      segZ /= segLength;
      // right of the segment direction = (-segZ, segX)
      let aimX = aim[0] - segZ * lane;
      let aimZ = aim[2] + segX * lane;

      const playerId = context.getState<string>('racer.player');
      if (isJsonString(playerId) && playerId !== context.entityId && context.readTransform(playerId, other)) {
        const dx = other[0] - position[0];
        const dz = other[2] - position[2];
        const distance = Math.hypot(dx, dz);
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const ahead = distance > 0.01 ? (dx * fx + dz * fz) / distance : 0;
        if (distance < 28 && ahead > 0.85) {
          // Hunt the player: lean the aim point toward them and use whatever is loaded.
          aimX += (other[0] - aimX) * aggression * 0.5;
          aimZ += (other[2] - aimZ) * aggression * 0.5;
          if (weapon === 'pulse' && ahead > 0.98) controls.fire = true;
          if (weapon === 'shock' && distance < 14) controls.fire = true;
        }
      }
      if (weapon === 'shield' && energy < stats.energy * 0.3) controls.fire = true;

      const desiredYaw = Math.atan2(-(aimX - position[0]), -(aimZ - position[2]));
      const error = wrapAngle(desiredYaw - yaw);
      controls.steer = clamp(error * (1.6 + skill), -1, 1);
      if (reverseTimer > 0) {
        reverseTimer -= delta;
        controls.throttle = -1;
        controls.steer = -controls.steer;
        return;
      }
      const fast = speed() > stats.topSpeed * 0.5;
      if (Math.abs(error) > 0.32 && fast) {
        if (error > 0) controls.airLeft = true;
        else controls.airRight = true;
      }
      if (Math.abs(error) > 1 && fast) controls.throttle = -0.5;
      if (Math.abs(error) < 0.1 && boost > 20 && !finished) controls.boost = true;
    };

    const start = () => {
      isPlayer = stringProperty(context, 'pilot', 'player') === 'player';
      waypoints = resolveWaypoints(context, stringProperty(context, 'waypointPrefix', 'Waypoint'));
      if (waypoints.length < 2) context.log('Racer Craft found fewer than two waypoints; the track cannot be followed');
      if (!context.isPhysicsBody(context.entityId)) context.log('Racer Craft needs a kinematic rigid body with a collider on this entity');

      const configuredClass = stringProperty(context, 'craftClass', 'interceptor');
      classId = isCraftClassId(configuredClass) ? configuredClass : 'interceptor';
      stats = CRAFT_CLASSES[classId];
      energy = stats.energy;
      boost = clamp(numberProperty(context, 'boostCharge', 100), 0, 100);

      context.readTransform(context.entityId, transform);
      spawn[0] = transform[0];
      spawn[1] = transform[1];
      spawn[2] = transform[2];
      spawnYaw = yawOf(transform);
      placeAt(spawn, 0, spawnYaw);
      context.setBodyType(context.entityId, 'kinematic');

      const configuredBolt = stringProperty(context, 'bolt', '');
      boltId = configuredBolt.length > 0 ? (context.findEntityById(configuredBolt) ?? context.findEntityByName(configuredBolt)) : null;
      if (boltId) context.setBodyEnabled(boltId, false);

      applyClass(classId);
      if (isPlayer) {
        context.setState('racer.player', context.entityId);
        context.setState('weapon', WEAPON_LABELS.none);
        context.setState('lap', `1 / ${context.getState<number>('laps') ?? 3}`);
      }
      context.setState(progressKey(context.entityId), 0);
      context.setState(finishedKey(context.entityId), false);
    };

    /** Push out of any other craft's hull and bounce the velocity that was carrying into it. */
    const resolveCraftContacts = () => {
      for (const id of ids()) {
        if (id === context.entityId || !context.readTransform(id, other)) continue;
        const dx = position[0] - other[0];
        const dz = position[2] - other[2];
        if (Math.abs(position[1] - other[1]) > 2.5) continue;
        const distance = Math.hypot(dx, dz);
        const minimum = HULL_RADIUS * 2;
        if (distance >= minimum || distance < 1e-4) continue;
        const nx = dx / distance;
        const nz = dz / distance;
        const push = (minimum - distance) * 0.5;
        position[0] += nx * push;
        position[2] += nz * push;
        const into = vx * nx + vz * nz;
        if (into < 0) {
          vx -= nx * into * 1.4;
          vz -= nz * into * 1.4;
          if (-into > 12) takeDamage(2);
        }
      }
    };

    /**
     * Rails: probe along the velocity for the wall this step would reach and along both flanks for
     * one the hull already touches. Velocity into a wall is removed (with a little bounce) so the
     * craft slides along it, and the hull is kept a radius clear of the surface.
     */
    const resolveWallContacts = (delta: number) => {
      const moving = speed();
      rayOrigin[0] = position[0];
      rayOrigin[1] = position[1] - WALL_PROBE_DROP;
      rayOrigin[2] = position[2];
      if (moving > 1e-3) {
        rayDirection[0] = vx / moving;
        rayDirection[1] = 0;
        rayDirection[2] = vz / moving;
        const ahead = context.raycast(rayOrigin, rayDirection, HULL_RADIUS + moving * delta + 0.25);
        if (ahead.hit && Math.abs(ahead.normal[1]) < 0.6 && (ahead.entityId === null || !ids().includes(ahead.entityId))) {
          const horizontal = Math.hypot(ahead.normal[0], ahead.normal[2]) || 1;
          const nx = ahead.normal[0] / horizontal;
          const nz = ahead.normal[2] / horizontal;
          const into = vx * nx + vz * nz;
          if (into < 0) {
            const impact = -into;
            vx -= nx * into * 1.15;
            vz -= nz * into * 1.15;
            // Losing the wall-normal component scrubs speed; a shallow scrape barely slows down.
            const scrub = 1 - clamp(impact / Math.max(1, moving), 0, 1) * 0.45;
            vx *= scrub;
            vz *= scrub;
            if (impact > 8) {
              takeDamage(impact > 30 ? 8 : 3);
              if (isPlayer && !wrecked && shieldTimer <= 0) announce('SCRAPE');
            }
            const gap = ahead.distance - HULL_RADIUS;
            if (gap < 0) {
              position[0] += nx * -gap;
              position[2] += nz * -gap;
            }
          }
        }
      }
      const rx = -Math.cos(yaw);
      const rz = Math.sin(yaw);
      for (const side of SIDES) {
        rayDirection[0] = rx * side;
        rayDirection[1] = 0;
        rayDirection[2] = rz * side;
        const flank = context.raycast(rayOrigin, rayDirection, HULL_RADIUS);
        if (!flank.hit || Math.abs(flank.normal[1]) >= 0.6) continue;
        if (flank.entityId !== null && ids().includes(flank.entityId)) continue;
        const horizontal = Math.hypot(flank.normal[0], flank.normal[2]) || 1;
        const nx = flank.normal[0] / horizontal;
        const nz = flank.normal[2] / horizontal;
        const gap = HULL_RADIUS - flank.distance;
        position[0] += nx * gap;
        position[2] += nz * gap;
        const into = vx * nx + vz * nz;
        if (into < 0) {
          vx -= nx * into;
          vz -= nz * into;
        }
      }
    };

    /** Rivals trailing the player get a pace bonus, leaders a small penalty, scaled by skill. */
    const rivalPace = (): number => {
      if (isPlayer) return 1;
      const playerId = context.getState<string>('racer.player');
      if (!isJsonString(playerId)) return 0.85 + 0.15 * numberProperty(context, 'difficulty', 0.7);
      const playerProgress = context.getState<number>(progressKey(playerId)) ?? 0;
      const band = numberProperty(context, 'rubberBand', 0.05);
      const deficit = playerProgress - progress;
      const skill = clamp(numberProperty(context, 'difficulty', 0.7), 0, 1);
      return clamp(0.84 + 0.14 * skill + deficit * band, 0.7, 1.22);
    };

    const fixedUpdate = (delta: number) => {
      const racing = context.getState('raceState') === 'racing';
      const scale = numberProperty(context, 'speedScale', 1);
      const hoverHeight = numberProperty(context, 'hoverHeight', 1.25);
      const gravity = numberProperty(context, 'gravity', 28);

      if (isPlayer) readPlayerControls();
      else readRivalControls(delta, racing);

      if (wrecked) {
        respawnTimer -= delta;
        if (respawnTimer <= 0) respawn();
        return;
      }

      // Damage and pickups queued by other behaviors since the last step.
      const pendingDamage = context.getState<number>(damageKey(context.entityId)) ?? 0;
      if (pendingDamage > 0) {
        context.setState(damageKey(context.entityId), 0);
        takeDamage(pendingDamage);
        if (isPlayer && !wrecked) announce(shieldTimer > 0 ? 'SHIELD ABSORBED' : 'HIT');
        if (wrecked) return;
      }
      const pendingPickup = context.getState<string>(pickupKey(context.entityId));
      if (isJsonString(pendingPickup) && pendingPickup.length > 0) {
        context.setState(pickupKey(context.entityId), '');
        applyPickup(pendingPickup);
      }

      shieldTimer = Math.max(0, shieldTimer - delta);
      stunTimer = Math.max(0, stunTimer - delta);
      if (announceTimer > 0) {
        announceTimer -= delta;
        if (announceTimer <= 0) context.setState('announce', '');
      }

      const canDrive = racing && !finished;
      const throttle = canDrive ? controls.throttle : 0;
      const steer = canDrive ? clamp(controls.steer, -1, 1) : 0;
      const airLeft = canDrive && controls.airLeft;
      const airRight = canDrive && controls.airRight;
      const braking = airLeft && airRight;
      const drifting = (airLeft || airRight) && !braking;
      if (canDrive && controls.fire) useWeapon();

      // Boost: hold to burn the meter; drifting charges it back.
      boosting = canDrive && controls.boost && boost > 0 && !braking;
      if (boosting) boost = Math.max(0, boost - 28 * delta);
      else if (drifting) boost = Math.min(100, boost + 14 * delta);
      else boost = Math.min(100, boost + 2.5 * delta);

      // Frame split: forward and lateral velocity in the craft's own axes.
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const rx = -fz;
      const rz = fx;
      let forward = vx * fx + vz * fz;
      let lateral = vx * rx + vz * rz;

      const topSpeed = stats.topSpeed * scale * (boosting ? 1.28 : 1) * (stunTimer > 0 ? 0.7 : 1) * rivalPace();
      const acceleration = stats.acceleration * scale * (boosting ? stats.boostPower : 1);
      const drag = acceleration / Math.max(1, topSpeed);
      if (throttle > 0) forward += acceleration * throttle * delta;
      else if (throttle < 0 && forward > -10) forward -= (acceleration * 1.4 * -throttle + Math.max(0, forward) * 0.8) * delta;
      forward -= forward * Math.abs(forward) * (drag / Math.max(1, topSpeed)) * delta;
      if (braking) forward -= forward * 2.6 * delta;
      if (drifting) forward -= forward * 0.45 * delta;
      if (finished) forward -= forward * 1.2 * delta;
      if (!grounded) forward -= forward * 0.05 * delta;

      // Steering: full authority at low speed, slightly heavier at the top end; air brakes add
      // yaw on their side and let the tail step out.
      const speedFactor = 1.1 - clamp(Math.abs(forward) / Math.max(1, topSpeed), 0, 1) * 0.35;
      let yawRate = steer * stats.turnRate * speedFactor;
      if (airLeft && !braking) yawRate += stats.airbrakeTurn * (0.5 + 0.5 * Math.max(0, steer));
      if (airRight && !braking) yawRate -= stats.airbrakeTurn * (0.5 + 0.5 * Math.max(0, -steer));
      if (!grounded) yawRate *= 0.55;
      // A hover craft can pivot in place, just not as briskly as when it has air moving over the fins.
      const movingFactor = 0.4 + 0.6 * clamp(Math.abs(forward) / 6, 0, 1);
      yaw = wrapAngle(yaw + yawRate * movingFactor * delta);

      const grip = drifting ? stats.driftGrip : braking ? stats.grip * 1.5 : stats.grip;
      lateral *= Math.exp(-(grounded ? grip : grip * 0.35) * delta);

      // Rebuild the world velocity along the new heading.
      const nfx = -Math.sin(yaw);
      const nfz = -Math.cos(yaw);
      vx = nfx * forward + -nfz * lateral;
      vz = nfz * forward + nfx * lateral;

      // Track surface: probe straight down from inside the collider (a ray never hits the shape it
      // starts in) and spring toward hover height; free fall when nothing is below.
      const probeDrop = 0.2;
      rayOrigin[0] = position[0];
      rayOrigin[1] = position[1] - probeDrop;
      rayOrigin[2] = position[2];
      const hit = context.raycast(rayOrigin, DOWN, 60);
      const gap = hit.hit ? hit.distance - probeDrop : Number.POSITIVE_INFINITY;
      const wasGrounded = grounded;
      grounded = hit.hit && gap <= hoverHeight * 2.5;
      if (grounded) {
        const surfaceY = position[1] - gap;
        const floor = hoverHeight * 0.35;
        const stiffness = numberProperty(context, 'hoverStiffness', 60);
        const damping = numberProperty(context, 'hoverDamping', 10);
        vy += ((surfaceY + hoverHeight - position[1]) * stiffness - vy * damping) * delta;
        // Never let one step carry the craft through the surface: the probe starts inside the
        // collider and would lose the floor entirely if the craft sank below it.
        if (vy < 0) vy = Math.max(vy, -Math.max(0, gap - floor) / delta);
        if (gap < floor) {
          position[1] = surfaceY + floor;
          vy = Math.max(vy, 0);
        }
        airTime = 0;
        const nx = hit.normal[0];
        const ny = Math.max(0.2, hit.normal[1]);
        const nz = hit.normal[2];
        surfacePitch = Math.atan2(-(nx * nfx + nz * nfz), ny);
      } else {
        // Leaving a track edge at speed: the hover cushion's downward follow is cut so a fast craft
        // sails off the lip rather than diving after the surface it just lost.
        if (wasGrounded && Math.abs(forward) > 20) vy = Math.max(vy, -2);
        airTime += delta;
        vy -= gravity * delta;
        surfacePitch = approach(surfacePitch, -0.25, 1.5, delta);
      }
      if (!wasGrounded && grounded && airTime === 0 && vy < -12 && isPlayer) announce('HARD LANDING');
      vy = clamp(vy, -80, 40);

      resolveCraftContacts();
      resolveWallContacts(delta);

      desired[0] = position[0] + vx * delta;
      desired[1] = position[1] + vy * delta;
      desired[2] = position[2] + vz * delta;

      // Presentation: bank into the turn and with the drift, nose follows the slope.
      const targetRoll = clamp(yawRate * 0.22 + lateral * -0.012, -0.75, 0.75);
      roll = approach(roll, targetRoll, 9, delta);
      pitch = approach(pitch, surfacePitch + clamp(vy * 0.012, -0.3, 0.3), 8, delta);
      quatFromEuler(yaw, pitch, roll, rotation);

      position[0] = desired[0];
      position[1] = desired[1];
      position[2] = desired[2];
      context.moveKinematic(context.entityId, position, rotation);

      if (position[1] < numberProperty(context, 'killY', -40)) {
        if (isPlayer) announce('OFF THE CIRCUIT');
        respawn();
      }

      progress = trackProgress();
      context.setState(progressKey(context.entityId), progress);

      if (isPlayer) {
        const kmh = Math.round(speed() * 3.6);
        context.setState('speed', kmh);
        context.setState('racer.speed', speed());
        context.setState('racer.bank', roll);
        context.setState('racer.boosting', boosting);
        context.setState('boost', Math.round(boost));
        context.setState('energy', Math.max(0, Math.round((energy / stats.energy) * 100)));
        context.setState('shield', shieldTimer > 0);
        context.setState('weapon', WEAPON_LABELS[weapon]);
        const laps = context.getState<number>('laps') ?? 3;
        context.setState('lap', `${clamp(lap, 1, laps)} / ${laps}`);
      }

      if (boltTimer > 0 && boltId) {
        boltTimer -= delta;
        const bfx = -2 * (boltRotation[0] * boltRotation[2] + boltRotation[3] * boltRotation[1]);
        const bfz = -(1 - 2 * (boltRotation[0] * boltRotation[0] + boltRotation[1] * boltRotation[1]));
        boltPosition[0] += bfx * 150 * delta;
        boltPosition[2] += bfz * 150 * delta;
        context.moveKinematic(boltId, boltPosition, boltRotation);
        if (boltTimer <= 0) context.setBodyEnabled(boltId, false);
      }
    };

    return { start, fixedUpdate };
  },
};

/**
 * Chase camera that banks with the craft, sits lower and pulls back as speed climbs, and looks
 * ahead through the corner.
 */
export const racerChaseCamera: BehaviorDefinition = {
  id: 'racer.chase-camera',
  name: 'Racer Chase Camera',
  description: 'Low chase camera that banks into turns and pulls back with speed. Reads the player craft written by Racer Craft.',
  properties: [
    entity('target', 'Target', 'Craft to follow. Defaults to the entity named "Player".'),
    number('distance', 'Distance', 7.5, { min: 1, max: 40, step: 0.5 }),
    number('height', 'Height', 2.4, { min: 0, max: 20, step: 0.1 }),
    number('lookAhead', 'Look ahead', 14, { min: 0, max: 60, step: 1, description: 'Metres in front of the craft the camera aims at.' }),
    number('bank', 'Bank amount', 0.7, { min: 0, max: 1.5, step: 0.05, description: 'How much of the craft\'s roll the camera copies.' }),
    number('speedPullback', 'Speed pull-back', 0.045, { min: 0, max: 0.2, step: 0.005, description: 'Extra distance per m/s of craft speed.' }),
    number('damping', 'Position smoothing', 0.07, { min: 0, max: 1, step: 0.01 }),
    number('rollDamping', 'Bank smoothing', 0.16, { min: 0, max: 1, step: 0.01, advanced: true }),
  ],
  create(context): BehaviorInstance {
    const target = new Float32Array(7);
    const current: Vec3 = [0, 0, 0];
    const desired: Vec3 = [0, 0, 0];
    const aim: Vec3 = [0, 0, 0];
    const rotation: Quat = [0, 0, 0, 1];
    let resolved: string | null = null;
    let roll = 0;
    let primed = false;

    const resolveTarget = (): string | null => {
      const configured = stringProperty(context, 'target', '');
      if (configured.length > 0) return context.findEntityById(configured) ?? context.findEntityByName(configured);
      return context.findEntityByName('Player');
    };

    return {
      start() {
        resolved = resolveTarget();
        primed = false;
      },
      update(frameDelta) {
        if (!resolved) resolved = resolveTarget();
        if (!resolved || !context.readTransform(resolved, target)) return;
        const yaw = yawOf(target);
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const speed = context.getState<number>('racer.speed') ?? 0;
        const bank = context.getState<number>('racer.bank') ?? 0;
        const boosting = context.getState('racer.boosting') === true;

        const distance = numberProperty(context, 'distance', 7.5) + speed * numberProperty(context, 'speedPullback', 0.045) + (boosting ? 1.2 : 0);
        const height = numberProperty(context, 'height', 2.4) - Math.min(0.9, speed * 0.008);
        desired[0] = target[0] - fx * distance;
        desired[1] = target[1] + height;
        desired[2] = target[2] - fz * distance;

        const damping = numberProperty(context, 'damping', 0.07);
        const blend = primed && damping > 0 ? 1 - Math.exp(-frameDelta / damping) : 1;
        current[0] += (desired[0] - current[0]) * blend;
        current[1] += (desired[1] - current[1]) * blend;
        current[2] += (desired[2] - current[2]) * blend;
        primed = true;

        const lookAhead = numberProperty(context, 'lookAhead', 14);
        aim[0] = target[0] + fx * lookAhead;
        aim[1] = target[1] + 0.6;
        aim[2] = target[2] + fz * lookAhead;

        const rollDamping = numberProperty(context, 'rollDamping', 0.16);
        const rollBlend = rollDamping > 0 ? 1 - Math.exp(-frameDelta / rollDamping) : 1;
        roll += (bank * numberProperty(context, 'bank', 0.7) - roll) * rollBlend;

        quatLookAt(current, aim, roll, rotation);
        context.moveKinematic(context.entityId, current, rotation);
      },
    };
  },
};

/** Spinning pickup: weapon, shield, energy, or a boost pad any craft can take. */
export const racerPickup: BehaviorDefinition = {
  id: 'racer.pickup',
  name: 'Racer Pickup',
  description: 'Grants a weapon, shield, energy or boost to any craft that flies through it, then respawns.',
  properties: [
    choice('kind', 'Kind', 'pulse', ['pulse', 'shock', 'shield', 'energy', 'boost']),
    number('radius', 'Pickup radius', 2.6, { min: 0.5, max: 12, step: 0.1 }),
    number('respawnSeconds', 'Respawn after (s)', 7, { min: 0, max: 120, step: 0.5, description: '0 keeps the pickup active for everyone, with a short per-craft cooldown (boost pads).' }),
    number('spinSpeed', 'Spin speed', 2.2, { min: 0, max: 20, step: 0.1, group: 'Motion' }),
    number('bobHeight', 'Bob height', 0.25, { min: 0, max: 3, step: 0.05, group: 'Motion' }),
  ],
  create(context): BehaviorInstance {
    const home = new Float32Array(7);
    const other = new Float32Array(7);
    const position: Vec3 = [0, 0, 0];
    const rotation: Quat = [0, 0, 0, 1];
    const crafts = createCraftIdCache();
    const cooldowns = new Map<string, number>();
    let time = 0;
    let hiddenFor = 0;

    return {
      start() {
        context.readTransform(context.entityId, home);
        time = 0;
        hiddenFor = 0;
        cooldowns.clear();
      },
      fixedUpdate(delta) {
        time += delta;
        const kind = stringProperty(context, 'kind', 'pulse');
        const respawn = numberProperty(context, 'respawnSeconds', 7);
        for (const [id, remaining] of cooldowns) {
          if (remaining - delta <= 0) cooldowns.delete(id);
          else cooldowns.set(id, remaining - delta);
        }

        if (hiddenFor > 0) {
          hiddenFor -= delta;
          if (hiddenFor <= 0) context.setBodyEnabled(context.entityId, true);
          return;
        }

        const spin = numberProperty(context, 'spinSpeed', 2.2);
        position[0] = home[0];
        position[1] = home[1] + Math.sin(time * 2.4) * numberProperty(context, 'bobHeight', 0.25);
        position[2] = home[2];
        quatFromEuler(time * spin, 0, 0, rotation);
        context.moveKinematic(context.entityId, position, rotation);

        const radius = numberProperty(context, 'radius', 2.6);
        for (const id of craftIds(context, crafts)) {
          if (cooldowns.has(id) || !context.readTransform(id, other)) continue;
          const distance = Math.hypot(other[0] - home[0], other[1] - home[1], other[2] - home[2]);
          if (distance > radius) continue;
          context.setState(pickupKey(id), kind);
          cooldowns.set(id, 1.5);
          if (respawn > 0) {
            hiddenFor = respawn;
            context.setBodyEnabled(context.entityId, false);
            break;
          }
        }
      },
    };
  },
};

/**
 * Race director: countdown, ranking, lap count and the finish.
 *
 * Craft register their own progress; the director only needs their names to rank them and to
 * publish the id list that pickups and weapons iterate.
 */
export const racerDirector: BehaviorDefinition = {
  id: 'racer.director',
  name: 'Race Director',
  description: 'Runs the countdown, ranks every craft by lap progress, and shows the win or lose overlay when the player finishes.',
  properties: [
    text('crafts', 'Craft entity names', 'Player', 'Comma-separated names of every racing craft, player included.'),
    number('laps', 'Laps', 3, { min: 1, max: 20, step: 1 }),
    number('countdownSeconds', 'Countdown (s)', 3, { min: 0, max: 10, step: 0.5 }),
    number('podiumPlaces', 'Podium places', 1, { min: 1, max: 8, step: 1, description: 'Finishing at or above this place counts as a win.' }),
    text('winMessage', 'Win message', 'CHAMPION OF THE ŌMAGATOKI CIRCUIT'),
  ],
  create(context): BehaviorInstance {
    let ids: string[] = [];
    let countdown = 0;
    let lastTick = -1;
    let raceTime = 0;
    let decided = false;
    let playerId: string | null = null;
    const ranked: Array<{ id: string; progress: number }> = [];

    const setObjective = (value: string) => context.setState('objective', value);

    return {
      start() {
        ids = [];
        for (const rawName of stringProperty(context, 'crafts', 'Player').split(',')) {
          const name = rawName.trim();
          if (name.length === 0) continue;
          const id = context.findEntityByName(name) ?? context.findEntityById(name);
          if (id) ids.push(id);
          else context.log(`Race Director: no entity named "${name}"`);
        }
        ranked.length = 0;
        for (const id of ids) ranked.push({ id, progress: 0 });
        context.setState('racer.crafts', ids.join(','));
        context.setState('laps', numberProperty(context, 'laps', 3));
        context.setState('raceState', 'countdown');
        context.setState('started', false);
        context.setState('won', false);
        context.setState('lost', false);
        context.setState('place', `- / ${ids.length}`);
        context.setState('raceTime', '0:00.00');
        context.setState('announce', '');
        countdown = numberProperty(context, 'countdownSeconds', 3);
        lastTick = -1;
        raceTime = 0;
        decided = false;
        setObjective('PRESS 1 · 2 · 3 TO CHOOSE A CRAFT');
        context.showOverlay('start');
      },
      fixedUpdate(delta) {
        if (context.getState('started') !== true) return;
        const state = context.getState('raceState');
        if (state === 'countdown') {
          countdown -= delta;
          const tick = Math.ceil(countdown);
          if (countdown <= 0) {
            context.setState('raceState', 'racing');
            setObjective('GO!');
            lastTick = 0;
          } else if (tick !== lastTick) {
            lastTick = tick;
            setObjective(`${tick}`);
          }
          return;
        }

        raceTime += delta;
        if (lastTick === 0 && raceTime > 1.2) {
          lastTick = -1;
          setObjective('');
        }
        const minutes = Math.floor(raceTime / 60);
        const seconds = raceTime - minutes * 60;
        context.setState('raceTime', `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`);

        if (!playerId) {
          const configured = context.getState<string>('racer.player');
          playerId = isJsonString(configured) ? configured : null;
        }
        for (const entry of ranked) entry.progress = context.getState<number>(progressKey(entry.id)) ?? 0;
        ranked.sort((a, b) => b.progress - a.progress);
        if (!playerId) return;
        let place = ranked.findIndex((entry) => entry.id === playerId) + 1;
        if (place <= 0) place = ranked.length;
        context.setState('place', `${place} / ${ranked.length}`);

        if (decided || context.getState(finishedKey(playerId)) !== true) return;
        decided = true;
        context.setState('raceState', 'finished');
        const podium = numberProperty(context, 'podiumPlaces', 1);
        const ordinal = ORDINALS[place - 1] ?? `${place}TH`;
        if (place <= podium) {
          context.setState('won', true);
          setObjective(stringProperty(context, 'winMessage', 'CHAMPION'));
          context.showOverlay('win');
        } else {
          context.setState('lost', true);
          setObjective(`FINISHED ${ordinal}`);
          context.showOverlay('lose');
        }
      },
      update() {
        if (context.wasActionPressed('restart')) context.requestRestart();
      },
    };
  },
};

export const RACER_BEHAVIORS: BehaviorDefinition[] = [racerCraft, racerChaseCamera, racerPickup, racerDirector];
