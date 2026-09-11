import type { JsonValue } from '@schema/index.js';

import type { BehaviorContext, BehaviorDefinition, BehaviorInstance, BehaviorPropertyDescriptor } from './types.js';

/**
 * The first behavior library (plan §10).
 *
 * A character mover, a follow/fixed camera, interactables, collectible/trigger logic, a
 * score/win/restart loop, and animation/audio playback. Indexed access is enabled so a single
 * behavior can be registered from a scene document without a custom factory.
 *
 * Every property is declared here once: the inspector renders it, the validator checks it,
 * and the build verifies TypeScript registrations against the same contract.
 */

const number = (
  key: string,
  label: string,
  value: number,
  extra: Partial<BehaviorPropertyDescriptor> = {},
): BehaviorPropertyDescriptor => ({ key, label, type: 'number', default: value, ...extra });
const boolean = (key: string, label: string, value: boolean, help?: string): BehaviorPropertyDescriptor => ({
  key,
  label,
  type: 'boolean',
  default: value,
  description: help,
});
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

const DEG = Math.PI / 180;

/**
 * Distance between two entities in the running world, or Infinity when either is missing.
 *
 * Triggers use this as well as physics events. Sensor events are the primary path, but a
 * character whose body is driven by `setTransform` does not always produce a fresh begin event
 * when it is placed inside a sensor, and a trigger that silently fails to fire is worse than a
 * documented fallback. The radius is an authored property, so nothing is hidden.
 */
function distanceBetween(context: BehaviorContext, a: string | null, b: string): number {
  if (!a) return Number.POSITIVE_INFINITY;
  const first = context.scratch.transform;
  const second = new Float32Array(7);
  if (!context.readTransform(a, first) || !context.readTransform(b, second)) return Number.POSITIVE_INFINITY;
  return Math.hypot(first[0]! - second[0]!, first[1]! - second[1]!, first[2]! - second[2]!);
}

const isJsonNumber = (value: JsonValue | undefined): value is number => typeof value === 'number';
const isJsonString = (value: JsonValue | undefined): value is string => typeof value === 'string';
const isJsonBoolean = (value: JsonValue | undefined): value is boolean => typeof value === 'boolean';

/**
 * Read a declared numeric property once, falling back when the scene omitted it or stored a value
 * of another shape. The fallback always repeats the default declared in the behavior's
 * `properties` array, which is defensive: declared defaults are merged with stored values.
 */
const numberProperty = (context: BehaviorContext, key: string, fallback: number): number => {
  const value = context.properties[key];
  return isJsonNumber(value) && Number.isFinite(value) ? value : fallback;
};

/** Read a declared text property once, falling back when the scene omitted it. */
const stringProperty = (context: BehaviorContext, key: string, fallback: string): string => {
  const value = context.properties[key];
  return isJsonString(value) ? value : fallback;
};

/**
 * Read a declared boolean property once, falling back when the scene omitted it.
 *
 * Only an explicit `false` is false: any other stored JSON value (a missing key, `null`, a
 * number) yields the fallback, which is how the `property !== false` idiom this replaces reads.
 */
const booleanProperty = (context: BehaviorContext, key: string, fallback: boolean): boolean => {
  const value = context.properties[key];
  return isJsonBoolean(value) ? value : fallback;
};

/** Resolve the player entity from a behavior's property, falling back to the name "Player". */
function playerId(context: BehaviorContext): string | null {
  const configured = stringProperty(context, 'playerName', '');
  if (configured.length > 0) {
    return context.findEntityByName(configured) ?? context.findEntityById(configured);
  }
  return context.findEntityByName('Player');
}

/**
 * Quaternion that aims an entity's local -Z axis from `from` at `to`.
 *
 * The engine's forward convention is -Z (matching cameras), so a follow camera has to be
 * rotated every tick. Moving the camera without re-aiming it leaves it staring at whatever its
 * authored rotation pointed at.
 */
