import { describe, expect, it } from 'vitest';
import { parseScene, type SceneDocument } from '@schema/index.js';
import { createEntityId, planCommand, subtreeOf } from '@editor/document/commands.js';
import { CommandHistory } from '@editor/document/history.js';
import { SceneDocumentStore } from '@editor/document/store.js';
import { createEntity, createStarterScene, reparentPreservingWorldTransform, worldMatrix } from '@editor/document/factory.js';
import { probeGame, probeScene } from '@runtime/probe/scene.js';

/**
 * Editing core: commands, history, and the document store (plan §8).
 *
 * These tests are the contract the hierarchy, the inspector, keyboard shortcuts, and
 * agent-proposed changes all share: one command interface, validated before it commits,
 * one undo entry per meaningful action.
 */

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freshScene(): SceneDocument {
  return clone(probeScene);
}

function store(): SceneDocumentStore {
  return new SceneDocumentStore(probeGame, freshScene());
}

describe('commands', () => {
  it('plans a transform change with an inverse that restores the previous value', () => {
    const scene = freshScene();
    const result = planCommand(scene, {
      kind: 'setTransform',
      entityId: 'falling-box',
      transform: { position: [3, 2, 1] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next.entities.find((e) => e.id === 'falling-box')?.transform.position).toEqual([3, 2, 1]);
    // The input document is untouched.
    expect(scene.entities.find((e) => e.id === 'falling-box')?.transform.position).toEqual([0, 4, 0]);

    const undone = planCommand(result.next, result.inverse);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.next.entities.find((e) => e.id === 'falling-box')?.transform.position).toEqual([0, 4, 0]);
  });

  it('rejects non-finite, zero-scale, and unnormalised transforms', () => {
    const scene = freshScene();
    expect(planCommand(scene, { kind: 'setTransform', entityId: 'falling-box', transform: { position: [Number.NaN, 0, 0] } }).ok).toBe(false);
    expect(planCommand(scene, { kind: 'setTransform', entityId: 'falling-box', transform: { scale: [1, 0, 1] } }).ok).toBe(false);
    expect(
      planCommand(scene, { kind: 'setTransform', entityId: 'falling-box', transform: { rotation: [0, 0, 0, 0.5] } }).ok,
    ).toBe(false);
  });

  it('deletes a subtree and restores it, including the active camera reference', () => {
    const scene = freshScene();
    const removed = subtreeOf(scene, 'ground');
    expect(removed).toHaveLength(1);

    const deleted = planCommand(scene, { kind: 'deleteEntities', entityIds: ['probe-camera'] });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.next.entities.find((e) => e.id === 'probe-camera')).toBeUndefined();
    expect(deleted.next.activeCameraId).toBeNull();

    const restored = planCommand(deleted.next, deleted.inverse);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.next.entities.map((e) => e.id).sort()).toEqual(scene.entities.map((e) => e.id).sort());
  });

  it('keeps descendant entities when their parent is deleted, and restores the subtree on undo', () => {
    const scene = freshScene();
    const withChild = planCommand(scene, {
      kind: 'insertEntities',
      entities: [createEntity('group', { id: 'rig', name: 'Rig' }), createEntity('box', { id: 'arm', name: 'Arm', parentId: 'rig' })],
    });
    expect(withChild.ok).toBe(true);
    if (!withChild.ok) return;

    const deleted = planCommand(withChild.next, { kind: 'deleteEntities', entityIds: ['rig'] });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.next.entities.map((e) => e.id)).not.toContain('arm');
    expect(deleted.affected.sort()).toEqual(['arm', 'rig']);

    const restored = planCommand(deleted.next, deleted.inverse);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.next.entities.find((e) => e.id === 'arm')?.parentId).toBe('rig');
  });

  it('renames, enables, and edits component properties through the same interface', () => {
    const scene = freshScene();
    const renamed = planCommand(scene, { kind: 'renameEntity', entityId: 'falling-box', name: 'Crate' });
    expect(renamed.ok && renamed.next.entities[1]?.name).toBe('Crate');
    expect(planCommand(scene, { kind: 'renameEntity', entityId: 'falling-box', name: '  ' }).ok).toBe(false);

    const disabled = planCommand(scene, { kind: 'setEntityEnabled', entityId: 'falling-box', enabled: false });
    expect(disabled.ok && disabled.next.entities[1]?.enabled).toBe(false);

    const property = planCommand(scene, {
      kind: 'setComponentProperty',
      entityId: 'falling-box',
      componentType: 'material',
      property: 'color',
      value: '#ff0000',
    });
    expect(property.ok).toBe(true);
    if (!property.ok) return;
    const material = property.next.entities.find((e) => e.id === 'falling-box')?.components.find((c) => c.type === 'material');
    expect(material && 'color' in material ? material.color : null).toBe('#ff0000');

    expect(
      planCommand(scene, { kind: 'setComponentProperty', entityId: 'falling-box', componentType: 'material', property: 'nope', value: 1 }).ok,
    ).toBe(false);
    expect(
      planCommand(scene, { kind: 'setComponentProperty', entityId: 'falling-box', componentType: 'camera', property: 'fov', value: 60 }).ok,
    ).toBe(false);
  });

  it('refuses to reparent an entity under its own descendant', () => {
    const scene = freshScene();
    const nested = planCommand(scene, {
      kind: 'insertEntities',
      entities: [createEntity('group', { id: 'a', name: 'A' }), createEntity('group', { id: 'b', name: 'B', parentId: 'a' })],
    });
    expect(nested.ok).toBe(true);
    if (!nested.ok) return;
    const cycle = planCommand(nested.next, { kind: 'reparentEntity', entityId: 'a', parentId: 'b' });
    expect(cycle.ok).toBe(false);
    if (cycle.ok) return;
    expect(cycle.issues[0]?.code).toBe('parent-cycle');
  });

  it('rejects physics bodies that are not scene roots', () => {
    const scene = freshScene();
    const nested = planCommand(scene, {
      kind: 'insertEntities',
      entities: [
        createEntity('group', { id: 'parent', name: 'Parent' }),
        { ...createEntity('box', { id: 'child-body', name: 'Body', parentId: 'parent' }), components: [...createEntity('box', { id: 'x' }).components, { type: 'rigidBody', bodyType: 'dynamic', mass: null, gravityScale: 1, linearDamping: 0, angularDamping: 0.05, lockRotation: false, continuous: false, moveWithPhysics: true } as const] },
      ],
    });
    expect(nested.ok).toBe(false);
    if (nested.ok) return;
    expect(nested.issues.some((issue) => issue.code === 'physics-body-root' || issue.code === 'physics-body-not-root')).toBe(true);
  });

  it('generates unique, readable entity ids', () => {
    const used = new Set(['box', 'box-2']);
    expect(createEntityId('box', used)).toBe('box-3');
    expect(createEntityId('Falling Box', used)).toBe('falling-box');
    expect(createEntityId('  ', used)).toBe('entity');
  });
});

