import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION, PROJECT_SCHEMA_VERSION, SCENE_SCHEMA_VERSION } from '../src/schema/index.js';
import type { Component, Entity, GameDocumentInput, SceneDocument } from '../src/schema/index.js';
import { BEHAVIOR_LIBRARY } from '../src/runtime/behaviors/library.js';
import { BehaviorRegistry } from '../src/runtime/behaviors/registry.js';
import { lookAt } from '../src/editor/document/factory.js';

/**
 * Writes the two demonstration games (plan §2, §15 stage 3).
 *
 * They are generated rather than hand-edited so the behaviour registries, ids, and component
 * shapes stay valid, and so the same script proves that both games are built from the shared
 * runtime rather than a hard-coded application.
 *
 * Run with: pnpm tsx tools/write-games.ts
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const gamesRoot = join(root, 'games');

const registry = BehaviorRegistry.fromDefinitions(BEHAVIOR_LIBRARY);

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

interface EntitySpec {
  id: string;
  name: string;
  position?: Vec3;
  rotation?: Quat;
  components: Component[];
  parentId?: string | null;
  order?: number;
}

function entity(spec: EntitySpec): Entity {
  return {
    id: spec.id,
    name: spec.name,
    parentId: spec.parentId ?? null,
    order: spec.order ?? 0,
    enabled: true,
    transform: {
      position: spec.position ?? [0, 0, 0],
      rotation: spec.rotation ?? [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    components: spec.components,
    editor: { visible: true, locked: false, color: null, helper: false },
  };
}

const primitive = (
  shape: 'box' | 'sphere' | 'plane' | 'capsule' | 'cylinder',
  size: Vec3,
  options: { castShadow?: boolean; receiveShadow?: boolean } = {},
): Component => ({
  type: 'primitive',
  shape,
  size,
  castShadow: options.castShadow ?? true,
  receiveShadow: options.receiveShadow ?? true,
});

const material = (color: string, roughness = 0.8, metalness = 0): Component => ({
  type: 'material',
  color,
  roughness,
  metalness,
  emissive: '#000000',
  emissiveIntensity: 1,
  opacity: 1,
  map: null,
  normalMap: null,
  emissiveMap: null,
  textureRepeat: [1, 1],
  textureOffset: [0, 0],
  transparent: false,
  doubleSided: false,
  flatShading: false,
  visible: true,
});

const rigidBody = (bodyType: 'static' | 'dynamic' | 'kinematic', extra: Partial<Extract<Component, { type: 'rigidBody' }>> = {}): Component => ({
  type: 'rigidBody',
  bodyType,
  mass: null,
  gravityScale: 1,
  linearDamping: 0,
  angularDamping: 0.05,
  lockRotation: false,
  continuous: false,
  moveWithPhysics: true,
  ...extra,
});

const collider = (
  shape: 'box' | 'sphere' | 'capsule',
  size: Vec3,
  extra: Partial<Extract<Component, { type: 'collider' }>> = {},
): Component => ({
  type: 'collider',
  shape,
  size,
  offset: [0, 0, 0],
  localRotation: [0, 0, 0, 1],
  isSensor: false,
  friction: 0.6,
  restitution: 0,
  density: 1,
  reportContacts: false,
  ...extra,
});

/** The scalar properties a registered behavior reads: the values the inspector edits. */
type BehaviorProperties = Record<string, string | number | boolean>;

const behavior = (behaviorId: string, properties: BehaviorProperties = {}): Component => ({
  type: 'behavior',
  behaviorId,
  properties,
});

const DIRECTIONAL_SUN = (position: Vec3, intensity = 2.2): Component => ({
  type: 'light',
  kind: 'directional',
  color: '#fff4e0',
  intensity,
  groundColor: '#3b4354',
  castShadow: true,
  shadowMapSize: 1024,
  shadowBias: -0.0005,
  shadowExtent: 18,
  range: 20,
  decay: 2,
  coneAngleDegrees: 30,
});

const AMBIENT_FILL: Component = {
  type: 'light',
  kind: 'hemisphere',
  color: '#93a7c9',
  groundColor: '#2b303c',
  intensity: 0.7,
  castShadow: false,
  shadowMapSize: 512,
  shadowBias: -0.0005,
  shadowExtent: 10,
  range: 20,
  decay: 2,
  coneAngleDegrees: 30,
};

// ----------------------------------------------------------------- collect-room

