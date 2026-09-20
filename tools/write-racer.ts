import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION, PROJECT_SCHEMA_VERSION, SCENE_SCHEMA_VERSION } from '../src/schema/index.js';
import type { Component, Entity, GameDocumentInput, SceneDocument } from '../src/schema/index.js';
import { BEHAVIOR_LIBRARY } from '../src/runtime/behaviors/library.js';
import { BehaviorRegistry } from '../src/runtime/behaviors/registry.js';

/**
 * Writes the retired Ōmagatoki Circuit into `.scratch/legacy-games/` for development.
 *
 * The circuit is a closed Catmull-Rom spline sampled into flat-shaded track pieces, so the whole
 * raceway — every rail, waypoint, gate and pickup — is derived from one list of control points and
 * stays consistent when the layout changes. Everything the runtime needs is ordinary scene data
 * driven by the registered `racer.*` behaviors; nothing here is executable.
 *
 * Run with: pnpm tsx tools/write-racer.ts
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const GAME_ID = 'omagatoki-circuit';

const registry = BehaviorRegistry.fromDefinitions(BEHAVIOR_LIBRARY);

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

interface EntitySpec {
  id: string;
  name: string;
  position?: Vec3;
  rotation?: Quat;
  scale?: Vec3;
  components: Component[];
  parentId?: string | null;
  order?: number;
}

const entities: Entity[] = [];
let order = 0;

function add(spec: EntitySpec): Entity {
  const built: Entity = {
    id: spec.id,
    name: spec.name,
    parentId: spec.parentId ?? null,
    order: spec.order ?? order++,
    enabled: true,
    transform: {
      position: spec.position ?? [0, 0, 0],
      rotation: spec.rotation ?? [0, 0, 0, 1],
      scale: spec.scale ?? [1, 1, 1],
    },
    components: spec.components,
    editor: { visible: true, locked: false, color: null, helper: false },
  };
  entities.push(built);
  return built;
}

const primitive = (shape: 'box' | 'sphere' | 'cylinder', size: Vec3): Component => ({
  type: 'primitive',
  shape,
  size,
  castShadow: false,
  receiveShadow: false,
});

interface MaterialOptions {
  emissive?: string;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  opacity?: number;
}

/** Flat-shaded PS1 material: no maps, hard facets, saturated emissive accents. */
const material = (color: string, options: MaterialOptions = {}): Component => ({
  type: 'material',
  color,
  roughness: options.roughness ?? 0.9,
  metalness: options.metalness ?? 0,
  emissive: options.emissive ?? '#000000',
  emissiveIntensity: options.emissiveIntensity ?? 1,
  opacity: options.opacity ?? 1,
  map: null,
  normalMap: null,
  emissiveMap: null,
  textureRepeat: [1, 1],
  textureOffset: [0, 0],
  transparent: (options.opacity ?? 1) < 1,
  doubleSided: false,
  flatShading: true,
  visible: true,
});

const neon = (color: string, intensity = 1.6): Component => material(color, { emissive: color, emissiveIntensity: intensity });

const rigidBody = (bodyType: 'static' | 'kinematic'): Component => ({
  type: 'rigidBody',
  bodyType,
  mass: null,
  gravityScale: 0,
  linearDamping: 0,
  angularDamping: 0,
  lockRotation: true,
  continuous: false,
  moveWithPhysics: true,
});

const collider = (shape: 'box' | 'capsule', size: Vec3): Component => ({
  type: 'collider',
  shape,
  size,
  offset: [0, 0, 0],
  localRotation: [0, 0, 0, 1],
  isSensor: false,
  friction: 0.2,
  restitution: 0,
  density: 1,
  reportContacts: false,
});

type BehaviorProperties = Record<string, string | number | boolean>;
const behavior = (behaviorId: string, properties: BehaviorProperties = {}): Component => ({
  type: 'behavior',
  behaviorId,
  properties,
});

// ------------------------------------------------------------------ maths

function quatFromEuler(yaw: number, pitch: number, roll: number): Quat {
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  const cr = Math.cos(roll / 2);
  const sr = Math.sin(roll / 2);
  const ax = cy * sp;
  const ay = sy * cp;
  const az = -sy * sp;
  const aw = cy * cp;
  return [ax * cr + ay * sr, ay * cr - ax * sr, aw * sr + az * cr, aw * cr - az * sr];
}

const round = (value: number): number => Math.round(value * 1000) / 1000;
const vec = (x: number, y: number, z: number): Vec3 => [round(x), round(y), round(z)];

/** Deterministic pseudo-random stream so regenerating the game yields identical files. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// ------------------------------------------------------------------ circuit

/**
 * Control points of the circuit in metres: [x, y, z]. Forward at the start line is -Z. The lap
 * runs a long start straight, a rising right-hand sweep, the Cliff Drop (a 40 m plunge with a gap
 * jump), an S through the shrine islands, the climb to the Moon Hairpin, and the plunge home.
 */
const CONTROL_POINTS: Vec3[] = [
  [0, 40, 70],
  [0, 40, -50],
  [8, 44, -150],
  [55, 50, -225],
  [140, 48, -250],
  [205, 34, -205],
  [195, 8, -120],
  [150, 4, -55],
  [175, 6, 25],
  [235, 20, 85],
  [225, 36, 165],
  [145, 42, 205],
  [70, 30, 215],
  [20, 12, 235],
  [-50, 18, 195],
  [-35, 34, 130],
];

