import * as THREE from 'three';
import type { Component, Entity, LightComponent, PrimitiveComponent, SceneDocument } from '@schema/index.js';
import { AnimationController } from './animation.js';
import type { ModelInstance } from './assets/loader.js';

/**
 * Scene-document -> Three.js projection (plan §6, §7).
 *
 * Rendering objects are a projection of project data, never the source of truth. This
 * module builds objects, geometries, materials, and lights for a scene document and
 * reports exactly what it created so the runtime can dispose it again.
 *
 * Model and animation components are projected from instances prepared by the caller: the
 * runtime preloads assets asynchronously and hands each entity its own instance, so this
 * function stays synchronous and testable. Audio playback and behaviors raise a clear error
 * instead of silently doing nothing.
 */

export class RuntimeWorldError extends Error {
  readonly code: string;
  readonly entityId?: string;

  constructor(code: string, message: string, entityId?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RuntimeWorldError';
    this.code = code;
    this.entityId = entityId;
  }
}

/** Distance used to place a directional/spot light's aim point, in metres. */
export const AIM_DISTANCE_METRES = 10;

export interface BuiltEntity {
  entity: Entity;
  /** Transform owner for the entity (world transform for physics roots). */
  object: THREE.Object3D;
  /** Visual child, when the entity renders something. */
  visual: THREE.Object3D | null;
  mesh: THREE.Mesh | null;
  light: THREE.Light | null;
  camera: THREE.PerspectiveCamera | null;
  hasPhysics: boolean;
  /** Present when the entity plays an imported clip. */
  animation: AnimationController | null;
  /** Instance materials owned by this entity, for recolouring and disposal. */
  instanceMaterials: THREE.Material[];
}

export interface BuiltScene {
  root: THREE.Group;
  entities: Map<string, BuiltEntity>;
  /** Active game camera, or null when the scene has no camera entity. */
  camera: THREE.PerspectiveCamera | null;
  warnings: string[];
}

export interface BuildSceneOptions {
  /** Editor helpers are skipped in runtime worlds; kept for future preview use. */
  includeHelpers?: boolean;
  /**
   * Prepared model instances keyed by entity id. The caller loads assets (asynchronously)
   * and instantiates one copy per entity; a missing entry becomes a placeholder with a
   * recorded error rather than a silent empty object.
   */
  models?: Map<string, ModelInstance>;
  onWarning?: (message: string) => void;
}

