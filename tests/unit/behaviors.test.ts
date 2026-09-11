import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBox3DBackend } from '@runtime/physics/box3d-adapter.js';
import type { PhysicsBackend, PhysicsWorldHandle } from '@runtime/physics/types.js';
import { BehaviorRuntime, type BehaviorHost } from '@runtime/behaviors/runtime.js';
import { BehaviorRegistry } from '@runtime/behaviors/registry.js';
import { BEHAVIOR_LIBRARY } from '@runtime/behaviors/library.js';
import { GameState } from '@runtime/game-state.js';
import type { JsonValue } from '@schema/index.js';

/**
 * Behavior tests against the real physics world.
 *
 * These run the same behavior code the games use, on a real Box3D world, with a minimal host
 * instead of the full runtime world (no canvas, no DOM). The mover test exists because a
 * character that sinks through the floor is exactly the class of bug a browser check can miss
 * when it only measures horizontal movement.
 */

let backend: PhysicsBackend;
let world: PhysicsWorldHandle;
let state: GameState;
let registry: BehaviorRegistry;
let lastHost: HarnessHost | null = null;

/** Input stub: behaviors ask about actions, so the harness answers with a Set of active ones. */
class StubInput {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();

  isActionDown(action: string): boolean {
    return this.down.has(action);
  }

  wasActionPressed(action: string): boolean {
    return this.pressed.has(action);
  }

  wasActionReleased(action: string): boolean {
    return this.released.has(action);
  }

  moveAxis() {
    const x = (this.isActionDown('right') ? 1 : 0) - (this.isActionDown('left') ? 1 : 0);
    const y = (this.isActionDown('forward') ? 1 : 0) - (this.isActionDown('back') ? 1 : 0);
    return { x, y };
  }

  pointer() {
    return { x: 0, y: 0, clientX: 0, clientY: 0, down: this.isActionDown('primary'), justPressed: this.wasActionPressed('primary'), justReleased: false };
  }

  /** Test helpers. */
  pressAction(action: string): void {
    this.down.add(action);
    this.pressed.add(action);
  }

  releaseAction(action: string): void {
    this.down.delete(action);
    this.released.add(action);
  }

  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
  }
}

interface EntityFixture {
  id: string;
  name: string;
  physics?: {
    bodyType: 'static' | 'dynamic' | 'kinematic';
    position: [number, number, number];
    colliders: Array<{
      shape: { kind: 'box'; halfExtents: [number, number, number] } | { kind: 'sphere'; radius: number } | { kind: 'capsule'; halfHeight: number; radius: number };
      offset?: [number, number, number];
      isSensor?: boolean;
      reportContacts?: boolean;
    }>;
  };
  behaviors?: Array<{ behaviorId: string; properties?: Record<string, JsonValue> }>;
}

let input: StubInput;

class HarnessHost implements BehaviorHost {
  readonly input: StubInput;
  readonly state: GameState;
  readonly physics: PhysicsWorldHandle;
  readonly hud = null;
  private readonly entities = new Map<string, EntityFixture>();
  private readonly names = new Map<string, string>();
  requestSceneCalls: string[] = [];
  restarts = 0;
  logs: Array<{ level: string; message: string }> = [];
  clipPlays: Array<{ entityId: string; clip: string | null }> = [];
  soundPlays: string[] = [];
  characterMoves: Array<[number, number, number]> = [];

  constructor(entities: EntityFixture[]) {
    this.input = input;
    this.state = state;
    this.physics = world;
    for (const entity of entities) {
      this.entities.set(entity.id, entity);
      this.names.set(entity.name, entity.id);
    }
  }

  entityIds(): string[] {
    return [...this.entities.keys()];
  }

  entityName(entityId: string): string | null {
    return this.entities.get(entityId)?.name ?? null;
  }

  findByName(name: string): string | null {
    return this.names.get(name) ?? null;
  }

  findById(entityId: string): string | null {
    return this.entities.has(entityId) ? entityId : null;
  }

  readTransform(entityId: string, out: Float32Array): boolean {
    return world.readTransform(entityId, out);
  }

  readVelocity(entityId: string, out: Float32Array): boolean {
    return world.readVelocity(entityId, out);
  }