const TRACK_WIDTH = 16;
const TRACK_THICKNESS = 1;
const PIECE_LENGTH = 15;
const RAIL_HEIGHT = 2.2;

interface Sample {
  point: Vec3;
  s: number;
}

function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const out: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    out[axis] =
      0.5 *
      (2 * p1[axis] +
        (-p0[axis] + p2[axis]) * t +
        (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * t2 +
        (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * t3);
  }
  return out;
}

const distance3 = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Sample the closed spline into roughly equal arc-length steps. */
function sampleCircuit(): Sample[] {
  const count = CONTROL_POINTS.length;
  const fine: Vec3[] = [];
  for (let index = 0; index < count; index += 1) {
    const p0 = CONTROL_POINTS[(index - 1 + count) % count];
    const p1 = CONTROL_POINTS[index];
    const p2 = CONTROL_POINTS[(index + 1) % count];
    const p3 = CONTROL_POINTS[(index + 2) % count];
    for (let step = 0; step < 64; step += 1) fine.push(catmullRom(p0, p1, p2, p3, step / 64));
  }
  const samples: Sample[] = [{ point: fine[0], s: 0 }];
  let travelled = 0;
  let sinceLast = 0;
  for (let index = 1; index <= fine.length; index += 1) {
    const previous = fine[index - 1];
    const current = fine[index % fine.length];
    const step = distance3(previous, current);
    travelled += step;
    sinceLast += step;
    if (sinceLast >= PIECE_LENGTH && index < fine.length) {
      samples.push({ point: current, s: travelled });
      sinceLast = 0;
    }
  }
  return samples;
}

const samples = sampleCircuit();
const lapLength = samples[samples.length - 1].s + distance3(samples[samples.length - 1].point, samples[0].point);

/** Arc length at which each control point sits, so features can be placed by corner. */
function arcAtControl(index: number): number {
  const target = CONTROL_POINTS[index];
  let best = samples[0];
  for (const sample of samples) if (distance3(sample.point, target) < distance3(best.point, target)) best = sample;
  return best.s;
}

// The Cliff Drop gap: the track ends on the descent after the hairpin and resumes lower down.
const GAP_START = arcAtControl(5) + 30;
const GAP_LENGTH = 20;
const inGap = (s: number): boolean => s > GAP_START && s < GAP_START + GAP_LENGTH;

interface Frame {
  center: Vec3;
  yaw: number;
  pitch: number;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  length: number;
}

function frameBetween(a: Vec3, b: Vec3): Frame {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const horizontal = Math.hypot(dx, dz);
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, horizontal);
  const fx = dx / horizontal;
  const fz = dz / horizontal;
  const forward: Vec3 = [fx, 0, fz];
  const right: Vec3 = [-fz, 0, fx];
  const up: Vec3 = [fx * Math.sin(pitch), Math.cos(pitch), fz * Math.sin(pitch)];
  return {
    center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    yaw,
    pitch,
    forward,
    right,
    up,
    length: Math.hypot(dx, dy, dz),
  };
}

const offset = (base: Vec3, right: Vec3, r: number, up: Vec3, u: number, forward: Vec3 = [0, 0, 0], f = 0): Vec3 =>
  vec(
    base[0] + right[0] * r + up[0] * u + forward[0] * f,
    base[1] + right[1] * r + up[1] * u + forward[1] * f,
    base[2] + right[2] * r + up[2] * u + forward[2] * f,
  );

const PALETTE = {
  deck: '#2b1a3f',
  deckAlt: '#34204c',
  deckStripe: '#f2b545',
  railLeft: '#ff5a2f',
  railRight: '#c99bff',
  cream: '#f6e7c8',
  red: '#e63946',
  orange: '#ff7a1a',
  lavender: '#b48cff',
  cyan: '#4ff0e6',
  pink: '#ff4fa3',
  moon: '#f4dfb8',
};

function buildTrack(): void {
  const pieceCount = samples.length;
  for (let index = 0; index < pieceCount; index += 1) {
    const a = samples[index];
    const b = samples[(index + 1) % pieceCount];
    if (inGap(a.s)) continue;
    const frame = frameBetween(a.point, b.point);
    const rotation = quatFromEuler(frame.yaw, frame.pitch, 0);
    const length = frame.length + 0.9;
    const tag = String(index + 1).padStart(3, '0');
    const stripe = index % 6 === 0;
    add({
      id: `track-${tag}`,
      name: `Track ${tag}`,
      position: vec(frame.center[0], frame.center[1] - TRACK_THICKNESS / 2, frame.center[2]),
      rotation,
      components: [
        primitive('box', [TRACK_WIDTH, TRACK_THICKNESS, length]),
        stripe ? material(PALETTE.deckStripe, { emissive: PALETTE.deckStripe, emissiveIntensity: 0.35 }) : material(index % 2 === 0 ? PALETTE.deck : PALETTE.deckAlt),
        rigidBody('static'),
        collider('box', [TRACK_WIDTH, TRACK_THICKNESS, length]),
      ],
    });
    for (const side of [-1, 1] as const) {
      const railOffset = side * (TRACK_WIDTH / 2 + 0.35);
      add({
        id: `rail-${tag}-${side < 0 ? 'l' : 'r'}`,
        name: `Rail ${tag} ${side < 0 ? 'Left' : 'Right'}`,
        position: offset(frame.center, frame.right, railOffset, frame.up, RAIL_HEIGHT / 2 - TRACK_THICKNESS / 2),
        rotation,
        components: [
          primitive('box', [0.7, RAIL_HEIGHT, length + 0.4]),
          neon(side < 0 ? PALETTE.railLeft : PALETTE.railRight, 1.3),
          rigidBody('static'),
          collider('box', [0.7, RAIL_HEIGHT, length + 0.4]),
        ],
      });
    }
  }
}