function quaternionLookAt(from: [number, number, number], to: [number, number, number]): [number, number, number, number] {
  const zx = from[0] - to[0];
  const zy = from[1] - to[1];
  const zz = from[2] - to[2];
  const zLength = Math.hypot(zx, zy, zz) || 1;
  const z: [number, number, number] = [zx / zLength, zy / zLength, zz / zLength];

  // right = normalize(cross(up, z)) with up = (0, 1, 0)
  let xx = z[2];
  let xy = 0;
  let xz = -z[0];
  const xLength = Math.hypot(xx, xy, xz);
  if (xLength < 1e-6) {
    // Looking straight up or down: pick any perpendicular axis.
    xx = 1;
    xy = 0;
    xz = 0;
  } else {
    xx /= xLength;
    xy /= xLength;
    xz /= xLength;
  }

  // y = cross(z, x)
  const yx = z[1] * xz - z[2] * xy;
  const yy = z[2] * xx - z[0] * xz;
  const yz = z[0] * xy - z[1] * xx;

  // Rotation matrix columns are the basis vectors.
  const m00 = xx, m01 = yx, m02 = z[0];
  const m10 = xy, m11 = yy, m12 = z[1];
  const m20 = xz, m21 = yz, m22 = z[2];
  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const scale = Math.sqrt(trace + 1) * 2;
    return [(m21 - m12) / scale, (m02 - m20) / scale, (m10 - m01) / scale, 0.25 * scale];
  }
  if (m00 > m11 && m00 > m22) {
    const scale = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * scale, (m01 + m10) / scale, (m02 + m20) / scale, (m21 - m12) / scale];
  }
  if (m11 > m22) {
    const scale = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / scale, 0.25 * scale, (m12 + m21) / scale, (m02 - m20) / scale];
  }
  const scale = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / scale, (m12 + m21) / scale, 0.25 * scale, (m10 - m01) / scale];
}

/**
 * Character mover: walks a kinematic capsule around the XZ plane with gravity and jumping.
 *
 * Movement goes through the physics adapter — the body is kinematic, so the mover writes its
 * transform every fixed step and the physics world remains the authority on collisions.
 */
