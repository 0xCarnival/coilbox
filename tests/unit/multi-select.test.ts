import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createStarterScene, createEntity } from '@editor/document/factory.js';
import { duplicateEntities } from '@editor/document/duplicate.js';
import { SelectionStore } from '@editor/document/selection.js';
import { applyPivotDelta, pointsInRect, selectionRoots } from '@editor/viewport/group-transform.js';
import { cameraFollow } from '@runtime/behaviors/library.js';

describe('multi-selection', () => {
  it('selectMany unions additively, replaces non-additively, and skips no-ops', () => {
    const store = new SelectionStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.selectMany(['a', 'b', 'b']);
    store.selectMany(['b', 'c', 'c'], { additive: true });
    expect(store.selectedIds).toEqual(['a', 'b', 'c']);
    store.selectMany(['a', 'b', 'c'], { additive: true });
    expect(listener).toHaveBeenCalledTimes(2);
    store.selectMany(['c', 'a']);
    expect(store.selectedIds).toEqual(['c', 'a']);
  });

  it('collapses nested selections to their selected ancestor', () => {
    expect(selectionRoots(['child', 'root', 'grandchild'], (id) => ({ root: null, child: 'root', grandchild: 'child' }[id] ?? null))).toEqual(['root']);
  });

  it('applies translation and rotation pivot deltas without mutating starts', () => {
    const start = new Map([
      ['a', new THREE.Matrix4().makeTranslation(1, 0, 0)],
      ['b', new THREE.Matrix4().makeTranslation(-1, 0, 0)],
    ]);
    const pivotStart = new THREE.Matrix4();
    const translated = applyPivotDelta(pivotStart, new THREE.Matrix4().makeTranslation(2, 0, 0), start);
    expect(new THREE.Vector3().setFromMatrixPosition(translated.get('a')!)).toEqual(expect.objectContaining({ x: 3, y: 0 }));
    const result = applyPivotDelta(pivotStart, new THREE.Matrix4().makeRotationZ(Math.PI / 2), start);
    const rotated = new THREE.Vector3().setFromMatrixPosition(result.get('a')!);
    expect(rotated.x).toBeCloseTo(0);
    expect(rotated.y).toBeCloseTo(1);
    expect(new THREE.Vector3().setFromMatrixPosition(start.get('a')!)).toEqual(expect.objectContaining({ x: 1, y: 0 }));
  });

  it('keeps a child world matrix consistent when its parent is not selected', () => {
    const parent = new THREE.Matrix4().makeTranslation(4, 0, 0);
    const child = new THREE.Matrix4().makeTranslation(5, 0, 0);
    const moved = applyPivotDelta(new THREE.Matrix4(), new THREE.Matrix4().makeTranslation(2, 0, 0), new Map([['child', child]])).get('child')!;
    const local = parent.clone().invert().multiply(moved);
    expect(new THREE.Vector3().setFromMatrixPosition(parent.clone().multiply(local))).toEqual(expect.objectContaining({ x: 7, y: 0 }));
  });

  it('finds projected points on rectangle boundaries', () => {
    const points = new Map([['a', { x: 0, y: 0 }], ['b', { x: 10, y: 10 }], ['c', { x: 11, y: 5 }]]);
    expect(pointsInRect(points, { x: 0, y: 0, width: 10, height: 10 })).toEqual(['a', 'b']);
  });

  it('duplicates selected roots and remaps copied subtree parents', () => {
    const scene = createStarterScene('multi', 'Multi');
    const root = createEntity('group', { id: 'root', name: 'Root' });
    const child = createEntity('box', { id: 'child', name: 'Child', parentId: 'root' });
    scene.entities.push(root, child);
    const result = duplicateEntities(scene, ['root', 'child']);
    expect(result.entities).toHaveLength(2);
    const copiedRoot = result.entities.find((entity) => entity.parentId === null && entity.name === 'Root copy');
    expect(copiedRoot).toBeDefined();
    expect(result.selectIds).toEqual([copiedRoot?.id]);
    expect(result.entities.find((entity) => entity.name === 'Child')?.parentId).toBe(copiedRoot?.id);
  });

  it('remaps camera targets inside a duplicated subtree but preserves outside targets', () => {
    const scene = createStarterScene('camera-copy', 'Camera Copy');
    const root = createEntity('group', { id: 'root', name: 'Root' });
    const target = createEntity('box', { id: 'target', name: 'Target', parentId: 'root' });
    const outside = createEntity('box', { id: 'outside', name: 'Outside' });
    const camera = createEntity('camera', { id: 'camera', name: 'Camera', parentId: 'root' });
    camera.components = camera.components.map((component) =>
      component.type === 'camera' ? { ...component, targetId: 'target' } : component,
    );
    scene.entities.push(root, target, camera, outside);
    const insideCopy = duplicateEntities(scene, ['root']);
    const copiedCamera = insideCopy.entities.find((entity) => entity.name === 'Camera');
    const copiedTarget = insideCopy.entities.find((entity) => entity.name === 'Target');
    expect(copiedCamera?.components.find((component) => component.type === 'camera')).toMatchObject({ targetId: copiedTarget?.id });

    const outsideCamera = { ...camera, components: camera.components.map((component) =>
      component.type === 'camera' ? { ...component, targetId: 'outside' } : component,
    ) };
    const outsideScene = { ...scene, entities: [...scene.entities.filter((entity) => entity.id !== 'camera'), outsideCamera] };
    const outsideCopy = duplicateEntities(outsideScene, ['root']);
    expect(outsideCopy.entities.find((entity) => entity.name === 'Camera')?.components.find((component) => component.type === 'camera')).toMatchObject({ targetId: 'outside' });
  });

  it('remaps behavior entity properties using declared metadata', () => {
    const scene = createStarterScene('behavior-copy', 'Behavior Copy');
    const root = createEntity('group', { id: 'root', name: 'Root' });
    const target = createEntity('box', { id: 'target', name: 'Target', parentId: 'root' });
    const camera = createEntity('group', { id: 'camera', name: 'Camera', parentId: 'root' });
    camera.components.push({ type: 'behavior', behaviorId: 'camera.follow', properties: { target: 'target' } });
    scene.entities.push(root, target, camera);
    const result = duplicateEntities(
      scene,
      ['root'],
      (behaviorId) =>
        behaviorId === cameraFollow.id
          ? cameraFollow.properties.filter((property) => property.type === 'entity').map((property) => property.key)
          : [],
    );
    const copiedCamera = result.entities.find((entity) => entity.name === 'Camera');
    expect(copiedCamera?.components.find((component) => component.type === 'behavior')).toMatchObject({ properties: { target: result.entities.find((entity) => entity.name === 'Target')?.id } });
  });
});