/** Waypoints every ~35 m; number 01 is the start line at arc length 0. */
function buildWaypoints(): void {
  let nextArc = 0;
  let count = 0;
  for (const sample of samples) {
    if (sample.s < nextArc || inGap(sample.s)) continue;
    count += 1;
    add({
      id: `waypoint-${String(count).padStart(2, '0')}`,
      name: `Waypoint ${String(count).padStart(2, '0')}`,
      position: vec(sample.point[0], sample.point[1], sample.point[2]),
      components: [],
    });
    nextArc = sample.s + 34;
    if (lapLength - sample.s < 30) break;
  }
}

function frameAt(s: number): Frame {
  let index = 0;
  while (index + 1 < samples.length && samples[index + 1].s <= s) index += 1;
  return frameBetween(samples[index].point, samples[(index + 1) % samples.length].point);
}

/** Torii gates straddling the raceway, the circuit's signature silhouette. */
function buildGates(): void {
  const arcs = [60, arcAtControl(3), arcAtControl(7) + 20, arcAtControl(9), arcAtControl(11), arcAtControl(14)];
  arcs.forEach((s, gateIndex) => {
    const frame = frameAt(s);
    const rotation = quatFromEuler(frame.yaw, 0, 0);
    const tag = String(gateIndex + 1).padStart(2, '0');
    const half = TRACK_WIDTH / 2 + 2.5;
    for (const side of [-1, 1] as const) {
      add({
        id: `gate-${tag}-pillar-${side < 0 ? 'l' : 'r'}`,
        name: `Torii ${tag} Pillar ${side < 0 ? 'L' : 'R'}`,
        position: offset(frame.center, frame.right, side * half, [0, 1, 0], 7),
        rotation,
        components: [primitive('cylinder', [1.1, 15, 1.1]), material(PALETTE.red, { emissive: PALETTE.red, emissiveIntensity: 0.3 })],
      });
    }
    add({
      id: `gate-${tag}-kasagi`,
      name: `Torii ${tag} Kasagi`,
      position: offset(frame.center, frame.right, 0, [0, 1, 0], 15),
      rotation,
      components: [primitive('box', [half * 2 + 6, 1.2, 1.6]), material(PALETTE.red, { emissive: PALETTE.red, emissiveIntensity: 0.3 })],
    });
    add({
      id: `gate-${tag}-nuki`,
      name: `Torii ${tag} Nuki`,
      position: offset(frame.center, frame.right, 0, [0, 1, 0], 12.2),
      rotation,
      components: [primitive('box', [half * 2 + 1, 0.8, 1.2]), material(PALETTE.cream, { emissive: PALETTE.cream, emissiveIntensity: 0.15 })],
    });
    add({
      id: `gate-${tag}-lantern`,
      name: `Torii ${tag} Lantern`,
      position: offset(frame.center, frame.right, 0, [0, 1, 0], 13.6),
      rotation,
      components: [primitive('box', [2.2, 1.6, 1.6]), neon(PALETTE.orange, 2)],
    });
  });

  // Start gantry.
  const start = frameAt(2);
  add({
    id: 'start-gantry',
    name: 'Start Gantry',
    position: offset(start.center, start.right, 0, [0, 1, 0], 9),
    rotation: quatFromEuler(start.yaw, 0, 0),
    components: [primitive('box', [TRACK_WIDTH + 4, 2.4, 0.8]), neon(PALETTE.cyan, 1.8)],
  });
  add({
    id: 'start-line',
    name: 'Start Line',
    position: offset(start.center, start.right, 0, [0, 1, 0], 0.03),
    rotation: quatFromEuler(start.yaw, start.pitch, 0),
    components: [primitive('box', [TRACK_WIDTH, 0.05, 2]), neon(PALETTE.cream, 1.2)],
  });

  // Jump chevrons before the gap.
  const jump = frameAt(GAP_START - 8);
  add({
    id: 'jump-chevron',
    name: 'Jump Chevron',
    position: offset(jump.center, jump.right, 0, jump.up, 0.04),
    rotation: quatFromEuler(jump.yaw, jump.pitch, 0),
    components: [primitive('box', [TRACK_WIDTH - 2, 0.06, 6]), neon(PALETTE.deckStripe, 2.2)],
  });
}

