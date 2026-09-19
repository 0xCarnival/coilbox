import { describe, expect, it } from 'vitest';
import {
  ENGINE_VERSION,
  SCENE_SCHEMA_VERSION,
  formatIssues,
  parseAssetManifest,
  parseGame,
  parseScene,
  validateSceneRelationships,
  type JsonValue,
  type SceneDocument,
  assetReferencesOf,
} from '@schema/index.js';
import { probeScene } from '@runtime/probe/scene.js';

/**
 * Schema and relationship validation (plan §7).
 *
 * Zod covers structure; the checks below cover the relationships a schema cannot express:
 * unique ids, existing parents, no cycles, valid camera references, asset references,
 * behavior properties, and schema-version compatibility.
 */

/**
 * Build a scene-shaped JSON object. The return type is deliberately inferred rather than annotated:
 * these helpers exist to construct input the schema must *reject*, so they cannot claim to be a
 * `SceneDocument`.
 */
function sceneWith(entities: JsonValue[], extra: Record<string, JsonValue> = {}) {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    id: 'test',
    name: 'Test scene',
    entities,
    ...extra,
  };
}

const minimalEntity = (id: string, rest: Record<string, JsonValue> = {}) => ({
  id,
  name: id,
  ...rest,
});

describe('scene schema', () => {
  it('enumerates model, audio, and material asset references', () => {
    expect(assetReferencesOf({ type: 'model', assetId: 'crate', castShadow: true, receiveShadow: true })).toEqual([
      { property: 'assetId', assetId: 'crate', kind: 'model' },
    ]);
    expect(assetReferencesOf({ type: 'audio', assetId: 'click', volume: 1, loop: false, autoplay: false, spatial: true })).toEqual([
      { property: 'assetId', assetId: 'click', kind: 'audio' },
    ]);
    expect(
      assetReferencesOf({
        type: 'material',
        map: 'albedo',
        normalMap: 'normal',
        emissiveMap: null,
        textureRepeat: [1, 1],
        textureOffset: [0, 0],
        color: '#ffffff',
        roughness: 0.5,
        metalness: 0,
        emissive: '#000000',
        emissiveIntensity: 1,
        opacity: 1,
        transparent: false,
        doubleSided: false,
        flatShading: false,
        visible: true,
      }),
    ).toEqual([
      { property: 'map', assetId: 'albedo', kind: 'image' },
      { property: 'normalMap', assetId: 'normal', kind: 'image' },
    ]);
  });

  it('accepts the stage 0 probe scene and applies documented defaults', () => {
    const result = parseScene(probeScene);
    expect(result.ok, formatIssues(result.issues)).toBe(true);
    const scene = result.value as SceneDocument;
    expect(scene.entities).toHaveLength(5);
    const ground = scene.entities.find((entity) => entity.id === 'ground');
    expect(ground?.transform.scale).toEqual([1, 1, 1]);
    expect(ground?.enabled).toBe(true);
    expect(ground?.editor.visible).toBe(true);
    expect(ground?.editor.helper).toBe(false);
  });

  it('rejects non-finite transforms', () => {
    const result = parseScene(
      sceneWith([minimalEntity('a', { transform: { position: [Number.NaN, 0, 0] } })]),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.path.includes('position'))).toBe(true);
  });

  it('keeps editor visibility separate from gameplay enabled state', () => {
    const result = parseScene(
      sceneWith([minimalEntity('helper', { enabled: true, editor: { visible: false, helper: true } })]),
    );
    expect(result.ok).toBe(true);
    expect(result.value?.entities[0]?.enabled).toBe(true);
    expect(result.value?.entities[0]?.editor.visible).toBe(false);
    expect(result.value?.entities[0]?.editor.helper).toBe(true);
  });

  it('reports duplicate entity ids, missing parents, and parent cycles', () => {
    const issues = validateSceneRelationships(
      parseScene(
        sceneWith([
          minimalEntity('dup'),
          minimalEntity('dup'),
          minimalEntity('orphan', { parentId: 'nope' }),
          minimalEntity('a', { parentId: 'b' }),
          minimalEntity('b', { parentId: 'a' }),
        ]),
      ).value as SceneDocument,
    );
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain('duplicate-entity-id');
    expect(codes).toContain('missing-parent');
    expect(codes).toContain('parent-cycle');
  });

  it('rejects an active camera that does not exist or has no camera component', () => {
    const missing = parseScene(sceneWith([minimalEntity('a')], { activeCameraId: 'ghost' }));
    expect(missing.issues.map((issue) => issue.code)).toContain('missing-active-camera');

    const notACamera = parseScene(sceneWith([minimalEntity('a')], { activeCameraId: 'a' }));
    expect(notACamera.issues.map((issue) => issue.code)).toContain('active-camera-not-camera');
  });

  it('reports asset references that are missing from the manifest', () => {
    const result = parseScene(
      sceneWith([minimalEntity('crate', { components: [{ type: 'model', assetId: 'crate.glb' }] })]),
      { assetIds: new Set(['other.glb']) },
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('missing-asset');
  });

  it('applies material texture defaults and accepts an image map', () => {
    const result = parseScene(
      sceneWith([
        minimalEntity('box', {
          components: [
            { type: 'primitive', shape: 'box', size: [1, 1, 1] },
            { type: 'material', map: 'swatch' },
          ],
        }),
      ]),
      { assetIds: new Set(['swatch']), assetKinds: new Map([['swatch', 'image']]) },
    );
    expect(result.ok, formatIssues(result.issues)).toBe(true);
    const material = result.value?.entities[0]?.components.find((component) => component.type === 'material');
    expect(material?.type).toBe('material');
    if (material?.type !== 'material') return;
    expect(material.map).toBe('swatch');
    expect(material.textureRepeat).toEqual([1, 1]);
    expect(material.textureOffset).toEqual([0, 0]);
  });

  it('reports a material map with the wrong asset kind', () => {
    const result = parseScene(
      sceneWith([
        minimalEntity('box', {
          components: [
            { type: 'primitive', shape: 'box', size: [1, 1, 1] },
            { type: 'material', map: 'crate' },
          ],
        }),
      ]),
      { assetIds: new Set(['crate']), assetKinds: new Map([['crate', 'model']]) },
    );
    expect(result.issues.some((issue) => issue.code === 'asset-kind-mismatch')).toBe(true);
  });

  it('checks behavior properties against the declared registry descriptors', () => {
    const result = parseScene(
      sceneWith([
        minimalEntity('player', {
          components: [{ type: 'behavior', behaviorId: 'player.mover', properties: { speed: 'fast', jump: true } }],
        }),
      ]),
      {
        behaviorIds: new Set(['player.mover']),
        behaviorProperties: new Map([['player.mover', new Map([['speed', 'number' as const], ['jump', 'boolean' as const]])]]),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'behavior-property-type')).toBe(true);
  });

  it('rejects duplicate singleton components on one entity', () => {
    const result = parseScene(
      sceneWith([
        minimalEntity('a', {
          components: [
            { type: 'primitive', shape: 'box', size: [1, 1, 1] },
            { type: 'primitive', shape: 'sphere', size: [1, 1, 1] },
          ],
        }),
      ]),
    );
    expect(result.issues.map((issue) => issue.code)).toContain('duplicate-component');
  });

  it('accepts a physics body on a scene root and rejects one nested under a parent', () => {
    const rootBody = parseScene(
      sceneWith([
        minimalEntity('body', {
          components: [{ type: 'rigidBody', bodyType: 'dynamic' }, { type: 'collider', shape: 'box' }],
        }),
      ]),
    );
    expect(rootBody.ok, formatIssues(rootBody.issues)).toBe(true);
  });
});

describe('project schema', () => {
  it('requires the start scene to exist', () => {
    const result = parseGame({
      schemaVersion: 1,
      id: 'g',
      name: 'Game',
      scenes: [{ id: 'main', name: 'Main', path: 'scenes/main.scene.json' }],
      startScene: 'other',
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('missing-start-scene');
  });

  it('applies engine compatibility defaults', () => {
    const result = parseGame({
      schemaVersion: 1,
      id: 'g',
      name: 'Game',
      scenes: [{ id: 'main', name: 'Main', path: 'scenes/main.scene.json' }],
      startScene: 'main',
    });
    expect(result.ok, formatIssues(result.issues)).toBe(true);
    expect(result.value?.engineCompat).toBe(ENGINE_VERSION);
    expect(result.value?.settings.physics.fixedTimeStep).toBeCloseTo(1 / 60, 6);
  });

  it('rejects asset paths that escape the project folder', () => {
    const result = parseAssetManifest({
      schemaVersion: 1,
      assets: [
        { id: 'escape', kind: 'model', path: '../outside.glb' },
        { id: 'absolute', kind: 'image', path: '/etc/passwd' },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.filter((issue) => issue.code === 'unsafe-asset-path')).toHaveLength(2);
  });
});