  setKinematicTransform(entityId: string, position: [number, number, number], rotation: [number, number, number, number]): void {
    world.setTransform(entityId, position, rotation);
  }

  /** The harness world has no obstacles, so a swept move is the same as a direct one. */
  moveCharacter(entityId: string, position: [number, number, number], rotation: [number, number, number, number]): void {
    world.setTransform(entityId, position, rotation);
    this.characterMoves.push([...position]);
  }

  setBodyEnabled(entityId: string, enabled: boolean): void {
    world.setBodyEnabled(entityId, enabled);
  }

  setBodyType(entityId: string, type: 'static' | 'dynamic' | 'kinematic'): void {
    world.setBodyType(entityId, type);
  }

  isPhysicsBody(entityId: string): boolean {
    return world.hasBody(entityId);
  }

  requestScene(sceneId: string): void {
    this.requestSceneCalls.push(sceneId);
  }

  requestRestart(): void {
    this.restarts += 1;
  }

  requestAction(): void {}

  log(level: 'info' | 'warning' | 'error', message: string): void {
    this.logs.push({ level, message });
  }

  playClip(entityId: string, clip: string | null): boolean {
    this.clipPlays.push({ entityId, clip });
    return true;
  }

  playSound(entityId: string): boolean {
    this.soundPlays.push(entityId);
    return true;
  }

  prepareAudio(): void {}
}

function buildRuntime(entities: EntityFixture[]) {
  for (const entity of entities) {
    if (!entity.physics) continue;
    world.createBody({
      key: entity.id,
      bodyType: entity.physics.bodyType,
      position: entity.physics.position,
      rotation: [0, 0, 0, 1],
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0.05,
      continuous: false,
      lockRotation: false,
      colliders: entity.physics.colliders.map((collider) => ({
        shape: collider.shape,
        offset: collider.offset ?? [0, 0, 0],
        rotation: [0, 0, 0, 1] as [number, number, number, number],
        density: 1,
        friction: 0.7,
        restitution: 0,
        isSensor: collider.isSensor ?? false,
        reportContacts: collider.reportContacts ?? true,
        reportHits: true,
      })),
    });
  }

  const host = new HarnessHost(entities);
  const behaviorsByEntity = new Map<string, Array<{ behaviorId: string; properties: Record<string, JsonValue> }>>();
  for (const entity of entities) {
    if (entity.behaviors) {
      behaviorsByEntity.set(
        entity.id,
        entity.behaviors.map((entry) => ({ behaviorId: entry.behaviorId, properties: entry.properties ?? {} })),
      );
    }
  }
  const runtime = new BehaviorRuntime({ registry, host, behaviorsByEntity });
  lastHost = host;
  return { runtime, host };
}

function step(runtime: BehaviorRuntime, seconds: number, onTick?: () => void): void {
  const ticks = Math.round(seconds * 60);
  for (let index = 0; index < ticks; index += 1) {
    runtime.fixedUpdate(1 / 60);
    runtime.update(1 / 60);
    world.step();
    for (const event of world.drainEvents()) runtime.dispatchPhysicsEvent(event);
    input.endFrame();
    onTick?.();
  }
}

beforeAll(async () => {
  backend = await createBox3DBackend();
});

afterAll(() => {
  // The WASM module is shared and cached; nothing to tear down beyond the worlds below.
});

beforeEach(() => {
  world = backend.createWorld({
    gravity: [0, -20, 0],
    fixedTimeStep: 1 / 60,
    subStepCount: 4,
    enableSleep: true,
    hitEventThreshold: 1,
  });
  state = new GameState({ score: 0 });
  input = new StubInput();
  registry = BehaviorRegistry.fromDefinitions(BEHAVIOR_LIBRARY);
  lastHost = null;
});

afterEach(() => {
  world.dispose();
});