/** Weapon, shield, energy and boost pickups laid out along the lap. */
function buildPickups(): void {
  const colors = {
    boost: PALETTE.cyan,
    pulse: PALETTE.orange,
    shock: PALETTE.pink,
    shield: PALETTE.lavender,
    energy: PALETTE.cream,
  };
  const specs: Array<{ kind: keyof typeof colors; s: number; lane: number }> = [
    { kind: 'boost', s: 40, lane: 0 },
    { kind: 'pulse', s: 120, lane: -4 },
    { kind: 'shield', s: 120, lane: 4 },
    { kind: 'boost', s: arcAtControl(3) - 20, lane: 0 },
    { kind: 'shock', s: arcAtControl(4), lane: -4.5 },
    { kind: 'energy', s: arcAtControl(4), lane: 4.5 },
    { kind: 'boost', s: GAP_START - 30, lane: 0 },
    { kind: 'pulse', s: arcAtControl(7), lane: 0 },
    { kind: 'boost', s: arcAtControl(8), lane: -3 },
    { kind: 'shield', s: arcAtControl(8) + 15, lane: 4 },
    { kind: 'energy', s: arcAtControl(10), lane: -4 },
    { kind: 'shock', s: arcAtControl(10), lane: 4 },
    { kind: 'boost', s: arcAtControl(12) - 10, lane: 0 },
    { kind: 'pulse', s: arcAtControl(14), lane: -4 },
    { kind: 'boost', s: arcAtControl(15), lane: 0 },
  ];
  specs.forEach((spec, index) => {
    const frame = frameAt(spec.s);
    const tag = String(index + 1).padStart(2, '0');
    const isPad = spec.kind === 'boost';
    add({
      id: `pickup-${tag}`,
      name: `Pickup ${tag} ${spec.kind}`,
      position: offset(frame.center, frame.right, spec.lane, frame.up, isPad ? 0.08 : 1.4),
      rotation: quatFromEuler(frame.yaw, frame.pitch, 0),
      components: [
        isPad ? primitive('box', [5, 0.12, 6]) : primitive('box', [1.4, 1.4, 1.4]),
        neon(colors[spec.kind], isPad ? 2.4 : 2),
        behavior('racer.pickup', {
          kind: spec.kind,
          radius: isPad ? 3.6 : 2.8,
          respawnSeconds: isPad ? 0 : 6,
          spinSpeed: isPad ? 0 : 2.4,
          bobHeight: isPad ? 0 : 0.25,
        }),
      ],
    });
  });
}

// ------------------------------------------------------------------ craft

type CraftClass = 'speeder' | 'interceptor' | 'bulwark';

interface Livery {
  hull: string;
  trim: string;
  glow: string;
}

/** The three hull silhouettes, as children of a craft root; forward is -Z. */
function buildHull(parentId: string, craftClass: CraftClass, livery: Livery, prefix: string): string {
  const groupId = `${parentId}-hull-${craftClass}`;
  add({ id: groupId, name: `${prefix} Hull ${craftClass}`, parentId, components: [] });
  const part = (suffix: string, position: Vec3, size: Vec3, paint: Component) =>
    add({ id: `${groupId}-${suffix}`, name: `${prefix} ${craftClass} ${suffix}`, parentId: groupId, position, components: [primitive('box', size), paint] });
  const hull = material(livery.hull, { roughness: 0.6, metalness: 0.2 });
  const trim = material(livery.trim, { emissive: livery.trim, emissiveIntensity: 0.4 });
  const glow = neon(livery.glow, 2.6);
  const canopy = material('#1b1030', { emissive: PALETTE.cyan, emissiveIntensity: 0.5, roughness: 0.3, metalness: 0.4 });
  switch (craftClass) {
    case 'speeder':
      part('fuselage', [0, 0, 0], [0.9, 0.45, 5.2], hull);
      part('nose', [0, -0.05, -2.9], [0.5, 0.3, 1.2], trim);
      part('canopy', [0, 0.32, -0.4], [0.55, 0.3, 1.3], canopy);
      part('fin-left', [-1.35, 0.05, 1.3], [1.9, 0.1, 1.3], trim);
      part('fin-right', [1.35, 0.05, 1.3], [1.9, 0.1, 1.3], trim);
      part('tail', [0, 0.55, 2.0], [0.12, 0.8, 1.1], trim);
      part('engine-left', [-0.45, 0, 2.55], [0.5, 0.35, 0.5], glow);
      part('engine-right', [0.45, 0, 2.55], [0.5, 0.35, 0.5], glow);
      break;
    case 'interceptor':
      part('fuselage', [0, 0, 0], [1.3, 0.55, 4.4], hull);
      part('nose', [0, -0.05, -2.6], [0.8, 0.35, 1.2], trim);
      part('canopy', [0, 0.38, -0.5], [0.7, 0.35, 1.4], canopy);
      part('wing-left', [-1.7, 0, 0.6], [2.2, 0.16, 1.8], hull);
      part('wing-right', [1.7, 0, 0.6], [2.2, 0.16, 1.8], hull);
      part('wingtip-left', [-2.7, 0.15, 0.7], [0.3, 0.45, 1.6], trim);
      part('wingtip-right', [2.7, 0.15, 0.7], [0.3, 0.45, 1.6], trim);
      part('engine', [0, 0.05, 2.25], [1.1, 0.4, 0.5], glow);
      break;
    default:
      part('fuselage', [0, 0, 0], [2.1, 0.75, 4.0], hull);
      part('prow', [0, -0.1, -2.35], [1.5, 0.45, 1.0], trim);
      part('canopy', [0, 0.5, -0.3], [0.9, 0.4, 1.4], canopy);
      part('plate-left', [-1.75, 0.1, 0.3], [1.4, 0.35, 2.6], hull);
      part('plate-right', [1.75, 0.1, 0.3], [1.4, 0.35, 2.6], hull);
      part('ridge', [0, 0.55, 1.2], [0.5, 0.35, 1.8], trim);
      part('engine-left', [-0.7, 0, 2.15], [0.8, 0.5, 0.5], glow);
      part('engine-right', [0.7, 0, 2.15], [0.8, 0.5, 0.5], glow);
      break;
  }
  return groupId;
}

interface CraftSpec {
  id: string;
  name: string;
  pilot: 'player' | 'rival';
  craftClass: CraftClass;
  livery: Livery;
  gridRow: number;
  gridLane: number;
  difficulty?: number;
  aggression?: number;
  laneOffset?: number;
}