function collectRoom(): BuiltGame {
  const roomHalf = 8;
  const wallHeight = 2;
  const wallThickness = 0.5;
  const collectiblePositions: Vec3[] = [
    [-4.5, 0.6, -4.5],
    [4.5, 0.6, -3.5],
    [0, 0.6, 5],
  ];

  const entities: Entity[] = [
    entity({
      id: 'ground',
      name: 'Floor',
      position: [0, -0.25, 0],
      order: 0,
      components: [
        primitive('box', [roomHalf * 2, 0.5, roomHalf * 2], { castShadow: false }),
        material('#3f4654', 0.9),
        rigidBody('static'),
        collider('box', [roomHalf * 2, 0.5, roomHalf * 2], { friction: 0.8 }),
      ],
    }),
    // Four walls, each a physics root.
    entity({
      id: 'wall-north',
      name: 'Wall North',
      position: [0, wallHeight / 2, -roomHalf],
      order: 1,
      components: [
        primitive('box', [roomHalf * 2, wallHeight, wallThickness]),
        material('#59607a', 0.85),
        rigidBody('static'),
        collider('box', [roomHalf * 2, wallHeight, wallThickness]),
      ],
    }),
    entity({
      id: 'wall-south',
      name: 'Wall South',
      position: [0, wallHeight / 2, roomHalf],
      order: 2,
      components: [
        primitive('box', [roomHalf * 2, wallHeight, wallThickness]),
        material('#59607a', 0.85),
        rigidBody('static'),
        collider('box', [roomHalf * 2, wallHeight, wallThickness]),
      ],
    }),
    entity({
      id: 'wall-west',
      name: 'Wall West',
      position: [-roomHalf, wallHeight / 2, 0],
      order: 3,
      components: [
        primitive('box', [wallThickness, wallHeight, roomHalf * 2]),
        material('#4d5470', 0.85),
        rigidBody('static'),
        collider('box', [wallThickness, wallHeight, roomHalf * 2]),
      ],
    }),
    entity({
      id: 'wall-east',
      name: 'Wall East',
      position: [roomHalf, wallHeight / 2, 0],
      order: 4,
      components: [
        primitive('box', [wallThickness, wallHeight, roomHalf * 2]),
        material('#4d5470', 0.85),
        rigidBody('static'),
        collider('box', [wallThickness, wallHeight, roomHalf * 2]),
      ],
    }),
    entity({
      id: 'player',
      name: 'Player',
      position: [0, 1, -6],
      order: 5,
      components: [
        primitive('capsule', [0.7, 1.8, 0.7]),
        material('#e8c97a', 0.5, 0.05),
        rigidBody('kinematic', { lockRotation: true, angularDamping: 0.1 }),
        collider('capsule', [0.7, 1.8, 0.7], { offset: [0, 0.9, 0] }),
        behavior('player.mover', { moveSpeed: 5, jumpStrength: 6.5, gravity: 20, turnSpeed: 12 }),
      ],
    }),
    ...collectiblePositions.map((position, index) =>
      entity({
        id: `collectible-${index + 1}`,
        name: `Gem ${index + 1}`,
        position,
        order: 10 + index,
        components: [
          primitive('sphere', [0.6, 0.6, 0.6]),
          material('#6fe3c4', 0.35, 0.2),
          rigidBody('static'),
          collider('sphere', [0.6, 0.6, 0.6], { isSensor: true, reportContacts: true }),
          behavior('game.collectible', { value: 1, playerName: 'Player', hideOnCollect: true }),
        ],
      }),
    ),
    entity({
      id: 'exit-zone',
      name: 'Exit',
      position: [6.5, 1.2, 6.5],
      order: 20,
      components: [
        primitive('box', [2, 2.4, 2]),
        material('#5b9dff', 0.4, 0.1),
        rigidBody('static'),
        collider('box', [2, 2.4, 2], { isSensor: true, reportContacts: true }),
        behavior('game.exit-zone', { playerName: 'Player', requiredScore: 3, winMessage: 'All gems collected — you escaped!' }),
      ],
    }),
    entity({
      id: 'game-camera',
      name: 'Game Camera',
      position: [0, 6, -12],
      rotation: lookAt([0, 6, -12], [0, 1, 0]),
      order: 30,
      components: [
        { type: 'camera', mode: 'follow', fov: 55, near: 0.1, far: 400, targetId: 'player', distance: 9, height: 6, offset: [0, 0, 0], damping: 0.15 },
        behavior('camera.follow', { target: 'player', distance: 9, height: 7, offsetX: 6.3, offsetZ: 6.3, damping: 0.15, lookHeight: 1, fixed: true }),
      ],
    }),
    entity({ id: 'sun', name: 'Sun', position: [8, 12, 6], rotation: lookAt([8, 12, 6], [0, 0, 0]), order: 31, components: [DIRECTIONAL_SUN([8, 12, 6])] }),
    entity({ id: 'fill', name: 'Fill Light', order: 32, components: [AMBIENT_FILL] }),
    entity({
      id: 'rules',
      name: 'Game Rules',
      order: 40,
      components: [
        behavior('game.rules', {
          // The exit decides the win (requiredScore 3); 0 disables the score-only win so the
          // player still has to reach it.
          scoreTarget: 0,
          timeLimit: 0,
          initialObjective: 'Collect 3 gems, then reach the exit',
          nextScene: '',
          showStartOverlay: true,
          waitForStart: true,
          allowRestartKey: true,
        }),
      ],
    }),
  ];

  const scene: SceneDocument = {
    schemaVersion: SCENE_SCHEMA_VERSION,
    revision: 0,
    id: 'main',
    name: 'Collect Room',
    activeCameraId: 'game-camera',
    environment: {
      background: { type: 'color', color: '#181d29' },
      fog: { type: 'linear', color: '#181d29', near: 26, far: 60 },
      gravity: [0, -20, 0],
    },
    entities,
  };

  const game: GameDocumentInput = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    engineCompat: ENGINE_VERSION,
    id: 'collect-room',
    name: 'Collect Room',
    description: 'Walk around a room, collect every gem, and reach the exit.',
    scenes: [{ id: 'main', name: 'Collect Room', path: 'scenes/main.scene.json' }],
    startScene: 'main',
    assetManifest: 'assets/manifest.json',
    behaviorRegistry: 'scripts/registry.json',
    settings: {
      physics: { fixedTimeStep: 1 / 60, subStepCount: 4, maxSubSteps: 5, enableSleep: true, hitEventThreshold: 1 },
      render: { antialias: true, shadows: true, pixelRatioCap: 2, toneMapping: 'aces', exposure: 1 },
      initialGameState: { score: 0, collectiblesRemaining: 3, objective: 'Collect 3 gems', won: false, lost: false },
      hud: [
        { type: 'counter', id: 'score-counter', label: 'Gems', bind: 'score', target: 3, position: 'top-right', color: '#ffffff', size: 20 },
        { type: 'label', id: 'objective-label', text: 'Objective: {value}', bind: 'objective', position: 'top-left', color: '#c8d3e8', size: 15 },
        {
          type: 'overlay',
          id: 'start-overlay',
          kind: 'start',
          title: 'Collect Room',
          message: 'WASD or arrow keys to move, Space to jump. Collect every gem, then reach the blue exit.',
          actionLabel: 'Start',
          action: 'resume',
          background: '#101319',
          color: '#ffffff',
        },
        {
          type: 'overlay',
          id: 'win-overlay',
          kind: 'win',
          title: 'You escaped!',
          message: 'Every gem collected.',
          actionLabel: 'Play again',
          action: 'restart',
          background: '#101319',
          color: '#ffffff',
        },
      ],
      inputBindings: {
        moveForward: ['KeyW', 'ArrowUp'],
        moveBackward: ['KeyS', 'ArrowDown'],
        moveLeft: ['KeyA', 'ArrowLeft'],
        moveRight: ['KeyD', 'ArrowRight'],
        jump: ['Space'],
        interact: ['KeyE'],
        restart: ['KeyR'],
        primary: ['Mouse0'],
      },
    },
  };

  const readme = [
    '# Collect Room',
    '',
    'The first demonstration game from the implementation plan: a player moves around a room,',
    'collects items, and reaches an exit.',
    '',
    'Everything here is authored content: the level is a scene document, the rules are',
    'registered behaviors, and the tuning values below are editable in the inspector without',
    'touching code.',
    '',
    '| What | Where |',
    '| --- | --- |',
    '| Player speed, jump, gravity | `Player` → Character Mover |',
    '| Camera distance and height | `Game Camera` → Camera Follow |',
    '| Number of gems required | `Game Rules` → Score target, and `Exit` → Required score |',
    '| HUD labels and overlays | `game.json` → settings.hud |',
    '',
    'Run it with `pnpm dev`, open the project in the studio, and press Play. Or export it with',
    '`pnpm studio build collect-room`.',
    '',
  ].join('\n');

  return { scene, game, readme };
}

