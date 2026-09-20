import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildSceneGraph } from '@runtime/scene-graph.js';
import { BATCHED_LAYER, isStaticInGame, primitiveBatchKey } from '@runtime/instancing.js';
import { parseScene, type JsonValue, type SceneDocument } from '@schema/index.js';

const box: JsonValue = { type: 'primitive', shape: 'box', size: [1, 0.2, 4] };

function scene(entities: JsonValue[]): SceneDocument {
  return parseScene({ schemaVersion: 1, id: 's', name: 'S', entities }).value as SceneDocument;
}

function batchesUnder(root: THREE.Object3D): THREE.InstancedMesh[] {
  return root.children.filter((child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh);
}

describe('primitive instancing', () => {
  it('folds identical static primitives into one instanced draw at their world transforms', () => {
    const graph = buildSceneGraph(
      scene([
        { id: 'a', name: 'Rail A', transform: { position: [0, 0, 0] }, components: [box] },
        { id: 'b', name: 'Rail B', transform: { position: [5, 0, 0] }, components: [box] },
        { id: 'c', name: 'Rail C', parentId: 'b', transform: { position: [0, 1, 0] }, components: [box] },
      ]),
    );
    expect(graph.instancedPrimitives).toBe(3);
    const [batch] = batchesUnder(graph.root);
    expect(batch?.count).toBe(3);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const positions = [0, 1, 2].map((index) => {
      batch!.getMatrixAt(index, matrix);
      return position.setFromMatrixPosition(matrix).toArray();
    });
    expect(positions).toContainEqual([5, 1, 0]);
    // Each entity keeps its own mesh on the unrendered layer, so nothing about the entity changed.
    const own = graph.entities.get('c')?.mesh;
    expect(own?.layers.mask).toBe(2 ** BATCHED_LAYER);
    expect(own?.parent).toBe(graph.entities.get('c')?.object);
  });

  it('leaves a lone shape, a moving body, and a behavior-driven subtree on their own meshes', () => {
    const doc = scene([
      { id: 'a', name: 'A', components: [box] },
      { id: 'b', name: 'B', components: [box, { type: 'rigidBody', bodyType: 'dynamic' }] },
      { id: 'p', name: 'P', components: [{ type: 'behavior', behaviorId: 'spin', properties: {} }] },
      { id: 'c', name: 'C', parentId: 'p', components: [box] },
      { id: 'd', name: 'D', components: [{ type: 'primitive', shape: 'sphere', size: [1, 1, 1] }] },
    ]);
    const byId = new Map(doc.entities.map((entity) => [entity.id, entity]));
    const lookup = (id: string) => byId.get(id);
    expect(isStaticInGame(byId.get('a')!, lookup)).toBe(true);
    expect(isStaticInGame(byId.get('b')!, lookup)).toBe(false);
    expect(isStaticInGame(byId.get('c')!, lookup)).toBe(false);
    expect(primitiveBatchKey(byId.get('a')!)).toBe(primitiveBatchKey(byId.get('b')!));
    expect(primitiveBatchKey(byId.get('a')!)).not.toBe(primitiveBatchKey(byId.get('d')!));

    const graph = buildSceneGraph(doc);
    expect(graph.instancedPrimitives).toBe(0);
    expect(batchesUnder(graph.root)).toHaveLength(0);
    for (const id of ['a', 'b', 'c', 'd']) expect(graph.entities.get(id)?.mesh?.layers.mask).toBe(1);
  });

  it('can be switched off by the caller', () => {
    const graph = buildSceneGraph(
      scene([
        { id: 'a', name: 'A', components: [box] },
        { id: 'b', name: 'B', components: [box] },
      ]),
      { instancing: false },
    );
    expect(graph.instancedPrimitives).toBe(0);
    expect(batchesUnder(graph.root)).toHaveLength(0);
  });
});