export function buildSceneGraph(scene: SceneDocument, options: BuildSceneOptions = {}): BuiltScene {
  const root = new THREE.Group();
  root.name = `scene:${scene.id}`;
  const entities = new Map<string, BuiltEntity>();
  const warnings: string[] = [];

  const ordered = [...scene.entities].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const knownIds = new Set(ordered.map((entity) => entity.id));
  const enabledIds = new Set(ordered.filter((e) => e.enabled).map((e) => e.id));

  for (const entity of ordered) {
    if (!entity.enabled) continue;
    // A disabled ancestor disables the whole subtree for gameplay purposes. A *missing*
    // parent is not the same thing: validation reports it, and the runtime keeps the
    // entity as a root with a warning rather than silently deleting the object.
    if (entity.parentId !== null && knownIds.has(entity.parentId) && !enabledIds.has(entity.parentId)) continue;
    if (options.includeHelpers !== true && entity.editor.helper) continue;

    const object = new THREE.Group();
    object.name = entity.name;
    object.userData.entityId = entity.id;
    applyTransform(object, entity);

    const built: BuiltEntity = {
      entity,
      object,
      visual: null,
      mesh: null,
      light: null,
      camera: null,
      hasPhysics: false,
      animation: null,
      instanceMaterials: [],
    };

    for (const component of entity.components) {
      switch (component.type) {
        case 'primitive': {
          const mesh = createPrimitiveMesh(component);
          object.add(mesh);
          built.mesh = mesh;
          built.visual = mesh;
          break;
        }
        case 'material': {
          if (!built.mesh) {
            warnings.push(`entity "${entity.name}" has a material component but nothing to apply it to yet`);
            break;
          }
          applyMaterial(built.mesh.material as THREE.MeshStandardMaterial, component);
          break;
        }
        case 'light': {
          const light = createLight(component);
          object.add(light);
          // A directional or spot light shines from its origin toward `light.target`.
          // Keeping the target 10 m along the entity's local -Z axis means rotating the
          // light entity in the editor aims the light, instead of the light silently
          // pointing at the world origin.
          if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
            light.target.position.set(0, 0, -AIM_DISTANCE_METRES);
            light.target.updateMatrixWorld();
            object.add(light.target);
          }
          built.light = light;
          break;
        }
        case 'camera': {
          const camera = new THREE.PerspectiveCamera(component.fov, 1, component.near, component.far);
          camera.name = `${entity.name} (camera)`;
          object.add(camera);
          built.camera = camera;
          // `mode` describes the camera's intent; the camera.follow behavior is what moves it.
          break;
        }
        case 'model': {
          const instance = options.models?.get(entity.id);
          if (!instance) {
            // The world records why; the entity still gets a visible, selectable placeholder
            // so a broken asset does not look like an empty scene.
            const placeholder = createModelPlaceholder();
            object.add(placeholder);
            built.visual = placeholder;
            options.onWarning?.(`entity "${entity.name}" could not load its model; a placeholder is shown`);
            break;
          }
          object.add(instance.object);
          built.visual = instance.object;
          built.instanceMaterials = instance.materials;
          break;
        }
        case 'animation': {
          const instance = options.models?.get(entity.id);
          if (!instance) {
            options.onWarning?.(`entity "${entity.name}" has an animation component but no model to animate`);
            break;
          }
          const controller = new AnimationController(instance.object, instance.clips, component);
          for (const warning of controller.warningList) options.onWarning?.(`entity "${entity.name}": ${warning}`);
          built.animation = controller;
          break;
        }
        case 'audio':
          // The audio component is a reference, not a renderable: the runtime plays it when a
          // behavior asks (see AudioSystem) and nothing is drawn for it here.
          break;
        case 'behavior':
          // Behaviors are instantiated by the behavior runtime, never by the scene builder.
          break;
        case 'rigidBody':
        case 'collider':
          built.hasPhysics = true;
          break;
        default:
          break;
      }
    }

    entities.set(entity.id, built);
  }

  // Attach in a second pass so parent/child order does not matter and disabled
  // subtrees are already filtered out.
  for (const built of entities.values()) {
    const parentId = built.entity.parentId;
    const parent = parentId === null ? null : entities.get(parentId);
    if (parent) {
      parent.object.add(built.object);
    } else {
      if (parentId !== null && !entities.has(parentId) && built.entity.enabled) {
        warnings.push(`entity "${built.entity.name}" lost its parent because the parent is disabled or a helper`);
      }
      root.add(built.object);
    }
  }

  const camera = resolveActiveCamera(scene, entities, warnings);
  return { root, entities, camera, warnings };
}

function resolveActiveCamera(
  scene: SceneDocument,
  entities: Map<string, BuiltEntity>,
  warnings: string[],
): THREE.PerspectiveCamera | null {
  if (scene.activeCameraId !== null) {
    const active = entities.get(scene.activeCameraId);
    if (active?.camera) return active.camera;
    warnings.push(`active camera "${scene.activeCameraId}" is missing or disabled; falling back to the first camera`);
  }
  for (const built of entities.values()) {
    if (built.camera) return built.camera;
  }
  warnings.push('scene has no enabled camera; the runtime uses a default viewpoint');
  return null;
}

export function applyTransform(object: THREE.Object3D, entity: Entity): void {
  const { position, rotation, scale } = entity.transform;
  object.position.set(position[0], position[1], position[2]);
  object.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]).normalize();
  object.scale.set(scale[0], scale[1], scale[2]);
}

/** Visible stand-in for a model that failed to load. Editor-only styling, runtime-visible. */
function createModelPlaceholder(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.8, 0.8),
    new THREE.MeshBasicMaterial({ color: 0xff7a5b, wireframe: true }),
  );
  mesh.name = 'model-placeholder';
  return mesh;
}