const CRAFT_SPECS: CraftSpec[] = [
  {
    id: 'player',
    name: 'Player',
    pilot: 'player',
    craftClass: 'interceptor',
    livery: { hull: '#f6e7c8', trim: '#ff7a1a', glow: '#4ff0e6' },
    gridRow: 0,
    gridLane: -3.5,
  },
  {
    id: 'rival-kaminari',
    name: 'Kaminari',
    pilot: 'rival',
    craftClass: 'speeder',
    livery: { hull: '#e63946', trim: '#f6e7c8', glow: '#ff7a1a' },
    gridRow: 0,
    gridLane: 3.5,
    difficulty: 0.85,
    aggression: 0.75,
    laneOffset: 2.5,
  },
  {
    id: 'rival-yurei',
    name: 'Yurei',
    pilot: 'rival',
    craftClass: 'interceptor',
    livery: { hull: '#b48cff', trim: '#2b1a3f', glow: '#ff4fa3' },
    gridRow: 1,
    gridLane: -3.5,
    difficulty: 0.75,
    aggression: 0.55,
    laneOffset: -3,
  },
  {
    id: 'rival-daruma',
    name: 'Daruma',
    pilot: 'rival',
    craftClass: 'bulwark',
    livery: { hull: '#3a2a55', trim: '#ff5a2f', glow: '#f2b545' },
    gridRow: 1,
    gridLane: 3.5,
    difficulty: 0.7,
    aggression: 0.9,
    laneOffset: 0,
  },
];

function buildCraft(): void {
  const start = frameAt(2);
  // The grid sits behind the start line, facing along the track.
  for (const spec of CRAFT_SPECS) {
    const behind = -(14 + spec.gridRow * 9);
    const position = offset(start.center, start.right, spec.gridLane, [0, 1, 0], 1.25, start.forward, behind);
    const shared = {
      pilot: spec.pilot,
      craftClass: spec.craftClass,
      waypointPrefix: 'Waypoint',
      bolt: `${spec.id}-bolt`,
    };
    const properties =
      spec.pilot === 'player'
        ? {
            ...shared,
            speederVisual: `${spec.id}-hull-speeder`,
            interceptorVisual: `${spec.id}-hull-interceptor`,
            bulwarkVisual: `${spec.id}-hull-bulwark`,
          }
        : {
            ...shared,
            [`${spec.craftClass}Visual`]: `${spec.id}-hull-${spec.craftClass}`,
            difficulty: spec.difficulty ?? 0.7,
            aggression: spec.aggression ?? 0.6,
            laneOffset: spec.laneOffset ?? 0,
          };
    add({
      id: spec.id,
      name: spec.name,
      position,
      rotation: quatFromEuler(start.yaw, 0, 0),
      components: [rigidBody('kinematic'), collider('capsule', [1.0, 1.4, 1.0]), behavior('racer.craft', properties)],
    });
    if (spec.pilot === 'player') {
      for (const craftClass of ['speeder', 'interceptor', 'bulwark'] as const) buildHull(spec.id, craftClass, spec.livery, spec.name);
    } else {
      buildHull(spec.id, spec.craftClass, spec.livery, spec.name);
    }
    add({
      id: `${spec.id}-bolt`,
      name: `${spec.name} Bolt`,
      position: vec(position[0], -200, position[2]),
      components: [primitive('box', [0.35, 0.35, 6]), neon(spec.livery.glow, 3)],
    });
  }
}

// ------------------------------------------------------------------ world

