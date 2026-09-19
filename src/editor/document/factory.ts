import type { Component, ComponentType, Entity, EntityId, PrimitiveComponent, PrimitiveShape, SceneDocument } from '@schema/index.js';
import * as THREE from 'three';
import { createEntityId, findEntity } from './commands.js';
import type { EditorCommand } from './commands.js';

/**
 * Entity creation for the creation menu (plan §4: "A compact creation menu").
 *
 * New entities are built from the same component records the loader validates, so a
 * created object is authored content from the moment it exists, not a viewport-only stub.
 */

export type CreatableKind = 'group' | PrimitiveShape | 'camera' | 'directionalLight' | 'pointLight';

export const CREATABLE_LABELS: Record<CreatableKind, string> = {
  group: 'Empty Group',
  box: 'Box',
  sphere: 'Sphere',
  plane: 'Plane',
  capsule: 'Capsule',
  cylinder: 'Cylinder',
  camera: 'Camera',
  directionalLight: 'Directional Light',
  pointLight: 'Point Light',
};

export const CREATABLE_KINDS: CreatableKind[] = [
  'group',
  'box',
  'sphere',
  'plane',
  'capsule',
  'cylinder',
  'camera',
  'directionalLight',
  'pointLight',
];

const PRIMITIVE_DEFAULTS: Record<PrimitiveShape, { size: [number, number, number]; name: string }> = {
  box: { size: [1, 1, 1], name: 'Box' },
  sphere: { size: [1, 1, 1], name: 'Sphere' },
  plane: { size: [4, 0.1, 4], name: 'Plane' },
  capsule: { size: [0.6, 1.8, 0.6], name: 'Capsule' },
  cylinder: { size: [0.8, 1.4, 0.8], name: 'Cylinder' },
};

export interface CreateEntityOptions {
  id?: EntityId;
  name?: string;
  position?: [number, number, number];
  parentId?: EntityId | null;
  /** Ids already in use, so the generated id never collides. */
  usedIds?: Iterable<string>;
  /** Order within the parent; defaults to the end. */
  order?: number;
}

export function createEntity(kind: CreatableKind, options: CreateEntityOptions = {}): Entity {
  const used = options.usedIds ?? [];
  const id = options.id ?? createEntityId(defaultPrefix(kind), used);
  const position = options.position ?? [0, 0, 0];
  const base: Entity = {
    id,
    name: options.name ?? defaultName(kind),
    parentId: options.parentId ?? null,
    order: options.order ?? 0,
    enabled: true,
    transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    components: componentsFor(kind),
    editor: { visible: true, locked: false, color: null, helper: false },
  };
  return base;
}

function defaultPrefix(kind: CreatableKind): string {
  switch (kind) {
    case 'group':
      return 'group';
    case 'directionalLight':
      return 'sun';
    case 'pointLight':
      return 'lamp';
    default:
      return kind;
  }
}

function defaultName(kind: CreatableKind): string {
  switch (kind) {
    case 'group':
      return 'Group';
    case 'camera':
      return 'Camera';
    case 'directionalLight':
      return 'Directional Light';
    case 'pointLight':
      return 'Point Light';
    default:
      return PRIMITIVE_DEFAULTS[kind].name;
  }
}

export function componentsFor(kind: CreatableKind): Component[] {
  switch (kind) {
    case 'group':
      return [];
    case 'camera':
      return [
        {
          type: 'camera',
          mode: 'free',
          fov: 60,
          near: 0.1,
          far: 1000,
          targetId: null,
          distance: 8,
          height: 5,
          offset: [0, 0, 0],
          damping: 0.12,
        },
      ];
    case 'directionalLight':
      return [
        {
          type: 'light',
          kind: 'directional',
          color: '#ffffff',
          intensity: 2.4,
          groundColor: '#444444',
          castShadow: true,
          shadowMapSize: 1024,
          shadowBias: -0.0005,
          shadowExtent: 25,
          range: 20,
          decay: 2,
          coneAngleDegrees: 30,
        },
      ];
    case 'pointLight':
      return [
        {
          type: 'light',
          kind: 'point',
          color: '#ffd9a0',
          intensity: 6,
          groundColor: '#444444',
          castShadow: false,
          shadowMapSize: 512,
          shadowBias: -0.0005,
          shadowExtent: 25,
          range: 12,
          decay: 2,
          coneAngleDegrees: 30,
        },
      ];
    default: {
      const { size } = PRIMITIVE_DEFAULTS[kind];
      return [
        {
          type: 'primitive',
          shape: kind,
          size: [size[0], size[1], size[2]],
          castShadow: true,
          receiveShadow: true,
        },
      ];
    }
  }
}

/** Whether a component is the primitive a created shape always carries. */
const isPrimitiveComponent = (component: Component): component is PrimitiveComponent => component.type === 'primitive';

