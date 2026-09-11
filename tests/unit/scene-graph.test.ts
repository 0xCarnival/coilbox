import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildSceneGraph, createLight, AIM_DISTANCE_METRES } from '@runtime/scene-graph.js';
import { probeScene, lookAtQuaternion } from '@runtime/probe/scene.js';
import { parseScene, type SceneDocument } from '@schema/index.js';

/**
 * Scene-graph projection tests.
 *
 * The first test is a regression test for a real bug found during stage 0: `Object3D.lookAt`
 * aims a plain object's **+Z** axis at the target but a camera's **-Z** axis. Building the
 * probe camera's rotation with a plain object produced a camera that faced 180 degrees away
 * from the scene, so the world rendered an empty frame while physics ran perfectly.
 */

function forwardOf(object: THREE.Object3D): THREE.Vector3 {
  return new THREE.Vector3(0, 0, -1).applyQuaternion(object.getWorldQuaternion(new THREE.Quaternion())).normalize();
}

describe('scene graph projection', () => {
  it('keeps the probe camera looking at the scene centre', () => {
    const scene = parseScene(probeScene).value as SceneDocument;
    const graph = buildSceneGraph(scene);
    const camera = graph.camera;
    expect(camera).not.toBeNull();
    if (!camera) return;

    graph.root.updateMatrixWorld(true);
    const eye = camera.getWorldPosition(new THREE.Vector3());
    const forward = forwardOf(camera);
    const toTarget = new THREE.Vector3(0, 0.5, 0).sub(eye).normalize();
    expect(eye.toArray()).toEqual([6, 4.5, 8]);
    expect(forward.dot(toTarget)).toBeGreaterThan(0.999);
  });

  it('aims a directional light along the entity -Z axis', () => {
    const scene = parseScene(probeScene).value as SceneDocument;
    const graph = buildSceneGraph(scene);
    const lightEntity = graph.entities.get('key-light');
    expect(lightEntity?.light).toBeInstanceOf(THREE.DirectionalLight);
    const light = lightEntity?.light as THREE.DirectionalLight;
    graph.root.updateMatrixWorld(true);

    expect(light.position.toArray()).toEqual([0, 0, 0]);
    const lightPosition = light.getWorldPosition(new THREE.Vector3());
    const targetPosition = light.target.getWorldPosition(new THREE.Vector3());
    const offset = new THREE.Vector3().subVectors(targetPosition, lightPosition);
    // The light sits up and to the side; it must shine towards the origin, not away.
    const toOrigin = new THREE.Vector3(0, 0, 0).sub(lightPosition).normalize();
    expect(offset.clone().normalize().dot(toOrigin)).toBeGreaterThan(0.999);
    expect(offset.length()).toBeCloseTo(AIM_DISTANCE_METRES, 6);
  });

  it('places the spot/directional aim point as a child of the light entity', () => {
    const light = createLight({
      type: 'light',
      kind: 'directional',
      color: '#ffffff',
      intensity: 1,
      groundColor: '#444444',
      castShadow: false,
      shadowMapSize: 1024,
      shadowBias: -0.0005,
      shadowExtent: 10,
      range: 20,
      decay: 2,
      coneAngleDegrees: 30,
    });
    expect(light).toBeInstanceOf(THREE.DirectionalLight);
  });

  it('skips disabled entities and their subtrees', () => {
    const scene = parseScene({
      schemaVersion: 1,
      id: 's',
      name: 'S',
      entities: [
        { id: 'parent', name: 'Parent', enabled: false, components: [{ type: 'primitive', shape: 'box', size: [1, 1, 1] }] },
        { id: 'child', name: 'Child', parentId: 'parent', components: [{ type: 'primitive', shape: 'box', size: [1, 1, 1] }] },
        { id: 'solo', name: 'Solo', components: [{ type: 'primitive', shape: 'sphere', size: [1, 1, 1] }] },
      ],
    }).value as SceneDocument;
    const graph = buildSceneGraph(scene);
    expect(graph.entities.has('parent')).toBe(false);
    expect(graph.entities.has('child')).toBe(false);
    expect(graph.entities.has('solo')).toBe(true);
  });

  it('excludes editor-only helpers from the runtime scene', () => {
    const scene = parseScene({
      schemaVersion: 1,
      id: 's',
      name: 'S',
      entities: [
        { id: 'marker', name: 'Marker', editor: { helper: true }, components: [{ type: 'primitive', shape: 'box', size: [1, 1, 1] }] },
      ],
    }).value as SceneDocument;
    const graph = buildSceneGraph(scene);
    expect(graph.entities.size).toBe(0);
  });

  it('honours explicit sibling order', () => {
    const scene = parseScene({
      schemaVersion: 1,
      id: 's',
      name: 'S',
      entities: [
        { id: 'b', name: 'B', order: 2 },
        { id: 'a', name: 'A', order: 1 },
      ],
    }).value as SceneDocument;
    const graph = buildSceneGraph(scene);
    expect(graph.root.children.map((child) => child.name)).toEqual(['A', 'B']);
  });

  it('reparents nested entities and reports a missing parent instead of dropping the object', () => {
    const scene = parseScene({
      schemaVersion: 1,
      id: 's',
      name: 'S',
      entities: [
        { id: 'group', name: 'Group' },
        { id: 'child', name: 'Child', parentId: 'group' },
        { id: 'orphan', name: 'Orphan', parentId: 'missing' },
      ],
    }).value as SceneDocument;
    const graph = buildSceneGraph(scene);
    const group = graph.entities.get('group')?.object;
    expect(group?.children.map((child) => child.name)).toContain('Child');
    expect(graph.warnings.some((warning) => warning.includes('Orphan'))).toBe(true);
    expect(graph.root.children.map((child) => child.name)).toContain('Orphan');
  });

  it('shows a placeholder for a model with no prepared instance and records why', () => {
    const scene = parseScene({
      schemaVersion: 1,
      id: 's',
      name: 'S',
      entities: [{ id: 'm', name: 'M', components: [{ type: 'model', assetId: 'thing.glb' }] }],
    }).value as SceneDocument;
    const warnings: string[] = [];
    const graph = buildSceneGraph(scene, { onWarning: (message) => warnings.push(message) });
    const placeholder = graph.entities.get('m')?.visual as THREE.Mesh | null;
    expect(placeholder?.name).toBe('model-placeholder');
    expect(warnings.join(' ')).toMatch(/could not load its model/);
  });

  it('rejects components the runtime still cannot run instead of silently ignoring them', () => {
    const scene = parseScene({
      schemaVersion: 1,
      id: 's',
      name: 'S',
      entities: [{ id: 'b', name: 'B', components: [{ type: 'behavior', behaviorId: 'game.rules', properties: {} }] }],
    }).value as SceneDocument;
    expect(() => buildSceneGraph(scene)).toThrow(/behavior component/);
  });

  it('builds an offset collider size from the collider component, not the visual size', () => {
    // The camera-look-at regression is covered above; here we simply assert that the
    // projection does not confuse the visual mesh with the physics collider.
    const scene = parseScene(probeScene).value as SceneDocument;
    const graph = buildSceneGraph(scene);
    const box = graph.entities.get('falling-box');
    const mesh = box?.mesh as THREE.Mesh;
    const parameters = (mesh.geometry as THREE.BoxGeometry).parameters;
    expect(parameters.width).toBe(1);
    expect(parameters.height).toBe(1);
    expect(lookAtQuaternion([0, 0, 0], [0, 0, -1])[3]).toBeCloseTo(1, 6);
  });
});