describe('history', () => {
  it('undoes and redoes through the store', () => {
    const documentStore = store();
    const before = documentStore.scene;
    expect(documentStore.execute({ kind: 'setTransform', entityId: 'falling-box', transform: { position: [1, 2, 3] } }).ok).toBe(true);
    expect(documentStore.isDirty).toBe(true);
    expect(documentStore.canUndo).toBe(true);
    expect(documentStore.undoLabel()).toBe('Transform Falling Box');

    documentStore.undo();
    expect(documentStore.scene.entities.find((e) => e.id === 'falling-box')?.transform.position).toEqual([0, 4, 0]);
    expect(documentStore.scene.entities).toHaveLength(before.entities.length);

    documentStore.redo();
    expect(documentStore.scene.entities.find((e) => e.id === 'falling-box')?.transform.position).toEqual([1, 2, 3]);
    expect(documentStore.canRedo).toBe(false);
  });

  it('jumps to any position in the history with one notification', () => {
    const documentStore = store();
    const changes: Array<ReturnType<typeof documentStore.snapshot>> = [];
    documentStore.subscribe((snapshot) => changes.push(snapshot));
    for (const x of [1, 2, 3]) {
      documentStore.execute({ kind: 'setTransform', entityId: 'falling-box', transform: { position: [x, 4, 0] } }, { coalesceKey: `step-${x}` });
    }
    const position = () => documentStore.scene.entities.find((e) => e.id === 'falling-box')?.transform.position;
    expect(documentStore.snapshot().historyEntries.map((entry) => entry.label)).toEqual(['Transform Falling Box', 'Transform Falling Box', 'Transform Falling Box']);
    expect(documentStore.snapshot().historyPosition).toBe(3);

    changes.length = 0;
    expect(documentStore.jumpTo(1)).toBe(true);
    expect(position()).toEqual([1, 4, 0]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.historyPosition).toBe(1);
    expect(documentStore.canRedo).toBe(true);

    expect(documentStore.jumpTo(3)).toBe(true);
    expect(position()).toEqual([3, 4, 0]);
    expect(documentStore.jumpTo(3)).toBe(false);

    expect(documentStore.jumpTo(0)).toBe(true);
    expect(position()).toEqual([0, 4, 0]);
    // A jump past the ends clamps rather than throwing.
    expect(documentStore.jumpTo(99)).toBe(true);
    expect(position()).toEqual([3, 4, 0]);
  });

  it('coalesces consecutive edits that share a coalesce key into one entry', () => {
    const documentStore = store();
    for (const x of [1, 2, 3, 4]) {
      documentStore.execute({ kind: 'setTransform', entityId: 'falling-box', transform: { position: [x, 4, 0] } }, { coalesceKey: 'inspector:falling-box:position' });
    }
    expect(documentStore.currentHistory.size).toBe(1);
    documentStore.undo();
    expect(documentStore.scene.entities.find((e) => e.id === 'falling-box')?.transform.position).toEqual([0, 4, 0]);
  });

  it('groups a transaction into a single undo step', () => {
    const documentStore = store();
    const result = documentStore.transaction('Move crate', [
      { kind: 'setTransform', entityId: 'falling-box', transform: { position: [2, 1, 0] } },
      { kind: 'renameEntity', entityId: 'falling-box', name: 'Crate' },
    ]);
    expect(result.ok).toBe(true);
    expect(documentStore.currentHistory.size).toBe(1);
    documentStore.undo();
    const entity = documentStore.scene.entities.find((e) => e.id === 'falling-box');
    expect(entity?.name).toBe('Falling Box');
    expect(entity?.transform.position).toEqual([0, 4, 0]);
  });

  it('redos every command in a transaction', () => {
    const documentStore = store();
    expect(documentStore.transaction('Move two objects', [
      { kind: 'setTransform', entityId: 'falling-box', transform: { position: [2, 1, 0] } },
      { kind: 'setTransform', entityId: 'ground', transform: { position: [0, -1, 0] } },
    ]).ok).toBe(true);
    documentStore.undo();
    documentStore.redo();
    expect(documentStore.scene.entities.find((entity) => entity.id === 'falling-box')?.transform.position).toEqual([2, 1, 0]);
    expect(documentStore.scene.entities.find((entity) => entity.id === 'ground')?.transform.position).toEqual([0, -1, 0]);
  });

  it('coalesces transactions with the same key into one history entry', () => {
    const documentStore = store();
    const initialGround = documentStore.scene.entities.find((entity) => entity.id === 'ground')?.transform.position;
    expect(documentStore.transaction('Move two objects', [
      { kind: 'setTransform', entityId: 'falling-box', transform: { position: [1, 1, 0] } },
      { kind: 'setTransform', entityId: 'ground', transform: { position: [0, -1, 0] } },
    ], { coalesceKey: 'transform:falling-box,ground' }).ok).toBe(true);
    expect(documentStore.transaction('Move two objects', [
      { kind: 'setTransform', entityId: 'falling-box', transform: { position: [2, 2, 0] } },
      { kind: 'setTransform', entityId: 'ground', transform: { position: [0, -2, 0] } },
    ], { coalesceKey: 'transform:falling-box,ground' }).ok).toBe(true);
    expect(documentStore.currentHistory.size).toBe(1);
    documentStore.undo();
    expect(documentStore.scene.entities.find((entity) => entity.id === 'falling-box')?.transform.position).toEqual([0, 4, 0]);
    expect(documentStore.scene.entities.find((entity) => entity.id === 'ground')?.transform.position).toEqual(initialGround);
  });

  it('rolls a transaction back entirely when one command fails', () => {
    const documentStore = store();
    const result = documentStore.transaction('Bad move', [
      { kind: 'setTransform', entityId: 'falling-box', transform: { position: [2, 1, 0] } },
      { kind: 'renameEntity', entityId: 'missing', name: 'Nope' },
    ]);
    expect(result.ok).toBe(false);
    expect(documentStore.scene.entities.find((e) => e.id === 'falling-box')?.transform.position).toEqual([0, 4, 0]);
    expect(documentStore.currentHistory.size).toBe(0);
  });

  it('drops the redo branch when a new edit follows an undo', () => {
    const documentStore = store();
    documentStore.execute({ kind: 'setTransform', entityId: 'falling-box', transform: { position: [1, 4, 0] } }, { coalesceKey: 'a' });
    documentStore.currentHistory.breakCoalescing();
    documentStore.execute({ kind: 'setTransform', entityId: 'falling-box', transform: { position: [2, 4, 0] } }, { coalesceKey: 'b' });
    documentStore.undo();
    expect(documentStore.canRedo).toBe(true);
    documentStore.execute({ kind: 'setTransform', entityId: 'falling-box', transform: { position: [9, 4, 0] } }, { coalesceKey: 'c' });
    expect(documentStore.canRedo).toBe(false);
  });

  it('reports the redo label and clears history on reset', () => {
    const documentStore = store();
    documentStore.execute({ kind: 'renameEntity', entityId: 'falling-box', name: 'Crate' });
    documentStore.undo();
    expect(documentStore.redoLabel()).toBe('Rename Falling Box to Crate');
    documentStore.reset(probeGame, freshScene());
    expect(documentStore.canUndo).toBe(false);
    expect(documentStore.isDirty).toBe(false);
  });

  it('marks dirty on edit and clean only when the workspace acknowledges the write', () => {
    const states: string[] = [];
    const causes: string[] = [];
    const documentStore = new SceneDocumentStore(probeGame, freshScene(), {
      onChange: (snapshot, cause) => {
        states.push(snapshot.saveState);
        causes.push(cause);
      },
    });
    documentStore.subscribe((snapshot) => states.push(snapshot.saveState));
    documentStore.execute({ kind: 'setSceneName', name: 'Renamed' });
    expect(documentStore.isDirty).toBe(true);
    documentStore.markSaving();
    expect(documentStore.currentSaveState).toBe('saving');
    documentStore.markSaved(7);
    expect(documentStore.currentSaveState).toBe('clean');
    expect(documentStore.scene.revision).toBe(7);
    expect(documentStore.isDirty).toBe(false);
    expect(causes).toEqual(['execute', 'saved', 'saved']);
    expect(states).toContain('dirty');
    expect(states).toContain('clean');
  });

  it('keeps one store per project independent', () => {
    const a = store();
    const b = new SceneDocumentStore({ ...probeGame, id: 'other' }, freshScene());
    a.execute({ kind: 'renameEntity', entityId: 'falling-box', name: 'Only in A' });
    expect(b.scene.entities.find((e) => e.id === 'falling-box')?.name).toBe('Falling Box');
    expect(b.canUndo).toBe(false);
  });
});