/** The strange world below: a cloud sea, neon spires, floating shrines and a giant moon. */
function buildWorld(): void {
  add({
    id: 'cloud-sea',
    name: 'Cloud Sea',
    position: [80, -110, 0],
    components: [primitive('box', [3000, 4, 3000]), material('#7a4aa8', { emissive: '#9a6ad0', emissiveIntensity: 0.45 })],
  });
  // Cloud banks drifting under the raceway: flat pale slabs at staggered depths read as altitude.
  const cloudRandom = rng(19092026);
  for (let index = 0; index < 48; index += 1) {
    const sample = samples[Math.floor(cloudRandom() * samples.length)];
    const x = sample.point[0] + (cloudRandom() - 0.5) * 220;
    const z = sample.point[2] + (cloudRandom() - 0.5) * 220;
    const y = sample.point[1] - 30 - cloudRandom() * 60;
    const width = 40 + cloudRandom() * 90;
    const depth = 25 + cloudRandom() * 60;
    const tone = cloudRandom() < 0.5 ? '#b48cff' : '#e6c7ff';
    add({
      id: `cloud-${String(index + 1).padStart(2, '0')}`,
      name: `Cloud Bank ${String(index + 1).padStart(2, '0')}`,
      position: [x, y, z],
      rotation: quatFromEuler(cloudRandom() * Math.PI, 0, 0),
      components: [primitive('box', [width, 3 + cloudRandom() * 4, depth]), material(tone, { emissive: tone, emissiveIntensity: 0.35, opacity: 0.85 })],
    });
  }
  add({
    id: 'moon',
    name: 'Moon',
    position: [-650, 260, -1100],
    components: [primitive('sphere', [130, 130, 130]), neon(PALETTE.moon, 0.9)],
  });
  add({
    id: 'moon-ring',
    name: 'Moon Halo',
    position: [-650, 260, -1100],
    rotation: quatFromEuler(0.3, 0.9, 0.2),
    components: [primitive('cylinder', [190, 2, 190]), material(PALETTE.lavender, { emissive: PALETTE.lavender, emissiveIntensity: 0.9, opacity: 0.55 })],
  });

  const random = rng(20260919);
  const accents = [PALETTE.orange, PALETTE.lavender, PALETTE.red, PALETTE.cyan, PALETTE.pink, PALETTE.deckStripe];
  const tooClose = (x: number, z: number, margin: number): boolean =>
    samples.some((sample) => Math.hypot(sample.point[0] - x, sample.point[2] - z) < margin);

  let spires = 0;
  let attempts = 0;
  while (spires < 110 && attempts < 4000) {
    attempts += 1;
    const x = 90 + (random() - 0.5) * 1100;
    const z = (random() - 0.5) * 1100;
    if (tooClose(x, z, 26)) continue;
    const height = 40 + random() * 150;
    const width = 8 + random() * 16;
    const tag = String(spires + 1).padStart(3, '0');
    const accent = accents[Math.floor(random() * accents.length)];
    const tone = random() < 0.5 ? '#1d1030' : '#2a1744';
    add({
      id: `spire-${tag}`,
      name: `Spire ${tag}`,
      position: vec(x, -108 + height / 2, z),
      rotation: quatFromEuler(random() * Math.PI, 0, 0),
      components: [primitive('box', [width, height, width]), material(tone, { emissive: accent, emissiveIntensity: 0.08 })],
    });
    add({
      id: `spire-${tag}-crown`,
      name: `Spire ${tag} Crown`,
      position: vec(x, -108 + height + 1.5, z),
      rotation: quatFromEuler(random() * Math.PI, 0, 0),
      components: [primitive('box', [width * 0.7, 3, width * 0.7]), neon(accent, 2)],
    });
    if (random() < 0.45) {
      add({
        id: `spire-${tag}-sign`,
        name: `Spire ${tag} Sign`,
        position: vec(x, -108 + height * (0.45 + random() * 0.4), z),
        rotation: quatFromEuler(random() * Math.PI, 0, 0),
        components: [primitive('box', [width + 3, 4 + random() * 10, 1.2]), neon(accents[Math.floor(random() * accents.length)], 1.5)],
      });
    }
    spires += 1;
  }

  // Floating shrine islands drifting near the low S-bend.
  const shrines: Array<{ position: Vec3; size: number }> = [
    { position: [120, -30, -20], size: 34 },
    { position: [250, -12, -60], size: 26 },
    { position: [40, -40, 260], size: 40 },
    { position: [-110, 0, 40], size: 30 },
    { position: [300, 20, 200], size: 22 },
  ];
  shrines.forEach((shrine, index) => {
    const tag = String(index + 1).padStart(2, '0');
    const [x, y, z] = shrine.position;
    add({
      id: `island-${tag}`,
      name: `Island ${tag}`,
      position: vec(x, y, z),
      components: [primitive('box', [shrine.size, 6, shrine.size]), material('#3d2a1e', { emissive: '#1f1410', emissiveIntensity: 0.2 })],
    });
    add({
      id: `island-${tag}-shrine`,
      name: `Island ${tag} Shrine`,
      position: vec(x, y + 6, z),
      components: [primitive('box', [shrine.size * 0.35, 6, shrine.size * 0.35]), material(PALETTE.red, { emissive: PALETTE.red, emissiveIntensity: 0.25 })],
    });
    add({
      id: `island-${tag}-roof`,
      name: `Island ${tag} Roof`,
      position: vec(x, y + 10.5, z),
      components: [primitive('box', [shrine.size * 0.5, 3, shrine.size * 0.5]), material('#1a1024', { emissive: PALETTE.lavender, emissiveIntensity: 0.15 })],
    });
    add({
      id: `island-${tag}-lantern`,
      name: `Island ${tag} Lantern`,
      position: vec(x + shrine.size * 0.3, y + 5.5, z + shrine.size * 0.3),
      components: [primitive('box', [1.6, 3, 1.6]), neon(PALETTE.orange, 2.4)],
    });
  });

  // Holographic billboards leaning over the rails.
  const boards = [90, arcAtControl(2), arcAtControl(4) - 40, arcAtControl(8) - 30, arcAtControl(10) + 30, arcAtControl(13)];
  boards.forEach((s, index) => {
    const frame = frameAt(s);
    const side = index % 2 === 0 ? -1 : 1;
    const tag = String(index + 1).padStart(2, '0');
    add({
      id: `board-${tag}`,
      name: `Billboard ${tag}`,
      position: offset(frame.center, frame.right, side * (TRACK_WIDTH / 2 + 8), [0, 1, 0], 9),
      rotation: quatFromEuler(frame.yaw + side * 0.35, 0, 0),
      components: [primitive('box', [14, 8, 0.6]), neon(accents[index % accents.length], 1.4)],
    });
    add({
      id: `board-${tag}-mast`,
      name: `Billboard ${tag} Mast`,
      position: offset(frame.center, frame.right, side * (TRACK_WIDTH / 2 + 8), [0, 1, 0], -20),
      components: [primitive('box', [1.2, 50, 1.2]), material('#1d1030')],
    });
  });
}

