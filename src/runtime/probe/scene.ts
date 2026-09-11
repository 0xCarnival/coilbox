import * as THREE from 'three';
import { parseScene, type GameDocument, type SceneDocument } from '@schema/index.js';
import { ENGINE_VERSION, PROJECT_SCHEMA_VERSION, SCENE_SCHEMA_VERSION } from '@schema/index.js';

/**
 * Stage 0 probe: the smallest scene that proves the runtime skeleton end to end —
 * a static ground, a dynamic box that falls under gravity, a shadow-casting light, and
 * a camera. It is defined in code so both the probe page and the automated tests can
 * use the identical document without file IO.
 */

export const PROBE_SCENE_ID = 'probe';
export const PROBE_GROUND_ID = 'ground';
export const PROBE_BOX_ID = 'falling-box';
export const PROBE_CAMERA_ID = 'probe-camera';

/**
 * Quaternion that aims an entity's forward axis at `target` from `eye`.
 *
 * Engine convention: an entity's forward axis is its local **-Z** axis, matching how
 * three.js orients cameras (`Object3D.lookAt` uses +Z for plain objects and -Z for
 * cameras and lights, which silently produces a 180-degree error if you use the wrong
 * one). Cameras and directional/spot lights both follow the -Z convention here.
 */
export function lookAtQuaternion(eye: [number, number, number], target: [number, number, number]): [number, number, number, number] {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(eye[0], eye[1], eye[2]);
  camera.lookAt(target[0], target[1], target[2]);
  const { x, y, z, w } = camera.quaternion;
  return [x, y, z, w];
}

export const probeScene: SceneDocument = parseScene({
  schemaVersion: SCENE_SCHEMA_VERSION,
  revision: 0,
  id: PROBE_SCENE_ID,
  name: 'Stage 0 probe',
  activeCameraId: PROBE_CAMERA_ID,
  environment: {
    background: { type: 'color', color: '#202431' },
    gravity: [0, -9.81, 0],
    fog: { type: 'none' },
  },
  entities: [
    {
      id: PROBE_GROUND_ID,
      name: 'Ground',
      order: 0,
      transform: { position: [0, -0.25, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [
        { type: 'primitive', shape: 'box', size: [20, 0.5, 20], castShadow: false, receiveShadow: true },
        { type: 'material', color: '#4b5563', roughness: 0.95 },
        { type: 'rigidBody', bodyType: 'static' },
        { type: 'collider', shape: 'box', size: [20, 0.5, 20], offset: [0, 0, 0], friction: 0.7, restitution: 0 },
      ],
    },
    {
      id: PROBE_BOX_ID,
      name: 'Falling Box',
      order: 1,
      transform: { position: [0, 4, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [
        { type: 'primitive', shape: 'box', size: [1, 1, 1], castShadow: true, receiveShadow: true },
        { type: 'material', color: '#e0a458', roughness: 0.5, metalness: 0.05 },
        { type: 'rigidBody', bodyType: 'dynamic', angularDamping: 0.2, linearDamping: 0 },
        { type: 'collider', shape: 'box', size: [1, 1, 1], offset: [0, 0, 0], density: 1, friction: 0.6, restitution: 0.1 },
      ],
    },
    {
      id: 'key-light',
      name: 'Key Light',
      order: 2,
      transform: { position: [6, 9, 5], rotation: lookAtQuaternion([6, 9, 5], [0, 0, 0]), scale: [1, 1, 1] },
      components: [
        {
          type: 'light',
          kind: 'directional',
          color: '#fff6e6',
          intensity: 2.4,
          castShadow: true,
          shadowMapSize: 1024,
          shadowExtent: 12,
        },
      ],
    },
    {
      id: 'fill-light',
      name: 'Fill Light',
      order: 3,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [{ type: 'light', kind: 'hemisphere', color: '#8fa6c8', groundColor: '#2a2f3a', intensity: 0.7 }],
    },
    {
      id: PROBE_CAMERA_ID,
      name: 'Probe Camera',
      order: 4,
      transform: { position: [6, 4.5, 8], rotation: lookAtQuaternion([6, 4.5, 8], [0, 0.5, 0]), scale: [1, 1, 1] },
      components: [{ type: 'camera', mode: 'free', fov: 55, near: 0.1, far: 500 }],
    },
  ],
} as unknown as SceneDocument).value as SceneDocument;

/** `game.json` for the probe; the player entry point loads the equivalent JSON file. */
export const probeGame: GameDocument = {
  schemaVersion: PROJECT_SCHEMA_VERSION,
  engineVersion: ENGINE_VERSION,
  engineCompat: ENGINE_VERSION,
  id: 'stage0-probe',
  name: 'Stage 0 probe',
  description: 'Blank runtime with a falling box, used to verify rendering, physics, cleanup, and the WASM production build.',
  scenes: [{ id: PROBE_SCENE_ID, name: 'Stage 0 probe', path: 'scenes/main.scene.json' }],
  startScene: PROBE_SCENE_ID,
  assetManifest: 'assets/manifest.json',
  behaviorRegistry: 'scripts/registry.json',
  settings: {
    physics: { fixedTimeStep: 1 / 60, subStepCount: 4, maxSubSteps: 5, enableSleep: true, hitEventThreshold: 1 },
    render: { antialias: true, shadows: true, pixelRatioCap: 2, toneMapping: 'aces', exposure: 1 },
    initialGameState: {},
    hud: [],
    inputBindings: {},
  },
};

/** Physics time (seconds) after which the probe box is expected to be at rest. */
export const PROBE_SETTLE_SECONDS = 3;
/** Y position the 1 m box rests at when sitting on the ground surface (y = 0). */
export const PROBE_RESTING_Y = 0.5;
export const PROBE_DROP_Y = 4;