describe('reparenting', () => {
  it('preserves the world transform of the moved entity', () => {
    const scene = freshScene();
    const withParent = planCommand(scene, {
      kind: 'insertEntities',
      entities: [createEntity('group', { id: 'rig', name: 'Rig', position: [5, 0, 0] })],
    });
    expect(withParent.ok).toBe(true);
    if (!withParent.ok) return;
    const nested = planCommand(withParent.next, { kind: 'reparentEntity', entityId: 'falling-box', parentId: 'rig' });
    expect(nested.ok).toBe(false); // physics body must stay a root

    const before = worldMatrix(withParent.next, 'key-light').elements.slice();
    const commands = reparentPreservingWorldTransform(withParent.next, 'key-light', 'rig');
    expect(commands).toHaveLength(2);

    const moved = planCommand(withParent.next, commands[0]!);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const settled = planCommand(moved.next, commands[1]!);
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;

    const after = worldMatrix(settled.next, 'key-light').elements;
    for (let index = 0; index < 16; index += 1) {
      expect(after[index]).toBeCloseTo(before[index]!, 5);
    }
    expect(settled.next.entities.find((e) => e.id === 'key-light')?.parentId).toBe('rig');
  });

  it('refuses a move that would need shear because of a non-uniform parent scale', () => {
    const scene = freshScene();
    const withScaledParent = planCommand(scene, {
      kind: 'insertEntities',
      entities: [
        { ...createEntity('group', { id: 'squashed', name: 'Squashed' }), transform: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [2, 1, 1] as [number, number, number] } },
        { ...createEntity('box', { id: 'child', name: 'Child', position: [0, 1, 0] }), transform: { position: [1, 1, 0] as [number, number, number], rotation: [0, 0, 0.3826834, 0.9238795] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] } },
      ],
    });
    expect(withScaledParent.ok).toBe(true);
    if (!withScaledParent.ok) return;
    const commands = reparentPreservingWorldTransform(withScaledParent.next, 'child', 'squashed');
    expect(commands).toEqual([]);
  });
});

describe('starter scene', () => {
  it('produces a valid scene that the loader accepts', () => {
    const scene = createStarterScene('main', 'Main');
    const parsed = parseScene(scene);
    expect(parsed.ok, parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n')).toBe(true);
    expect(parsed.value?.activeCameraId).toBe('game-camera');
    expect(parsed.value?.entities.map((entity) => entity.id)).toEqual(['ground', 'player', 'game-camera', 'sun']);
  });
});

describe('history internals', () => {
  it('limits the number of retained entries', () => {
    const history = new CommandHistory({ limit: 3 });
    for (let index = 0; index < 6; index += 1) {
      history.push({ kind: 'setSceneName', name: `Scene ${index}` }, [{ kind: 'setSceneName', name: 'Previous' }], {
        coalesceKey: `k${index}`,
      });
    }
    expect(history.size).toBe(3);
    expect(history.canUndo()).toBe(true);
  });
});