export function createPrimitiveGeometry(component: PrimitiveComponent): THREE.BufferGeometry {
  const [sx, sy, sz] = component.size;
  switch (component.shape) {
    case 'box':
      return new THREE.BoxGeometry(sx, sy, sz);
    case 'sphere':
      return new THREE.SphereGeometry(sx / 2, 32, 16);
    case 'plane': {
      const geometry = new THREE.PlaneGeometry(sx, sz);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    }
    case 'capsule': {
      const radius = sx / 2;
      const length = Math.max(0, sy - sx);
      return new THREE.CapsuleGeometry(radius, length, 8, 16);
    }
    case 'cylinder':
      return new THREE.CylinderGeometry(sx / 2, sx / 2, sy, 24);
    default: {
      const exhaustive: never = component.shape;
      throw new RuntimeWorldError('unsupported-primitive', `unsupported primitive shape: ${String(exhaustive)}`);
    }
  }
}

/** Each primitive owns its material so per-instance recolouring never leaks. */
export function createPrimitiveMaterial(component: PrimitiveComponent): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(component.shape === 'plane' ? '#9aa4b2' : '#c8ccd4'),
    roughness: 0.85,
    metalness: 0,
  });
}

/** Shared by the runtime and the editor viewport so a primitive looks the same in both. */
export function createPrimitiveMesh(component: PrimitiveComponent): THREE.Mesh {
  const geometry = createPrimitiveGeometry(component);
  const material = createPrimitiveMaterial(component);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = component.castShadow;
  mesh.receiveShadow = component.receiveShadow;
  mesh.name = `primitive:${component.shape}`;
  return mesh;
}

export function applyMaterial(material: THREE.MeshStandardMaterial, component: Extract<Component, { type: 'material' }>): void {
  material.color.set(component.color);
  material.roughness = component.roughness;
  material.metalness = component.metalness;
  material.emissive.set(component.emissive);
  material.emissiveIntensity = component.emissiveIntensity;
  material.opacity = component.opacity;
  material.transparent = component.transparent;
  material.side = component.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  material.flatShading = component.flatShading;
  material.visible = component.visible;
  material.needsUpdate = true;
}

export function createLight(component: LightComponent): THREE.Light {
  switch (component.kind) {
    case 'ambient':
      return new THREE.AmbientLight(new THREE.Color(component.color), component.intensity);
    case 'hemisphere':
      return new THREE.HemisphereLight(
        new THREE.Color(component.color),
        new THREE.Color(component.groundColor),
        component.intensity,
      );
    case 'point':
      return new THREE.PointLight(new THREE.Color(component.color), component.intensity, component.range, component.decay);
    case 'spot': {
      // three's DirectionalLight/SpotLight default to a (0, 1, 0) local offset; an entity's
      // light belongs at the entity origin so the authored transform is the whole story.
      const spot = new THREE.SpotLight(
        new THREE.Color(component.color),
        component.intensity,
        component.range,
        THREE.MathUtils.degToRad(component.coneAngleDegrees),
        0.3,
        component.decay,
      );
      spot.position.set(0, 0, 0);
      spot.castShadow = component.castShadow;
      if (component.castShadow) spot.shadow.mapSize.set(component.shadowMapSize, component.shadowMapSize);
      return spot;
    }
    case 'directional':
    default: {
      const light = new THREE.DirectionalLight(new THREE.Color(component.color), component.intensity);
      light.position.set(0, 0, 0);
      light.castShadow = component.castShadow;
      if (component.castShadow) {
        light.shadow.mapSize.set(component.shadowMapSize, component.shadowMapSize);
        light.shadow.bias = component.shadowBias;
        const extent = component.shadowExtent;
        light.shadow.camera.left = -extent;
        light.shadow.camera.right = extent;
        light.shadow.camera.top = extent;
        light.shadow.camera.bottom = -extent;
        light.shadow.camera.near = 0.1;
        light.shadow.camera.far = extent * 4;
        light.shadow.camera.updateProjectionMatrix();
      }
      return light;
    }
  }
}