export const playerMover: BehaviorDefinition = {
  id: 'player.mover',
  name: 'Character Mover',
  description: 'Moves a kinematic body with WASD/arrow input, gravity, and optional jumping.',
  properties: [
    number('moveSpeed', 'Move speed', 5, { min: 0, max: 40, step: 0.5, group: 'Movement' }),
    number('jumpStrength', 'Jump strength', 7, { min: 0, max: 30, step: 0.5, group: 'Movement', description: 'Set to 0 to disable jumping.' }),
    number('gravity', 'Gravity', 20, { min: 0, max: 80, step: 1, group: 'Movement' }),
    number('turnSpeed', 'Turn speed', 12, { min: 0, max: 60, step: 1, group: 'Movement', description: 'How quickly the character faces its movement direction, in radians per second.' }),
    number('acceleration', 'Acceleration', 40, { min: 1, max: 200, step: 1, group: 'Movement', advanced: true }),
    number('groundCheckDistance', 'Ground check', 0.35, { min: 0.05, max: 2, step: 0.05, group: 'Movement', advanced: true }),
    number('spawnHeight', 'Spawn height', 1, { min: 0, max: 10, step: 0.1, group: 'Movement', advanced: true, description: 'Height above the authored position where the character starts.' }),
  ],
  create(context): BehaviorInstance {
    const velocity = { x: 0, y: 0, z: 0 };
    const position: [number, number, number] = [0, 0, 0];
    let grounded = false;
    let yaw = 0;
    const transform = new Float32Array(7);

    const start = () => {
      if (!context.isPhysicsBody(context.entityId)) {
        context.log('Character Mover needs a kinematic rigid body on this entity');
        return;
      }
      context.readTransform(context.entityId, transform);
      position[0] = transform[0];
      position[1] = transform[1] + numberProperty(context, 'spawnHeight', 1);
      position[2] = transform[2];
      context.moveKinematic(context.entityId, position, [0, 0, 0, 1]);
      context.setBodyType(context.entityId, 'kinematic');
    };

    const fixedUpdate = (delta: number) => {
      const speed = numberProperty(context, 'moveSpeed', 5);
      const jump = numberProperty(context, 'jumpStrength', 7);
      const gravity = numberProperty(context, 'gravity', 20);
      const acceleration = numberProperty(context, 'acceleration', 40);
      const turnSpeed = numberProperty(context, 'turnSpeed', 12);
      const groundCheck = numberProperty(context, 'groundCheckDistance', 0.35);

      const axis = context.moveAxis();
      const targetX = axis.x * speed;
      const targetZ = axis.y * speed;
      const blend = Math.min(1, acceleration * delta / Math.max(1, speed));
      velocity.x += (targetX - velocity.x) * blend;
      velocity.z += (targetZ - velocity.z) * blend;

      // Ground probe: straight down from just above the capsule's feet, so the ray origin is
      // never exactly on a surface (where a cast reports no hit at all).
      const probeOffset = 0.05;
      const probe = context.raycast([position[0], position[1] + probeOffset, position[2]], [0, -1, 0], groundCheck + probeOffset);
      const surfaceGap = probe.hit ? probe.distance - probeOffset : Number.POSITIVE_INFINITY;
      grounded = surfaceGap <= groundCheck;

      if (grounded && jump > 0 && context.wasActionPressed('jump')) velocity.y = jump;
      velocity.y -= gravity * delta;
      if (grounded && velocity.y <= 0) {
        velocity.y = 0;
        // Snap the feet onto the surface. Cancelling gravity alone is not enough: the body
        // would hover wherever the probe first reached, and integrating gravity before the
        // clamp would sink it a few millimetres per tick until it fell through the floor.
        position[1] -= surfaceGap;
      }
      if (velocity.y < -60) velocity.y = -60;

      position[0] += velocity.x * delta;
      position[1] += velocity.y * delta;
      position[2] += velocity.z * delta;

      if (Math.hypot(velocity.x, velocity.z) > 0.05) {
        // Forward is local -Z, so moving along (x, z) means facing (-x, -z).
        const target = Math.atan2(-velocity.x, -velocity.z);
        let difference = target - yaw;
        while (difference > Math.PI) difference -= Math.PI * 2;
        while (difference < -Math.PI) difference += Math.PI * 2;
        yaw += difference * Math.min(1, turnSpeed * delta);
      }
      const half = yaw / 2;
      // Swept move: a wall stops the character instead of letting it walk through, and a diagonal
      // push slides along the wall. `position` comes back resolved, so nothing drifts.
      context.moveCharacter(context.entityId, position, [0, Math.sin(half), 0, Math.cos(half)]);
    };

    return {
      start,
      fixedUpdate,
      update: () => {
        // Keep the authored spawn honest while the game runs: report the grounded state so a
        // HUD label can bind to it.
        context.setState('playerGrounded', grounded);
      },
    };
  },
};