/** Small starter scene used when a project is created without a template. */
export function createStarterScene(sceneId: string, name: string): SceneDocument {
  const used = new Set<string>();
  // Ground visual and collider are the same 10 x 0.4 x 10 box sitting just below y = 0, so
  // what the author sees is what the physics world uses.
  const ground = createEntity('box', { id: 'ground', name: 'Ground', usedIds: used });
  used.add(ground.id);
  ground.transform.position = [0, -0.2, 0];
  const groundShape = ground.components.find(isPrimitiveComponent);
  if (!groundShape) throw new Error('a box entity must carry a primitive component');
  groundShape.size = [10, 0.4, 10];
  ground.components.push({
    type: 'material',
    color: '#4b5563',
    roughness: 0.95,
    metalness: 0,
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
  ground.components.push({ type: 'rigidBody', bodyType: 'static', mass: null, gravityScale: 1, linearDamping: 0, angularDamping: 0.05, lockRotation: false, continuous: false, moveWithPhysics: true });
  ground.components.push({
    type: 'collider',
    shape: 'box',
    size: [10, 0.4, 10],
    offset: [0, 0, 0],
    localRotation: [0, 0, 0, 1],
    isSensor: false,
    friction: 0.7,
    restitution: 0,
    density: 1,
    reportContacts: false,
  });

  const player = createEntity('capsule', { id: 'player', name: 'Player', usedIds: used, position: [0, 1, 0] });
  used.add(player.id);

  const camera = createEntity('camera', { id: 'game-camera', name: 'Game Camera', usedIds: used, position: [0, 5, 9] });
  used.add(camera.id);
  camera.transform.rotation = lookAt([0, 5, 9], [0, 1, 0]);

  const sun = createEntity('directionalLight', { id: 'sun', name: 'Sun', usedIds: used, position: [6, 9, 5] });
  used.add(sun.id);
  sun.transform.rotation = lookAt([6, 9, 5], [0, 0, 0]);

  return {
    schemaVersion: 1,
    revision: 0,
    id: sceneId,
    name,
    activeCameraId: camera.id,
    environment: {
      background: { type: 'color', color: '#202431' },
      fog: { type: 'none' },
      gravity: [0, -9.81, 0],
    },
    entities: [ground, player, camera, sun],
  };
}

/** Quaternion aiming an entity's local -Z axis from `eye` at `target` (engine convention). */
export function lookAt(eye: [number, number, number], target: [number, number, number]): [number, number, number, number] {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(eye[0], eye[1], eye[2]);
  camera.lookAt(target[0], target[1], target[2]);
  const { x, y, z, w } = camera.quaternion;
  return [x, y, z, w];
}

/**
 * Commands that move an entity under a new parent while keeping its world transform.
 *
 * Returns an empty array when the move cannot be represented by position/rotation/scale
 * (shear, mirroring, non-uniform parent scale). Callers reject the move instead of
 * corrupting the transform (plan §8).
 */
export function reparentPreservingWorldTransform(
  scene: SceneDocument,
  entityId: EntityId,
  newParentId: EntityId | null,
  index?: number,
): EditorCommand[] {
  const entity = findEntity(scene, entityId);
  if (!entity) return [];
  if (entityId === newParentId) return [];

  const entityWorld = worldMatrix(scene, entityId);
  const parentWorld = newParentId === null ? new THREE.Matrix4() : worldMatrix(scene, newParentId);
  const local = new THREE.Matrix4().copy(parentWorld).invert().multiply(entityWorld);

  const decomposed = decomposeStrict(local);
  if (!decomposed) return [];

  return [
    { kind: 'reparentEntity', entityId, parentId: newParentId, index },
    {
      kind: 'setTransform',
      entityId,
      transform: {
        position: decomposed.position,
        rotation: decomposed.quaternion,
        scale: decomposed.scale,
      },
    },
  ];
}

/** Composed world matrix of an entity, walking up the parent chain. */
export function worldMatrix(scene: SceneDocument, entityId: EntityId): THREE.Matrix4 {
  const chain: Entity[] = [];
  let cursor: Entity | undefined = findEntity(scene, entityId);
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parentId === null ? undefined : findEntity(scene, cursor.parentId);
  }
  const matrix = new THREE.Matrix4();
  for (const entity of chain.reverse()) {
    matrix.multiply(localMatrix(entity));
  }
  return matrix;
}

export function localMatrix(entity: Entity): THREE.Matrix4 {
  const { position, rotation, scale } = entity.transform;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(position[0], position[1], position[2]),
    new THREE.Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]).normalize(),
    new THREE.Vector3(scale[0], scale[1], scale[2]),
  );
}

export interface DecomposedTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

/**
 * Decompose a matrix into TRS, refusing matrices that would need shear or mirroring.
 * Returning null is the correct answer for those cases: the format cannot store them.
 */
export function decomposeStrict(matrix: THREE.Matrix4): DecomposedTransform | null {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);

  if (![position.x, position.y, position.z, quaternion.x, quaternion.y, quaternion.z, quaternion.w, scale.x, scale.y, scale.z].every(Number.isFinite)) {
    return null;
  }
  if (scale.x <= 1e-6 || scale.y <= 1e-6 || scale.z <= 1e-6) return null;
  if (matrix.determinant() < 0) return null;

  // Rebuild from the decomposition: any difference beyond tolerance means shear.
  const rebuilt = new THREE.Matrix4().compose(position, quaternion, scale);
  for (let index = 0; index < 16; index += 1) {
    if (Math.abs(rebuilt.elements[index] - matrix.elements[index]) > 1e-4) return null;
  }

  return {
    position: [position.x, position.y, position.z],
    quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    scale: [scale.x, scale.y, scale.z],
  };
}

/** Component types an entity may gain from the Add Component menu. */
export const ADDABLE_COMPONENTS: ComponentType[] = [
  'primitive',
  'camera',
  'light',
  'rigidBody',
  'collider',
  'material',
  'animation',
  'audio',
  'behavior',
];
