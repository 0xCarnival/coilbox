import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { activeCameraEntityId, buildSceneGraph } from '@runtime/scene-graph.js';
import { parseScene, type SceneDocument } from '@schema/index.js';

/**
 * The active camera, as the runtime resolves it and as the editor asks for it.
 *
 * `buildSceneGraph` and `activeCameraEntityId` implement the same rule in two places: the builder
 * resolves a camera for a world it is constructing, and the editor needs the same answer without
 * building one, to show the view the game would actually start from.
 *
 * Two copies of a rule are two rules unless something pins them together, so these tests run both
 * against the same documents and compare. The cases are the ones where a plausible implementation
 * disagrees with the real one: a disabled active camera, a camera disabled through its parent, and an
 * editor helper that happens to carry a camera component.
 */

/** A scene with three cameras, so "which one" is a real question rather than the only option. */
function sceneWithCameras(): SceneDocument {
  const parsed = parseScene({
    schemaVersion: 1,
    id: 'camera-resolution',
    name: 'Camera resolution',
    entities: [
      { id: 'aaa-first', name: 'First', order: 0, components: [{ type: 'camera' }] },
      { id: 'mmm-second', name: 'Second', order: 1, components: [{ type: 'camera' }] },
      { id: 'zzz-third', name: 'Third', order: 2, components: [{ type: 'camera' }] },
    ],
  });
  if (!parsed.value) throw new Error(`fixture did not parse: ${JSON.stringify(parsed.issues)}`);
  return parsed.value as SceneDocument;
}

/**
 * The camera the *runtime* would use, read off the world it built.
 *
 * Identified by the object it is attached to rather than by object identity, because the builder
 * creates a fresh `PerspectiveCamera` per entity and the entity is what both sides are choosing.
 */
function runtimeCameraEntityId(scene: SceneDocument, includeHelpers = false): string | null {
  const graph = buildSceneGraph(scene, { includeHelpers });
  const camera = graph.camera;
  if (!camera) return null;
  for (const [id, built] of graph.entities) {
    if (built.camera === camera) return id;
  }
  return null;
}

describe('active camera resolution', () => {
  it('agrees with the runtime when activeCameraId names an enabled camera', () => {
    const scene = sceneWithCameras();
    scene.activeCameraId = 'mmm-second';
    expect(activeCameraEntityId(scene)).toBe('mmm-second');
    expect(runtimeCameraEntityId(scene)).toBe('mmm-second');
  });

  it('falls back to the first camera for a disabled active camera, and both agree on which', () => {
    const scene = sceneWithCameras();
    scene.activeCameraId = 'mmm-second';
    const disabled = scene.entities.find((entity) => entity.id === 'mmm-second');
    if (disabled) disabled.enabled = false;

    const chosen = activeCameraEntityId(scene);
    expect(chosen).toBe('aaa-first');
    expect(runtimeCameraEntityId(scene)).toBe(chosen);
  });

  it('skips a camera disabled through its parent, as the runtime does', () => {
    const parent = parseScene({
      schemaVersion: 1,
      id: 'camera-resolution',
      name: 'Camera resolution',
      entities: [
        { id: 'group', name: 'Group', enabled: false, order: 0, components: [] },
        { id: 'child-cam', name: 'Child', parentId: 'group', order: 1, components: [{ type: 'camera' }] },
        { id: 'free-cam', name: 'Free', order: 2, components: [{ type: 'camera' }] },
      ],
    });
    if (!parent.value) throw new Error('fixture did not parse');
    const withParent = parent.value as SceneDocument;

    const chosen = activeCameraEntityId(withParent);
    expect(chosen).toBe('free-cam');
    expect(runtimeCameraEntityId(withParent)).toBe(chosen);
  });

  it('uses document order rather than array order', () => {
    const scene = sceneWithCameras();
    /** Deliberately shuffled: the runtime sorts by `order`, so raw array order would pick the wrong one. */
    scene.entities.reverse();
    expect(activeCameraEntityId(scene)).toBe('aaa-first');
    expect(runtimeCameraEntityId(scene)).toBe('aaa-first');
  });

  it('excludes an editor helper, unless helpers are being built', () => {
    const scene = sceneWithCameras();
    const helper = scene.entities.find((entity) => entity.id === 'aaa-first');
    if (helper) helper.editor.helper = true;

    expect(activeCameraEntityId(scene)).toBe('mmm-second');
    expect(runtimeCameraEntityId(scene)).toBe('mmm-second');
    /** With helpers included the runtime builds it, so the editor can be asked for the same answer. */
    expect(activeCameraEntityId(scene, true)).toBe('aaa-first');
    expect(runtimeCameraEntityId(scene, true)).toBe('aaa-first');
  });

  it('reports no camera for a scene without one, the same way the runtime does', () => {
    const parsed = parseScene({
      schemaVersion: 1,
      id: 'no-camera',
      name: 'No camera',
      entities: [
        {
          id: 'box',
          name: 'Box',
          order: 0,
          components: [{ type: 'primitive', shape: 'box', size: [1, 1, 1], castShadow: true, receiveShadow: true }],
        },
      ],
    });
    if (!parsed.value) throw new Error('fixture did not parse');
    const scene = parsed.value as SceneDocument;
    expect(activeCameraEntityId(scene)).toBeNull();
    expect(runtimeCameraEntityId(scene)).toBeNull();
  });

  it('never returns an entity that is not a camera', () => {
    const scene = sceneWithCameras();
    scene.activeCameraId = 'zzz-third';
    const notACamera = scene.entities.find((entity) => entity.id === 'zzz-third');
    if (notACamera) notACamera.components = [{ type: 'primitive', shape: 'box', size: [1, 1, 1], castShadow: true, receiveShadow: true }];

    expect(activeCameraEntityId(scene)).toBe('aaa-first');
    expect(runtimeCameraEntityId(scene)).toBe('aaa-first');
  });

  it('agrees with the runtime about the bundled demo projects', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../..', import.meta.url));
    let checked = 0;

    for (const project of ['neon-yomi', 'physics-targets']) {
      const path = join(root, 'games', project, 'scenes', 'main.scene.json');
      const scene = parseScene(JSON.parse(await readFile(path, 'utf8'))).value as SceneDocument;
      expect(scene, `${project} did not parse`).toBeTruthy();
      /**
       * The shipped games are the ones that matter: this is the scene a user presses 0 in, and a
       * disagreement here is a preview of a camera the game would not start from.
       */
      expect(activeCameraEntityId(scene), project).toBe(runtimeCameraEntityId(scene));
      checked += 1;
    }

    expect(checked).toBe(2);
  });

  it('finds the camera the editor previews on a bundled project', () => {
    /** A guard against the resolver quietly returning null everywhere and the tests passing vacuously. */
    const scene = parseScene({
      schemaVersion: 1,
      id: 'sanity',
      name: 'Sanity',
      entities: [{ id: 'cam', name: 'Cam', order: 0, components: [{ type: 'camera' }] }],
    }).value as SceneDocument;
    const id = activeCameraEntityId(scene);
    expect(id).toBe('cam');
    const built = buildSceneGraph(scene);
    expect(built.camera).toBeInstanceOf(THREE.PerspectiveCamera);
  });
});