function buildLightsAndCamera(): void {
  add({
    id: 'dusk-sun',
    name: 'Dusk Sun',
    position: [-300, 120, -500],
    components: [
      {
        type: 'light',
        kind: 'directional',
        color: '#ffb070',
        intensity: 2.4,
        groundColor: '#2b1a3f',
        castShadow: false,
        shadowMapSize: 1024,
        shadowBias: -0.0005,
        shadowExtent: 60,
        range: 20,
        decay: 2,
        coneAngleDegrees: 30,
      },
    ],
  });
  add({
    id: 'sky-fill',
    name: 'Sky Fill',
    position: [0, 80, 0],
    components: [
      {
        type: 'light',
        kind: 'hemisphere',
        color: '#8a5cff',
        groundColor: '#ff6a2a',
        intensity: 1.1,
        castShadow: false,
        shadowMapSize: 512,
        shadowBias: -0.0005,
        shadowExtent: 10,
        range: 20,
        decay: 2,
        coneAngleDegrees: 30,
      },
    ],
  });
  add({
    id: 'game-camera',
    name: 'Chase Camera',
    position: [0, 44, 100],
    components: [
      { type: 'camera', mode: 'free', fov: 74, near: 0.2, far: 3000, targetId: 'player', distance: 7.5, height: 2.4, offset: [0, 0, 0], damping: 0 },
      behavior('racer.chase-camera', { target: 'player', distance: 7.5, height: 2.4, lookAhead: 14, bank: 0.7, speedPullback: 0.045, damping: 0.07 }),
    ],
  });
  add({
    id: 'race-director',
    name: 'Race Director',
    components: [
      behavior('racer.director', {
        crafts: CRAFT_SPECS.map((spec) => spec.name).join(', '),
        laps: 3,
        countdownSeconds: 3,
        podiumPlaces: 1,
        winMessage: 'CHAMPION OF THE ŌMAGATOKI CIRCUIT',
      }),
    ],
  });
}

buildTrack();
buildWaypoints();
buildGates();
buildPickups();
buildCraft();
buildWorld();
buildLightsAndCamera();

const scene: SceneDocument = {
  schemaVersion: SCENE_SCHEMA_VERSION,
  revision: 0,
  id: 'main',
  name: 'Ōmagatoki Circuit',
  activeCameraId: 'game-camera',
  environment: {
    background: { type: 'color', color: '#1a0b2e' },
    sky: { elevation: -4, azimuth: 300, turbidity: 12, rayleigh: 0.4 },
    lighting: { type: 'none' },
    fog: { type: 'exponential', color: '#3a1650', density: 0.0022 },
    gravity: [0, -9.81, 0],
  },
  entities,
};

const hudLabel = (
  id: string,
  text: string,
  bind: string,
  position: 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right',
  color: string,
  size: number,
) => ({ type: 'label' as const, id, text, bind, position, color, size });

const game: GameDocumentInput = {
  schemaVersion: PROJECT_SCHEMA_VERSION,
  engineVersion: ENGINE_VERSION,
  engineCompat: ENGINE_VERSION,
  id: GAME_ID,
  name: 'Ōmagatoki Circuit',
  description:
    'Anti-gravity combat racing over a cloud sea at the twilight hour. Three laps, three rivals, three hulls: drift the air brakes, ride the boost pads, survive the Cliff Drop.',
  scenes: [{ id: 'main', name: 'Ōmagatoki Circuit', path: 'scenes/main.scene.json' }],
  startScene: 'main',
  assetManifest: 'assets/manifest.json',
  behaviorRegistry: 'scripts/registry.json',
  settings: {
    physics: { fixedTimeStep: 1 / 60, subStepCount: 2, maxSubSteps: 4, enableSleep: true, hitEventThreshold: 1 },
    render: { antialias: false, shadows: false, pixelRatioCap: 1, toneMapping: 'neutral', exposure: 1.05 },
    initialGameState: {
      raceState: 'countdown',
      laps: 3,
      lap: '1 / 3',
      place: '- / 4',
      speed: 0,
      boost: 100,
      energy: 100,
      shield: false,
      weapon: '—',
      craft: 'TENGU  ·  interceptor',
      raceTime: '0:00.00',
      hudRace: '- / 4   ·   LAP 1 / 3',
      hudPilot: 'TENGU  ·  interceptor   ·   0:00.00',
      hudSystems: 'ENERGY 100%   ·   WEAPON —',
      hudBoost: 'BOOST 100%   ·   hold SHIFT',
      hudCenter: 'HULL: 1 · 2 · 3',
      objective: 'HULL: 1 · 2 · 3',
      announce: '',
      won: false,
      lost: false,
    },
    hud: [
      // One label per HUD corner: the director joins the readouts that share a corner.
      hudLabel('race-label', '{value}', 'hudRace', 'top-left', '#f6e7c8', 22),
      hudLabel('center-label', '{value}', 'hudCenter', 'top-center', '#ffb070', 24),
      hudLabel('pilot-label', '{value}', 'hudPilot', 'top-right', '#c99bff', 18),
      hudLabel('systems-label', '{value}', 'hudSystems', 'bottom-left', '#ffb070', 18),
      hudLabel('speed-label', '{value} km/h', 'speed', 'bottom-center', '#f6e7c8', 42),
      hudLabel('boost-label', '{value}', 'hudBoost', 'bottom-right', '#4ff0e6', 18),
      {
        type: 'overlay',
        id: 'start-overlay',
        kind: 'start',
        title: 'ŌMAGATOKI CIRCUIT',
        message:
          'Anti-gravity league, twilight session. Three laps above the cloud sea against Kaminari, Yurei and Daruma.\n\nW / ↑ thrust · S brake · A / D steer · Q / E air brakes (hold both to slam the brakes, one to drift) · SHIFT boost · SPACE fire · 1 / 2 / 3 choose your hull before the lights go out.',
        actionLabel: 'Launch',
        action: 'resume',
        background: '#1a0b2e',
        color: '#f6e7c8',
      },
      {
        type: 'overlay',
        id: 'win-overlay',
        kind: 'win',
        title: 'CHAMPION',
        message: 'First across the line. The Ōmagatoki Circuit is yours.',
        actionLabel: 'Race again',
        action: 'restart',
        background: '#1a0b2e',
        color: '#ffb070',
      },
      {
        type: 'overlay',
        id: 'lose-overlay',
        kind: 'lose',
        title: 'RACE OVER',
        message: 'Off the podium. Grab a shield pickup, drift the hairpins, and try again.',
        actionLabel: 'Restart',
        action: 'restart',
        background: '#1a0b2e',
        color: '#c99bff',
      },
    ],
    inputBindings: {
      moveForward: ['KeyW', 'ArrowUp'],
      moveBackward: ['KeyS', 'ArrowDown'],
      moveLeft: ['KeyA', 'ArrowLeft'],
      moveRight: ['KeyD', 'ArrowRight'],
      airbrakeLeft: ['KeyQ'],
      airbrakeRight: ['KeyE'],
      boost: ['ShiftLeft', 'ShiftRight'],
      fire: ['Space', 'KeyF'],
      craft1: ['Digit1'],
      craft2: ['Digit2'],
      craft3: ['Digit3'],
      restart: ['KeyR'],
    },
  },
};