/** Follow or fixed camera aimed at a target entity. */
export const cameraFollow: BehaviorDefinition = {
  id: 'camera.follow',
  name: 'Camera Follow',
  description: 'Keeps a camera behind and above a target, or at a fixed offset from it.',
  properties: [
    entity('target', 'Target', 'The entity to follow. Defaults to the entity named "Player".'),
    number('distance', 'Distance', 8, { min: 0, max: 40, step: 0.5, description: 'Used when following behind the target.' }),
    number('height', 'Height', 5, { min: 0, max: 30, step: 0.5 }),
    number('offsetX', 'Fixed offset X', 6, { min: -60, max: 60, step: 0.5, description: 'Used when "Fixed world offset" is on, in metres.' }),
    number('offsetZ', 'Fixed offset Z', 6, { min: -60, max: 60, step: 0.5, description: 'Used when "Fixed world offset" is on, in metres.' }),
    number('damping', 'Smoothing', 0.12, { min: 0, max: 2, step: 0.02 }),
    number('lookHeight', 'Look at height', 1, { min: 0, max: 5, step: 0.1, description: 'Height above the target the camera aims at.' }),
    boolean('fixed', 'Fixed world offset', false, 'Keep a world-space offset instead of following behind the target.'),
  ],
  create(context): BehaviorInstance {
    const target = new Float32Array(7);
    const desired: [number, number, number] = [0, 0, 0];
    const current: [number, number, number] = [0, 0, 0];
    const forward: [number, number, number] = [0, 0, -1];
    let resolved: string | null = null;

    const resolveTarget = (): string | null => {
      const configured = stringProperty(context, 'target', '');
      if (configured.length > 0) {
        return context.findEntityById(configured) ?? context.findEntityByName(configured);
      }
      return context.findEntityByName('Player') ?? context.entityId;
    };

    return {
      start() {
        resolved = resolveTarget();
        context.readTransform(context.entityId, target);
        current[0] = target[0];
        current[1] = target[1];
        current[2] = target[2];
      },
      update(frameDelta) {
        if (!resolved) resolved = resolveTarget();
        if (!resolved) return;
        if (!context.readTransform(resolved, target)) return;

        const distance = numberProperty(context, 'distance', 8);
        const height = numberProperty(context, 'height', 5);
        const damping = numberProperty(context, 'damping', 0.12);
        const lookHeight = numberProperty(context, 'lookHeight', 1);
        const fixed = booleanProperty(context, 'fixed', false);

        if (fixed) {
          // A fixed offset in world space: the camera does not swing when the target turns. The
          // offset is authored in metres rather than derived from `distance`, so what you set is
          // what you get.
          desired[0] = target[0] + numberProperty(context, 'offsetX', 6);
          desired[1] = target[1] + height;
          desired[2] = target[2] + numberProperty(context, 'offsetZ', 6);
        } else {
          // Behind the target along its own -Z (the engine's forward axis), lifted by height.
          forward[0] = -2 * (target[3] * target[5] + target[6] * target[4]);
          forward[1] = 0;
          forward[2] = -(1 - 2 * (target[3] * target[3] + target[4] * target[4]));
          const length = Math.hypot(forward[0], forward[2]) || 1;
          desired[0] = target[0] - (forward[0] / length) * distance;
          desired[1] = target[1] + height;
          desired[2] = target[2] - (forward[2] / length) * distance;
        }

        // Exponential smoothing that behaves the same at any frame rate.
        const blend = damping <= 0 ? 1 : 1 - Math.exp(-frameDelta / damping);
        current[0] += (desired[0] - current[0]) * blend;
        current[1] += (desired[1] - current[1]) * blend;
        current[2] += (desired[2] - current[2]) * blend;

        // Aim at the target every frame: a camera that only moves keeps staring wherever its
        // authored rotation pointed.
        const rotation = quaternionLookAt(current, [target[0], target[1] + lookHeight, target[2]]);
        context.moveKinematic(context.entityId, current, rotation);
      },
    };
  },
};

/** Collectible: a sensor that disappears and increments a score when the player touches it. */
export const collectible: BehaviorDefinition = {
  id: 'game.collectible',
  name: 'Collectible',
  description: 'Adds to the score when the player touches it, then disappears. Needs a sensor collider.',
  properties: [
    number('value', 'Score value', 1, { min: 0, max: 100, step: 1 }),
    text('playerName', 'Player entity name', 'Player'),
    boolean('hideOnCollect', 'Hide when collected', true),
    number('pickupRadius', 'Pickup radius', 1.2, { min: 0.1, max: 10, step: 0.1, advanced: true, description: 'Distance at which the pickup is collected even if no sensor event arrives.' }),
  ],
  create(context): BehaviorInstance {
    let collected = false;

    const collect = () => {
      if (collected) return;
      collected = true;
      const value = numberProperty(context, 'value', 1);
      context.setState('score', (context.getState<number>('score') ?? 0) + value);
      const remaining = context.getState('collectiblesRemaining');
      if (isJsonNumber(remaining)) context.setState('collectiblesRemaining', Math.max(0, remaining - 1));
      if (booleanProperty(context, 'hideOnCollect', true)) context.setBodyEnabled(context.entityId, false);
      context.emit('collected', { entityId: context.entityId, value });
      context.log(`collected (value ${value})`);
    };

    return {
      onPhysicsEvent(event) {
        if (event.kind !== 'sensorBegin') return;
        const player = playerId(context);
        if (player && event.other !== player) return;
        collect();
      },
      fixedUpdate() {
        if (collected) return;
        const player = playerId(context);
        if (!player) return;
        if (distanceBetween(context, context.entityId, player) <= numberProperty(context, 'pickupRadius', 1.2)) collect();
      },
    };
  },
};