describe('character mover', () => {
  it('lands on the floor, stays there, and walks when input arrives', () => {
    const entities: EntityFixture[] = [
      {
        id: 'floor',
        name: 'Floor',
        physics: { bodyType: 'static', position: [0, -0.25, 0], colliders: [{ shape: { kind: 'box', halfExtents: [10, 0.25, 10] } }] },
      },
      {
        id: 'player',
        name: 'Player',
        physics: {
          bodyType: 'kinematic',
          position: [0, 1, 0],
          colliders: [{ shape: { kind: 'capsule', halfHeight: 0.55, radius: 0.35 }, offset: [0, 0.9, 0] }],
        },
        behaviors: [{ behaviorId: 'player.mover', properties: { moveSpeed: 5, jumpStrength: 0, gravity: 20, spawnHeight: 1 } }],
      },
    ];
    const { runtime } = buildRuntime(entities);
    step(runtime, 1.5);

    const sample = new Float32Array(7);
    world.readTransform('player', sample);
    const restingY = sample[1]!;
    expect(restingY).toBeGreaterThan(-0.1);
    expect(restingY).toBeLessThan(0.1);

    // Standing still must not sink: this is the regression this test exists for.
    step(runtime, 3);
    world.readTransform('player', sample);
    expect(sample[1]!).toBeGreaterThan(-0.1);
    expect(sample[1]!).toBeLessThan(0.1);

    input.pressAction('forward');
    const beforeZ = sample[2]!;
    step(runtime, 1);
    world.readTransform('player', sample);
    expect(sample[2]! - beforeZ).toBeGreaterThan(2);
    expect(sample[1]!).toBeGreaterThan(-0.1);
    expect(state.get('playerGrounded')).toBe(true);
    runtime.dispose();
  });

  it('jumps and comes back down when jumping is enabled', () => {
    const entities: EntityFixture[] = [
      {
        id: 'floor',
        name: 'Floor',
        physics: { bodyType: 'static', position: [0, -0.25, 0], colliders: [{ shape: { kind: 'box', halfExtents: [10, 0.25, 10] } }] },
      },
      {
        id: 'player',
        name: 'Player',
        physics: {
          bodyType: 'kinematic',
          position: [0, 1, 0],
          colliders: [{ shape: { kind: 'capsule', halfHeight: 0.55, radius: 0.35 }, offset: [0, 0.9, 0] }],
        },
        behaviors: [{ behaviorId: 'player.mover', properties: { moveSpeed: 0, jumpStrength: 8, gravity: 20, spawnHeight: 1 } }],
      },
    ];
    const { runtime } = buildRuntime(entities);
    step(runtime, 1.5);

    const sample = new Float32Array(7);
    world.readTransform('player', sample);
    const groundY = sample[1]!;

    input.pressAction('jump');
    let highest = groundY;
    step(runtime, 0.5, () => {
      world.readTransform('player', sample);
      highest = Math.max(highest, sample[1]!);
    });
    expect(highest).toBeGreaterThan(groundY + 0.5);

    step(runtime, 1.5);
    world.readTransform('player', sample);
    expect(sample[1]!).toBeLessThan(groundY + 0.2);
    expect(sample[1]!).toBeGreaterThan(-0.1);
    runtime.dispose();
  });
});