const readme = [
  '# Ōmagatoki Circuit',
  '',
  'A Wipeout-style anti-gravity combat racer built entirely from Coilbox scene data and the registered',
  '`racer.*` behaviors. The raceway hangs above a cloud sea at *ōmagatoki* — the twilight hour when the',
  'world turns strange — strung between torii gates, neon spires and drifting shrine islands.',
  '',
  `The lap is ${Math.round(lapLength)} m long: a start straight under the gantry, a rising right-hand sweep, the`,
  'Cliff Drop (a 40 m plunge with a gap jump), an S through the shrine islands, the climb to the Moon Hairpin and',
  'the plunge home. Three laps against three AI rivals who rubber-band, drift, and shoot back.',
  '',
  '## Controls',
  '',
  '| Input | Action |',
  '| --- | --- |',
  '| `W` / `↑` | Thrust |',
  '| `S` / `↓` | Brake / reverse |',
  '| `A` `D` / `←` `→` | Steer |',
  '| `Q` / `E` | Air brakes: one side drifts through the corner (and charges boost), both slam the brakes |',
  '| `Shift` | Boost (burns the meter; boost pads and drifting refill it) |',
  '| `Space` / `F` | Fire the loaded pickup |',
  '| `1` `2` `3` | Choose a hull before the countdown ends |',
  '| `R` | Restart |',
  '',
  '## Hulls',
  '',
  '| Hull | Character |',
  '| --- | --- |',
  '| **Kitsune** · speeder | Featherlight glass cannon: fastest, sharpest, 60 energy and takes extra damage — but its pulse hits hardest. |',
  '| **Tengu** · interceptor | Agile all-rounder: balanced speed, grip and 100 energy. |',
  '| **Oni** · bulwark | Heavy armour: 150 energy, shrugs off 30% of every hit, biggest boost — slow to turn and to spool up. |',
  '',
  '## Pickups',
  '',
  '- **Boost pad** (cyan floor plate): instant surge plus 35% meter.',
  '- **Pulse cannon** (orange): a hitscan bolt at the craft ahead of you.',
  '- **Shockwave** (pink): damages every craft within 20 m.',
  '- **Shield** (lavender): five seconds of immunity when fired.',
  '- **Energy** (cream): restores 40% of the hull.',
  '',
  '## What to inspect',
  '',
  '| Tuning | Where |',
  '| --- | --- |',
  '| Hover height, gravity, speed scale, starting boost | `Player` → Racer Craft |',
  '| Rival skill, aggression, preferred lane, rubber banding | `Kaminari`, `Yurei`, `Daruma` → Racer Craft |',
  '| Camera distance, bank amount, look-ahead, speed pull-back | `Chase Camera` → Racer Chase Camera |',
  '| Pickup kind, radius, respawn time | `Pickup 01..15` → Racer Pickup |',
  '| Laps, countdown, podium places | `Race Director` → Race Director |',
  '',
  'Waypoints (`Waypoint 01..NN`) are the lap order every craft follows; 01 is the start line. The track',
  'pieces, rails, gates and pickups are generated from one spline by `tools/write-racer.ts`',
  '(`pnpm tsx tools/write-racer.ts`) so the circuit can be re-laid by editing its control points.',
  '',
  `Run it with \`pnpm dev --workspace .scratch/legacy-games\`, or export it with \`pnpm studio build ${GAME_ID} --workspace .scratch/legacy-games\`.`,
  '',
].join('\n');

const files = {
  'game.json': `${JSON.stringify(game, null, 2)}\n`,
  'scenes/main.scene.json': `${JSON.stringify(scene, null, 2)}\n`,
  'assets/manifest.json': `${JSON.stringify({ schemaVersion: 1, assets: [] }, null, 2)}\n`,
  'scripts/registry.json': `${JSON.stringify(registry.toJSON(), null, 2)}\n`,
  'README.md': readme,
};

const target = join(root, '.scratch', 'legacy-games', GAME_ID);
await rm(target, { recursive: true, force: true });
for (const [relative, contents] of Object.entries(files)) {
  const path = join(target, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
  process.stdout.write(`wrote .scratch/legacy-games/${GAME_ID}/${relative}\n`);
}
process.stdout.write(`${entities.length} entities, ${Math.round(lapLength)} m lap\n`);