/** Exit zone: wins the level once the required score (or collection count) is reached. */
export const exitZone: BehaviorDefinition = {
  id: 'game.exit-zone',
  name: 'Exit Zone',
  description: 'Wins the level when the player enters it with enough collectibles gathered.',
  properties: [
    text('playerName', 'Player entity name', 'Player'),
    number('requiredScore', 'Required score', 3, { min: 0, max: 100, step: 1, description: '0 means the exit is always open.' }),
    text('winMessage', 'Win message', 'You escaped!'),
    number('triggerRadius', 'Trigger radius', 1.8, { min: 0.2, max: 20, step: 0.1, advanced: true, description: 'Distance at which the exit counts as reached without a sensor event.' }),
    boolean('repeatable', 'Can trigger again', false),
  ],
  create(context): BehaviorInstance {
    let triggered = false;
    const attempt = () => {
      if (triggered && !booleanProperty(context, 'repeatable', false)) return;
      const required = numberProperty(context, 'requiredScore', 0);
      const score = context.getState<number>('score') ?? 0;
      if (score < required) {
        context.setState('objective', `Collect ${required - score} more`);
        return;
      }
      triggered = true;
      context.setState('won', true);
      context.setState('objective', stringProperty(context, 'winMessage', 'You escaped!'));
      context.showOverlay('win');
      context.requestAction('none');
    };

    return {
      onPhysicsEvent(event) {
        if (event.kind !== 'sensorBegin') return;
        const player = playerId(context);
        if (player && event.other !== player) return;
        attempt();
      },
      fixedUpdate() {
        // Keep checking while the player stands in the exit: a player who arrives before
        // collecting everything must win by collecting the last gem, not by leaving and
        // re-entering.
        const player = playerId(context);
        if (!player) return;
        if (distanceBetween(context, context.entityId, player) <= numberProperty(context, 'triggerRadius', 1.8)) attempt();
      },
    };
  },
};

/** Score and flow rules: win/lose overlay, restart, and scene transitions. */
export const gameRules: BehaviorDefinition = {
  id: 'game.rules',
  name: 'Game Rules',
  description: 'Watches score and time, shows the win or lose overlay, and handles restart.',
  properties: [
    number('scoreTarget', 'Score target', 3, {
      min: 0,
      max: 100,
      step: 1,
      description: 'Wins the level as soon as the score reaches this value. 0 disables the score-only win and leaves the exit to decide.',
    }),
    number('timeLimit', 'Time limit (s)', 0, { min: 0, max: 3600, step: 5, description: '0 disables the time limit.' }),
    text('initialObjective', 'Initial objective', '', 'Shown in the HUD label bound to "objective" until something replaces it.'),
    text('nextScene', 'Next scene', '', 'Scene to load after winning. Empty restarts the current scene.'),
    boolean('showStartOverlay', 'Show start overlay', true),
    boolean('waitForStart', 'Clock waits for start', true, 'Only count the time limit after the start overlay is dismissed.'),
    boolean('allowRestartKey', 'Restart with R', true),
  ],
  create(context): BehaviorInstance {
    // The clock counts fixed simulation steps, not wall time: pausing stops it, Step advances it
    // by exactly one tick, and a backgrounded tab cannot burn the player's time.
    let elapsed = 0;
    const limit = (): number => numberProperty(context, 'timeLimit', 0);

    return {
      start() {
        context.setState('scoreTarget', numberProperty(context, 'scoreTarget', 0));
        elapsed = 0;
        context.setState('timeRemaining', limit());
        context.setState('objective', stringProperty(context, 'initialObjective', ''));
        // The clock only runs once the round has actually started: counting it down behind the
        // start overlay would silently eat the player's time.
        const waits = booleanProperty(context, 'waitForStart', true) && booleanProperty(context, 'showStartOverlay', true);
        if (waits) context.setState('started', false);
        else context.setState('started', true);
        if (booleanProperty(context, 'showStartOverlay', true)) context.showOverlay('start');
        else context.showOverlay(null);
      },
      fixedUpdate(delta) {
        if (limit() > 0 && context.getState('started') !== false) {
          elapsed += delta;
          const next = Math.max(0, limit() - elapsed);
          context.setState('timeRemaining', Number(next.toFixed(2)));
          // A win is final: running the clock out afterwards must not flip a finished round to a
          // loss.
          if (next <= 0 && context.getState('lost') !== true && context.getState('won') !== true) {
            context.setState('lost', true);
            context.showOverlay('lose');
          }
        }
      },
      update() {
        const target = numberProperty(context, 'scoreTarget', 0);
        const score = context.getState<number>('score') ?? 0;
        if (target > 0 && score >= target && context.getState('won') !== true) {
          context.setState('won', true);
          context.showOverlay('win');
        }

        if (booleanProperty(context, 'allowRestartKey', true) && context.wasActionPressed('restart')) {
          context.requestRestart();
        }
      },
    };
  },
};