describe('follow camera', () => {
  it('keeps its distance and aims at the target', () => {
    const entities: EntityFixture[] = [
      { id: 'player', name: 'Player', physics: { bodyType: 'kinematic', position: [0, 0, 0], colliders: [{ shape: { kind: 'box', halfExtents: [0.3, 0.3, 0.3] } }] } },
      {
        id: 'camera',
        name: 'Game Camera',
        physics: { bodyType: 'kinematic', position: [0, 6, 9], colliders: [{ shape: { kind: 'box', halfExtents: [0.1, 0.1, 0.1] } }] },
        behaviors: [
          {
            behaviorId: 'camera.follow',
            properties: { target: 'player', distance: 9, height: 7, offsetX: 6.3, offsetZ: 6.3, damping: 0, lookHeight: 1, fixed: true },
          },
        ],
      },
    ];
    const { runtime } = buildRuntime(entities);
    step(runtime, 0.5);

    const camera = new Float32Array(7);
    const player = new Float32Array(7);
    world.readTransform('camera', camera);
    world.readTransform('player', player);

    // The fixed offset is authored in metres, plus height.
    expect(camera[0]! - player[0]!).toBeCloseTo(6.3, 3);
    expect(camera[1]! - player[1]!).toBeCloseTo(7, 3);
    expect(camera[2]! - player[2]!).toBeCloseTo(6.3, 3);

    // The camera's forward (-Z rotated by its quaternion) points at the target.
    const [qx, qy, qz, qw] = [camera[3]!, camera[4]!, camera[5]!, camera[6]!];
    const forward = [
      -2 * (qx * qz + qw * qy),
      -2 * (qy * qz - qw * qx),
      -(1 - 2 * (qx * qx + qy * qy)),
    ];
    const toTarget = [player[0]! - camera[0]!, player[1]! + 1 - camera[1]!, player[2]! - camera[2]!];
    const toTargetLength = Math.hypot(...toTarget) || 1;
    const dot = (forward[0]! * toTarget[0]! + forward[1]! * toTarget[1]! + forward[2]! * toTarget[2]!) / toTargetLength;
    expect(dot).toBeGreaterThan(0.999);
    runtime.dispose();
  });

  it('follows the target when it moves', () => {
    const entities: EntityFixture[] = [
      { id: 'player', name: 'Player', physics: { bodyType: 'kinematic', position: [0, 0, 0], colliders: [{ shape: { kind: 'box', halfExtents: [0.3, 0.3, 0.3] } }] } },
      {
        id: 'camera',
        name: 'Game Camera',
        physics: { bodyType: 'kinematic', position: [6.3, 7, 6.3], colliders: [{ shape: { kind: 'box', halfExtents: [0.1, 0.1, 0.1] } }] },
        behaviors: [
          { behaviorId: 'camera.follow', properties: { target: 'player', distance: 9, height: 7, offsetX: 6.3, offsetZ: 6.3, damping: 0, fixed: true } },
        ],
      },
    ];
    const { runtime } = buildRuntime(entities);
    step(runtime, 0.3);
    world.setTransform('player', [10, 0, 4], [0, 0, 0, 1]);
    step(runtime, 0.3);

    const camera = new Float32Array(7);
    world.readTransform('camera', camera);
    expect(camera[0]!).toBeCloseTo(10 + 6.3, 3);
    expect(camera[2]!).toBeCloseTo(4 + 6.3, 3);
    runtime.dispose();
  });
});

describe('collectible and exit zone', () => {
  it('adds to the score when the player walks into it', () => {
    const entities: EntityFixture[] = [
      { id: 'player', name: 'Player', physics: { bodyType: 'kinematic', position: [0, 0, 0], colliders: [{ shape: { kind: 'box', halfExtents: [0.3, 0.3, 0.3] } }] } },
      {
        id: 'gem',
        name: 'Gem',
        physics: { bodyType: 'static', position: [0, 0.5, 3], colliders: [{ shape: { kind: 'sphere', radius: 0.3 }, isSensor: true }] },
        behaviors: [{ behaviorId: 'game.collectible', properties: { value: 2, playerName: 'Player', hideOnCollect: true } }],
      },
    ];
    const { runtime } = buildRuntime(entities);
    state.set('collectiblesRemaining', 1);
    step(runtime, 0.3);
    expect(state.get('score')).toBe(0);

    world.setTransform('player', [0, 0.5, 3], [0, 0, 0, 1]);
    step(runtime, 0.2);
    expect(state.get('score')).toBe(2);
    expect(state.get('collectiblesRemaining')).toBe(0);

    // Collected once, not once per tick.
    step(runtime, 0.5);
    expect(state.get('score')).toBe(2);
    runtime.dispose();
  });

  it('opens the exit only when the required score is reached', () => {
    const entities: EntityFixture[] = [
      { id: 'player', name: 'Player', physics: { bodyType: 'kinematic', position: [0, 0, 0], colliders: [{ shape: { kind: 'box', halfExtents: [0.3, 0.3, 0.3] } }] } },
      {
        id: 'exit',
        name: 'Exit',
        physics: { bodyType: 'static', position: [0, 0, 2], colliders: [{ shape: { kind: 'box', halfExtents: [1, 1, 1] }, isSensor: true }] },
        behaviors: [{ behaviorId: 'game.exit-zone', properties: { playerName: 'Player', requiredScore: 2, winMessage: 'Escaped' } }],
      },
    ];
    const { runtime } = buildRuntime(entities);
    // Standing in the exit without the required score must not win.
    world.setTransform('player', [0, 0, 2], [0, 0, 0, 1]);
    step(runtime, 0.3);
    expect(state.get('won')).not.toBe(true);
    expect(String(state.get('objective'))).toMatch(/Collect/);

    // Collecting the last gem while standing in the exit must win: the check runs while the
    // player is inside, not only on the frame the sensor began.
    state.set('score', 2);
    step(runtime, 0.3);
    expect(state.get('won')).toBe(true);
    expect(state.get('objective')).toBe('Escaped');
    runtime.dispose();
  });
});