// ----------------------------------------------------------------- physics-targets

function physicsTargets(): BuiltGame {
  const targetPositions: Array<{ position: Vec3; size: Vec3; color: string }> = [
    { position: [-3, 1.2, -2], size: [1, 2.4, 1], color: '#e2705f' },
    { position: [-1, 1.2, -2], size: [1, 2.4, 1], color: '#e2a05f' },
    { position: [1, 1.2, -2], size: [1, 2.4, 1], color: '#e2d05f' },
    { position: [3, 1.2, -2], size: [1, 2.4, 1], color: '#9fe25f' },
    { position: [0, 3.4, -2], size: [1, 2.4, 1], color: '#5fd0e2' },
  ];

  const entities: Entity[] = [
    entity({
      id: 'platform',
      name: 'Platform',
      position: [0, -0.25, 0],
      order: 0,
      components: [
        primitive('box', [16, 0.5, 12], { castShadow: false }),
        material('#434b5c', 0.9),
        rigidBody('static'),
        collider('box', [16, 0.5, 12], { friction: 0.7 }),
      ],
    }),
    ...targetPositions.map((target, index) =>
      entity({
        id: `target-${index + 1}`,
        name: `Target ${index + 1}`,
        position: target.position,
        order: 10 + index,
        components: [
          primitive('box', target.size),
          material(target.color, 0.45),
          rigidBody('dynamic', { angularDamping: 0.15, linearDamping: 0.05 }),
          collider('box', target.size, { density: 0.6, friction: 0.7, restitution: 0.05, reportContacts: true }),
          behavior('game.target', { tipAngle: 45, minImpactSpeed: 1.2, value: 1 }),
        ],
      }),
    ),
    entity({
      id: 'ball',
      name: 'Ball',
      position: [0, 1.2, 4],
      order: 20,
      components: [
        primitive('sphere', [0.8, 0.8, 0.8]),
        material('#8fb8ff', 0.3, 0.1),
        rigidBody('dynamic', { angularDamping: 0.2, continuous: true }),
        collider('sphere', [0.8, 0.8, 0.8], { density: 1.4, friction: 0.4, restitution: 0.25, reportContacts: true }),
        behavior('game.launcher', { impulse: 11, upward: 0.3, projectileName: 'Ball', resetAfterLaunch: true, resetBelowY: -4 }),
      ],
    }),
    entity({
      id: 'game-camera',
      name: 'Game Camera',
      position: [0, 3.4, 7.5],
      rotation: lookAt([0, 3.4, 7.5], [0, 1.6, -2]),
      order: 30,
      components: [{ type: 'camera', mode: 'fixed', fov: 55, near: 0.1, far: 300, targetId: null, distance: 8, height: 4, offset: [0, 0, 0], damping: 0 }],
    }),
    entity({ id: 'sun', name: 'Sun', position: [6, 10, 8], rotation: lookAt([6, 10, 8], [0, 0, -2]), order: 31, components: [DIRECTIONAL_SUN([6, 10, 8], 2.4)] }),
    entity({ id: 'fill', name: 'Fill Light', order: 32, components: [AMBIENT_FILL] }),
    entity({
      id: 'rules',
      name: 'Game Rules',
      order: 40,
      components: [
        behavior('game.rules', {
          // Knocking every target down wins outright; the clock only ends the round.
          scoreTarget: 5,
          timeLimit: 60,
          initialObjective: 'Knock every target down',
          nextScene: '',
          showStartOverlay: true,
          waitForStart: true,
          allowRestartKey: true,
        }),
      ],
    }),
  ];

  const scene: SceneDocument = {
    schemaVersion: SCENE_SCHEMA_VERSION,
    revision: 0,
    id: 'main',
    name: 'Physics Targets',
    activeCameraId: 'game-camera',
    environment: {
      background: { type: 'color', color: '#141a25' },
      fog: { type: 'none' },
      gravity: [0, -18, 0],
    },
    entities,
  };

  const game: GameDocumentInput = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    engineCompat: ENGINE_VERSION,
    id: 'physics-targets',
    name: 'Physics Targets',
    description: 'Launch the ball, knock every target down, and beat the clock.',
    scenes: [{ id: 'main', name: 'Physics Targets', path: 'scenes/main.scene.json' }],
    startScene: 'main',
    assetManifest: 'assets/manifest.json',
    behaviorRegistry: 'scripts/registry.json',
    settings: {
      physics: { fixedTimeStep: 1 / 60, subStepCount: 4, maxSubSteps: 5, enableSleep: true, hitEventThreshold: 0.8 },
      render: { antialias: true, shadows: true, pixelRatioCap: 2, toneMapping: 'aces', exposure: 1 },
      initialGameState: { score: 0, targetsDown: 0, launches: 0, timeRemaining: 60, won: false, lost: false },
      hud: [
        { type: 'counter', id: 'score-counter', label: 'Targets down', bind: 'score', target: 5, position: 'top-right', color: '#ffffff', size: 20 },
        { type: 'label', id: 'time-label', text: 'Time: {value}s', bind: 'timeRemaining', position: 'top-left', color: '#c8d3e8', size: 15 },
        {
          type: 'overlay',
          id: 'start-overlay',
          kind: 'start',
          title: 'Physics Targets',
          message: 'Click to launch the ball at the targets. Knock all five down before the clock runs out.',
          actionLabel: 'Start',
          action: 'resume',
          background: '#101319',
          color: '#ffffff',
        },
        {
          type: 'overlay',
          id: 'win-overlay',
          kind: 'win',
          title: 'All targets down',
          message: 'Nice shooting.',
          actionLabel: 'Play again',
          action: 'restart',
          background: '#101319',
          color: '#ffffff',
        },
        {
          type: 'overlay',
          id: 'lose-overlay',
          kind: 'lose',
          title: 'Out of time',
          message: 'The clock beat you this time.',
          actionLabel: 'Try again',
          action: 'restart',
          background: '#101319',
          color: '#ffffff',
        },
      ],
      inputBindings: {
        primary: ['Mouse0'],
        restart: ['KeyR'],
        moveForward: ['KeyW'],
        moveBackward: ['KeyS'],
        moveLeft: ['KeyA'],
        moveRight: ['KeyD'],
        jump: ['Space'],
        interact: ['KeyE'],
      },
    },
  };

  const readme = [
    '# Physics Targets',
    '',
    'The second demonstration game: click to launch a physics object, knock the targets over,',
    'count the hits, and restart.',
    '',
    'It uses the same engine and editor as Collect Room — no separate hard-coded application.',
    '',
    '| What | Where |',
    '| --- | --- |',
    '| Launch impulse, upward bias | `Ball` → Projectile Launcher |',
    '| Tip angle that counts as a knock-down | `Target 1..5` → Knock-down Target |',
    '| Score target and time limit | `Game Rules` |',
    '',
    'Run it with `pnpm dev`, or export it with `pnpm studio build physics-targets`.',
    '',
  ].join('\n');

  return { scene, game, readme };
}

