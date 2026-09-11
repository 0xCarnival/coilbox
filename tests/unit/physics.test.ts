import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBox3DBackend } from '@runtime/physics/box3d-adapter.js';
import type { PhysicsBackend, PhysicsWorldHandle } from '@runtime/physics/types.js';

/**
 * Box3D adapter tests (plan §15 stage 0: "physics runs"; §9: ownership and teardown).
 *
 * These run the real WASM binding in Node, which makes the physics evidence reproducible
 * without a browser. Rendering and page-level cleanup are covered by the browser checks.
 */

let backend: PhysicsBackend;
const liveWorlds: PhysicsWorldHandle[] = [];

beforeAll(async () => {
  backend = await createBox3DBackend();
});

afterAll(() => {
  for (const world of liveWorlds) world.dispose();
});

function createWorld(options: Partial<Parameters<PhysicsBackend['createWorld']>[0]> = {}): PhysicsWorldHandle {
  const world = backend.createWorld({
    gravity: [0, -9.81, 0],
    fixedTimeStep: 1 / 60,
    subStepCount: 4,
    enableSleep: true,
    hitEventThreshold: 1,
    ...options,
  });
  liveWorlds.push(world);
  return world;
}

function simulate(world: PhysicsWorldHandle, seconds: number): void {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i += 1) world.step();
}