/** Launch a physics body when the player clicks; used by the target game. */
export const projectileLauncher: BehaviorDefinition = {
  id: 'game.launcher',
  name: 'Projectile Launcher',
  description: 'Applies an impulse to a body when the player clicks, aiming from the camera.',
  properties: [
    number('impulse', 'Impulse', 9, { min: 0, max: 100, step: 0.5 }),
    number('upward', 'Upward bias', 0.25, { min: 0, max: 2, step: 0.05 }),
    text('projectileName', 'Projectile entity name', 'Ball'),
    boolean('resetAfterLaunch', 'Reset if it falls', true),
    number('resetBelowY', 'Reset below Y', -5, { min: -50, max: 0, step: 0.5 }),
  ],
  create(context): BehaviorInstance {
    const transform = new Float32Array(7);
    const home: [number, number, number] = [0, 0, 0];
    let launched = false;

    return {
      start() {
        context.readTransform(context.entityId, transform);
        home[0] = transform[0];
        home[1] = transform[1];
        home[2] = transform[2];
      },
      update() {
        if (context.wasActionPressed('primary')) {
          const impulse = numberProperty(context, 'impulse', 9);
          const upward = numberProperty(context, 'upward', 0.25);
          const pointer = context.pointer();
          // Aim mostly forward with a horizontal bias from the click, which is enough to make
          // clicking different targets feel deliberate without a full aiming rig.
          context.applyImpulse(context.entityId, [pointer.x * impulse, impulse * upward, -impulse]);
          launched = true;
          context.setState('launches', (context.getState<number>('launches') ?? 0) + 1);
        }

        if (!launched || !booleanProperty(context, 'resetAfterLaunch', true)) return;
        context.readTransform(context.entityId, transform);
        const limit = numberProperty(context, 'resetBelowY', -5);
        if (transform[1] < limit) {
          context.setBodyType(context.entityId, 'dynamic');
          context.setLinearVelocity(context.entityId, [0, 0, 0]);
          context.moveKinematic(context.entityId, home, [0, 0, 0, 1]);
          context.setBodyType(context.entityId, 'dynamic');
          launched = false;
        }
      },
    };
  },
};