describe('knock-down target', () => {
  it('counts a hit when the body tips past the angle', () => {
    const tilted = Math.sin((60 * Math.PI) / 180 / 2);
    const entities: EntityFixture[] = [
      {
        id: 'target',
        name: 'Target 1',
        physics: { bodyType: 'kinematic', position: [0, 1, 0], colliders: [{ shape: { kind: 'box', halfExtents: [0.5, 1.2, 0.5] } }] },
        behaviors: [{ behaviorId: 'game.target', properties: { tipAngle: 45, value: 1 } }],
      },
    ];
    const { runtime } = buildRuntime(entities);
    step(runtime, 0.2);
    expect(state.get('score')).toBe(0);

    world.setTransform('target', [0, 1, 0], [tilted, 0, 0, Math.cos((60 * Math.PI) / 180 / 2)]);
    step(runtime, 0.2);
    expect(state.get('score')).toBe(1);
    expect(state.get('targetsDown')).toBe(1);

    step(runtime, 0.5);
    expect(state.get('score')).toBe(1);
    runtime.dispose();
  });
});

describe('launcher', () => {
  it('applies an impulse when the primary action is pressed', () => {
    const entities: EntityFixture[] = [
      {
        id: 'ball',
        name: 'Ball',
        physics: { bodyType: 'dynamic', position: [0, 2, 0], colliders: [{ shape: { kind: 'sphere', radius: 0.4 } }] },
        behaviors: [{ behaviorId: 'game.launcher', properties: { impulse: 10, upward: 0.3, resetAfterLaunch: false } }],
      },
    ];
    const { runtime } = buildRuntime(entities);
    step(runtime, 0.1);
    const velocity = new Float32Array(3);
    world.readVelocity('ball', velocity);
    expect(Math.abs(velocity[2]!)).toBeLessThan(0.5);

    input.pressAction('primary');
    step(runtime, 0.1);
    world.readVelocity('ball', velocity);
    expect(velocity[2]!).toBeLessThan(-3);
    expect(state.get('launches')).toBe(1);
    runtime.dispose();
  });
});

describe('game rules', () => {
  it('wins when the score target is reached and restarts on the restart action', () => {
    const entities: EntityFixture[] = [
      {
        id: 'rules',
        name: 'Game Rules',
        behaviors: [{ behaviorId: 'game.rules', properties: { scoreTarget: 3, showStartOverlay: false, initialObjective: 'Collect 3' } }],
      },
    ];
    const { runtime } = buildRuntime(entities);
    step(runtime, 0.1);
    expect(state.get('won')).not.toBe(true);
    expect(state.get('objective')).toBe('Collect 3');

    state.set('score', 3);
    step(runtime, 0.1);
    expect(state.get('won')).toBe(true);

    input.pressAction('restart');
    step(runtime, 0.1);
    expect(hostRestarts()).toBeGreaterThan(0);
    runtime.dispose();
  });

  it('does not count the clock down before the round starts, and never loses after winning', () => {
    const entities: EntityFixture[] = [
      {
        id: 'rules',
        name: 'Game Rules',
        behaviors: [{ behaviorId: 'game.rules', properties: { scoreTarget: 0, timeLimit: 1, showStartOverlay: true, waitForStart: true } }],
      },
    ];
    const { runtime } = buildRuntime(entities);
    step(runtime, 1.5);
    expect(Number(state.get('timeRemaining'))).toBeCloseTo(1, 2);

    state.set('started', true);
    step(runtime, 0.5);
    expect(Number(state.get('timeRemaining'))).toBeLessThan(0.6);

    // Winning first must make the clock's expiry harmless.
    state.set('won', true);
    state.set('timeRemaining', 0.05);
    step(runtime, 0.5);
    expect(state.get('lost')).not.toBe(true);
    runtime.dispose();
  });
});

function hostRestarts(): number {
  return lastHost?.restarts ?? 0;
}