interface BuiltGame {
  scene: SceneDocument;
  game: GameDocumentInput;
  readme: string;
}

/** The project files a generated game ships, keyed by their path inside the project. */
type GameSourceFiles = {
  'game.json': string;
  'scenes/main.scene.json': string;
  'assets/manifest.json': string;
  'scripts/registry.json': string;
  'README.md': string;
};

async function writeFiles(target: string, files: Record<string, string>, label: string): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(target, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
    process.stdout.write(`wrote ${label}/${relative}\n`);
  }
}

function filesFor(built: BuiltGame): GameSourceFiles {
  return {
    'game.json': `${JSON.stringify(built.game, null, 2)}\n`,
    'scenes/main.scene.json': `${JSON.stringify(built.scene, null, 2)}\n`,
    'assets/manifest.json': `${JSON.stringify({ schemaVersion: 1, assets: [] }, null, 2)}\n`,
    'scripts/registry.json': `${JSON.stringify(registry.toJSON(), null, 2)}\n`,
    'README.md': built.readme,
  };
}

async function writeGame(id: string, built: BuiltGame): Promise<void> {
  const target = join(gamesRoot, id);
  await rm(target, { recursive: true, force: true });
  await writeFiles(target, filesFor(built), `games/${id}`);

  // The same content also ships as a whole-project template, so `studio create --template`
  // starts from a working game instead of an empty scene.
  const templateTarget = join(root, 'templates', id);
  await rm(templateTarget, { recursive: true, force: true });
  const templateGame = { ...built.game, id, name: `${String(built.game.name)}` };
  await writeFiles(templateTarget, filesFor({ ...built, game: templateGame }), `templates/${id}`);
}

await writeGame('collect-room', collectRoom());
await writeGame('physics-targets', physicsTargets());