describe('Box3D adapter', () => {
  it('reports the binding identity from the vendor module', () => {
    expect(backend.name).toBe('box3d.js@0.1.1');
    expect(backend.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(backend.doublePrecision).toBe(false);
  });

  it('drops a dynamic box onto a static ground and lets it rest', () => {
    const world = createWorld();
    world.createBody({
      key: 'ground',
      bodyType: 'static',
      position: [0, -0.25, 0],
      rotation: [0, 0, 0, 1],
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      continuous: false,
      lockRotation: false,
      colliders: [
        {
          shape: { kind: 'box', halfExtents: [10, 0.25, 10] },
          offset: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          density: 1,
          friction: 0.7,
          restitution: 0,
          isSensor: false,
          reportContacts: true,
          reportHits: true,
        },
      ],
    });
    world.createBody({
      key: 'box',
      bodyType: 'dynamic',
      position: [0, 4, 0],
      rotation: [0, 0, 0, 1],
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0.2,
      continuous: false,
      lockRotation: false,
      colliders: [
        {
          shape: { kind: 'box', halfExtents: [0.5, 0.5, 0.5] },
          offset: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          density: 1,
          friction: 0.6,
          restitution: 0.1,
          isSensor: false,
          reportContacts: true,
          reportHits: true,
        },
      ],
    });

    const sample = new Float32Array(7);
    world.readTransform('box', sample);
    expect(sample[1]).toBeCloseTo(4, 3);

    simulate(world, 0.5);
    world.readTransform('box', sample);
    expect(sample[1]).toBeLessThan(3.5);

    simulate(world, 2.5);
    world.readTransform('box', sample);
    expect(sample[1]).toBeGreaterThan(0.48);
    expect(sample[1]).toBeLessThan(0.52);

    const counters = world.getCounters();
    expect(counters.bodyCount).toBe(2);
    expect(counters.contactCount).toBeGreaterThan(0);
  });

  it('applies an offset box collider through a hull without changing the resting height', () => {
    const world = createWorld();
    world.createBody({
      key: 'ground',
      bodyType: 'static',
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      continuous: false,
      lockRotation: false,
      colliders: [
        {
          shape: { kind: 'box', halfExtents: [10, 0.5, 10] },
          offset: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          density: 1,
          friction: 0.7,
          restitution: 0,
          isSensor: false,
          reportContacts: false,
          reportHits: false,
        },
      ],
    });
    // The entity origin sits 1 m above the ground; the collider is offset 0.5 m below it,
    // so the box's bottom face must come to rest exactly on the ground surface (y = 0.5).
    world.createBody({
      key: 'offset',
      bodyType: 'dynamic',
      position: [0, 1.5 + 1, 0],
      rotation: [0, 0, 0, 1],
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0.4,
      continuous: false,
      lockRotation: true,
      colliders: [
        {
          shape: { kind: 'box', halfExtents: [0.5, 0.5, 0.5] },
          offset: [0, -1, 0],
          rotation: [0, 0, 0, 1],
          density: 1,
          friction: 0.8,
          restitution: 0,
          isSensor: false,
          reportContacts: false,
          reportHits: false,
        },
      ],
    });

    simulate(world, 3);
    const sample = new Float32Array(7);
    world.readTransform('offset', sample);
    // Ground top is y = 0.5; the collider centre is 1 m below the body origin, so the
    // body origin rests at 0.5 + 0.5 + 1 = 2.0.
    expect(sample[1]).toBeGreaterThan(1.97);
    expect(sample[1]).toBeLessThan(2.03);
  });

  it('fires sensor touch events for sensor colliders', () => {
    const world = createWorld();
    world.createBody({
      key: 'floor',
      bodyType: 'static',
      position: [0, -0.5, 0],
      rotation: [0, 0, 0, 1],
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      continuous: false,
      lockRotation: false,
      colliders: [
        {
          shape: { kind: 'box', halfExtents: [5, 0.5, 5] },
          offset: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          density: 1,
          friction: 0.6,
          restitution: 0,
          isSensor: false,
          reportContacts: false,
          reportHits: false,
        },
      ],
    });
    world.createBody({
      key: 'trigger',
      bodyType: 'static',
      position: [0, 1, 0],
      rotation: [0, 0, 0, 1],
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      continuous: false,
      lockRotation: false,
      colliders: [
        {
          shape: { kind: 'box', halfExtents: [1, 1, 1] },
          offset: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          density: 1,
          friction: 0.6,
          restitution: 0,
          isSensor: true,
          reportContacts: true,
          reportHits: false,
        },
      ],
    });
    world.createBody({
      key: 'visitor',
      bodyType: 'dynamic',
      position: [0, 3, 0],
      rotation: [0, 0, 0, 1],
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      continuous: false,
      lockRotation: true,
      colliders: [
        {
          shape: { kind: 'box', halfExtents: [0.25, 0.25, 0.25] },
          offset: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          density: 1,
          friction: 0.6,
          restitution: 0,
          isSensor: false,
          reportContacts: false,
          reportHits: false,
        },
      ],
    });

    const seen: string[] = [];
    for (let i = 0; i < 60 * 3; i += 1) {
      world.step();
      for (const event of world.drainEvents()) {
        if (event.kind === 'sensorBegin' || event.kind === 'sensorEnd') {
          seen.push(`${event.kind}:${[event.a, event.b].sort().join('+')}`);
        }
      }
    }
    expect(seen).toContain('sensorBegin:trigger+visitor');
  });

  it('reports raycast hits with the owning entity key', () => {
    const world = createWorld();
    world.createBody({
      key: 'wall',
      bodyType: 'static',
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      continuous: false,
      lockRotation: false,
      colliders: [
        {
          shape: { kind: 'box', halfExtents: [0.5, 0.5, 0.5] },
          offset: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          density: 1,
          friction: 0.6,
          restitution: 0,
          isSensor: false,
          reportContacts: false,
          reportHits: false,
        },
      ],
    });

    const hit = world.raycastClosest([-5, 0, 0], [1, 0, 0], 10);
    expect(hit.hit).toBe(true);
    expect(hit.key).toBe('wall');
    expect(hit.distance).toBeCloseTo(4.5, 1);

    const miss = world.raycastClosest([-5, 5, 0], [1, 0, 0], 10);
    expect(miss.hit).toBe(false);
  });

  it('moves a kinematic body through the adapter', () => {
    const world = createWorld();
    world.createBody({
      key: 'platform',
      bodyType: 'kinematic',
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      gravityScale: 0,
      linearDamping: 0,
      angularDamping: 0,
      continuous: false,
      lockRotation: false,
      colliders: [
        {
          shape: { kind: 'box', halfExtents: [1, 0.1, 1] },
          offset: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          density: 1,
          friction: 0.6,
          restitution: 0,
          isSensor: false,
          reportContacts: false,
          reportHits: false,
        },
      ],
    });
    world.setTransform('platform', [3, 1, 0], [0, 0, 0, 1]);
    world.step();
    const sample = new Float32Array(7);
    world.readTransform('platform', sample);
    expect(sample[0]).toBeCloseTo(3, 3);
    expect(sample[1]).toBeCloseTo(1, 3);
  });

  it('destroys worlds on dispose and stops reporting them as live', () => {
    const before = backend.getWorldCount();
    const world = createWorld();
    expect(backend.getWorldCount()).toBe(before + 1);
    const counters = world.getCounters();
    expect(counters.byteCount).toBeGreaterThan(0);
    world.dispose();
    expect(backend.getWorldCount()).toBe(before);
    expect(world.disposed).toBe(true);
    expect(world.getCounters().bodyCount).toBe(0);
    expect(() => world.step()).toThrow(/disposed/);
  });

  it('does not grow the live world count across many create/dispose cycles', () => {
    const before = backend.getWorldCount();
    for (let i = 0; i < 20; i += 1) {
      const world = createWorld();
      world.createBody({
        key: 'box',
        bodyType: 'dynamic',
        position: [0, 2, 0],
        rotation: [0, 0, 0, 1],
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        continuous: false,
        lockRotation: false,
        colliders: [
          {
            shape: { kind: 'sphere', radius: 0.5 },
            offset: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            density: 1,
            friction: 0.5,
            restitution: 0.2,
            isSensor: false,
            reportContacts: false,
            reportHits: false,
          },
        ],
      });
      world.step();
      world.dispose();
    }
    expect(backend.getWorldCount()).toBe(before);
  });

  it('sweeps a character capsule through open space, walls, and sensors', () => {
    const world = createWorld();
    const staticBox = (key: string, position: [number, number, number], halfExtents: [number, number, number], isSensor = false) => {
      world.createBody({
        key,
        bodyType: 'static',
        position,
        rotation: [0, 0, 0, 1],
        gravityScale: 1,
        linearDamping: 0,
        angularDamping: 0,
        continuous: false,
        lockRotation: false,
        colliders: [
          {
            shape: { kind: 'box', halfExtents },
            offset: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            density: 1,
            friction: 0.6,
            restitution: 0,
            isSensor,
            reportContacts: false,
            reportHits: true,
          },
        ],
      });
    };
    staticBox('floor', [0, -0.25, 0], [8, 0.25, 8]);
    staticBox('wall', [0, 1, 8], [8, 1, 0.25]);
    // A gem-like trigger sits in the path: triggers are not obstacles.
    staticBox('gem', [0, 0.6, 0], [0.6, 0.6, 0.6], true);

    world.createBody({
      key: 'player',
      bodyType: 'kinematic',
      position: [0, 0, -6],
      rotation: [0, 0, 0, 1],
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      continuous: false,
      lockRotation: true,
      colliders: [
        {
          shape: { kind: 'capsule', radius: 0.35, halfHeight: 0.55 },
          offset: [0, 0.9, 0],
          rotation: [0, 0, 0, 1],
          density: 1,
          friction: 0.6,
          restitution: 0,
          isSensor: false,
          reportContacts: false,
          reportHits: true,
        },
      ],
    });
    world.step();

    const capsule = {
      center1: [0, 0.35, 0] as [number, number, number],
      center2: [0, 1.45, 0] as [number, number, number],
      radius: 0.35,
    };
    const toward = (origin: [number, number, number], translation: [number, number, number]) =>
      world.castMover({ origin, capsule, translation, excludeKey: 'player' });

    // Open space: the whole translation is available, and nothing blocks it.
    const open = toward([0, 0, -6], [0, 0, -2]);
    expect(open.fraction).toBe(1);
    expect(open.keys).not.toContain('wall');
    expect(open.keys).not.toContain('gem');

    // The wall stops the capsule 0.35 m (its radius) in front of its inner face at z = 7.75.
    const blocked = toward([0, 0, -6], [0, 0, 20]);
    expect(blocked.fraction).toBeLessThan(1);
    expect(blocked.fraction * 20).toBeGreaterThan(13.3);
    expect(blocked.fraction * 20).toBeLessThan(13.5);
    // The gem in the path and the capsule's own body are not considered at all: triggers are
    // passed through, and a shape the capsule starts inside never stops it.
    expect(blocked.keys).toContain('wall');
    expect(blocked.keys).not.toContain('gem');
    expect(blocked.keys).not.toContain('player');
  });

  it('refuses a second body with the same key', () => {
    const world = createWorld();
    const spec = {
      key: 'dup',
      bodyType: 'static' as const,
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      gravityScale: 1,
      linearDamping: 0,
      angularDamping: 0,
      continuous: false,
      lockRotation: false,
      colliders: [],
    };
    world.createBody(spec);
    expect(() => world.createBody(spec)).toThrow(/already exists/);
  });
});