/** Target: counts a knockdown when the body tilts past the threshold or is hit hard enough. */
export const knockDownTarget: BehaviorDefinition = {
  id: 'game.target',
  name: 'Knock-down Target',
  description: 'Counts a hit when this body tips past an angle or takes a hard impact.',
  properties: [
    number('tipAngle', 'Tip angle', 45, { min: 5, max: 90, step: 1 }),
    number('minImpactSpeed', 'Minimum impact speed', 1.5, { min: 0, max: 40, step: 0.1 }),
    number('value', 'Score value', 1, { min: 0, max: 10, step: 1 }),
  ],
  create(context): BehaviorInstance {
    const transform = new Float32Array(7);
    let down = false;

    const knockDown = (reason: string) => {
      if (down) return;
      down = true;
      const value = numberProperty(context, 'value', 1);
      context.setState('score', (context.getState<number>('score') ?? 0) + value);
      context.setState('targetsDown', (context.getState<number>('targetsDown') ?? 0) + 1);
      context.emit('targetDown', { entityId: context.entityId });
      context.log(`knocked down (${reason})`);
    };

    return {
      onPhysicsEvent(event) {
        if (event.kind !== 'hit') return;
        const minimum = numberProperty(context, 'minImpactSpeed', 1.5);
        if ((event.approachSpeed ?? 0) >= minimum) knockDown('impact');
      },
      fixedUpdate() {
        if (down) return;
        if (!context.readTransform(context.entityId, transform)) return;
        // Rotation quaternion -> how far the local up axis has tipped from world up. A successful
        // readTransform wrote 7 floats, and the adapter stores the quaternion in slots 3..6.
        const qx = transform[3]!;
        const qz = transform[5]!;
        const upY = 1 - 2 * (qx * qx + qz * qz);
        const angle = Math.acos(Math.max(-1, Math.min(1, upY))) / DEG;
        const threshold = numberProperty(context, 'tipAngle', 45);
        if (angle >= threshold) knockDown(`tilted ${angle.toFixed(0)}°`);
      },
    };
  },
};

/** Animation playback driven by game state, for models that need a clip switched at runtime. */
export const animationPlayback: BehaviorDefinition = {
  id: 'animation.play',
  name: 'Animation Playback',
  description: 'Plays a clip on this entity, optionally switching when a game-state key changes.',
  properties: [
    text('clip', 'Clip', '', 'Empty plays the first clip.'),
    boolean('loop', 'Loop', true),
    number('speed', 'Speed', 1, { min: 0, max: 5, step: 0.1 }),
    text('switchStateKey', 'Switch on state key', '', 'When this game-state key becomes true, play the alternative clip.'),
    text('alternateClip', 'Alternative clip', ''),
  ],
  create(context): BehaviorInstance {
    let usingAlternate = false;
    const speed = (): number => numberProperty(context, 'speed', 1);
    const loop = (): boolean => booleanProperty(context, 'loop', true);

    return {
      start() {
        const configuredClip = stringProperty(context, 'clip', '');
        const clip = configuredClip.length > 0 ? configuredClip : null;
        if (!context.playClip(clip, { loop: loop(), speed: speed(), autoplay: true })) {
          context.log('Animation Playback needs a model with clips on this entity');
        }
      },
      fixedUpdate() {
        const key = stringProperty(context, 'switchStateKey', '');
        if (key.length === 0) return;
        const active = context.getState(key) === true;
        if (active === usingAlternate) return;
        usingAlternate = active;
        const alternate = stringProperty(context, 'alternateClip', '');
        const base = stringProperty(context, 'clip', '');
        context.playClip(active ? alternate : base, { loop: loop(), speed: speed(), autoplay: true });
      },
    };
  },
};

/** Plays an audio asset when a game-state key flips. Audio assets import in this version. */
export const audioCue: BehaviorDefinition = {
  id: 'audio.cue',
  name: 'Audio Cue',
  description: 'Plays a sound when a game-state key changes.',
  properties: [
    text('stateKey', 'State key', 'score', 'The sound plays whenever this key changes.'),
    number('volume', 'Volume', 0.8, { min: 0, max: 1, step: 0.05 }),
    boolean('spatial', '3D sound', false),
  ],
  create(context): BehaviorInstance {
    let lastValue: JsonValue | undefined;
    let primed = false;

    const play = () => {
      const volume = numberProperty(context, 'volume', 0.8);
      if (!context.playSound({ volume, loop: false })) {
        context.log('Audio Cue needs an audio asset on this entity');
      }
    };

    return {
      start() {
        context.prepareAudio();
      },
      fixedUpdate() {
        const key = stringProperty(context, 'stateKey', '');
        if (key.length === 0) return;
        const value = context.getState(key);
        if (!primed) {
          lastValue = value;
          primed = true;
          return;
        }
        if (value === lastValue) return;
        lastValue = value;
        play();
      },
    };
  },
};

export const BEHAVIOR_LIBRARY: BehaviorDefinition[] = [
  playerMover,
  cameraFollow,
  collectible,
  exitZone,
  gameRules,
  projectileLauncher,
  knockDownTarget,
  animationPlayback,
  audioCue,
];
