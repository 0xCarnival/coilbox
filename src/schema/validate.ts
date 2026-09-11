import { z } from 'zod';
import { componentSchema, type Component } from './components.js';
import { assetManifestSchema, gameSchema, type AssetManifest, type GameDocument } from './project.js';
import { sceneSchema, type Entity, type SceneDocument } from './scene.js';

/**
 * Structural validation (Zod) plus relationship validation (application logic),
 * as required by plan §7: unique IDs, existing parents and asset references, no
 * parent cycles, valid camera references, finite transforms, supported components,
 * valid behavior properties, and compatible schema versions.
 *
 * Validation never mutates or rewrites the input document.
 */

export interface ValidationIssue {
  /** Stable machine-readable code, e.g. `duplicate-entity-id`. */
  code: string;
  /** JSON-pointer-ish location, e.g. `entities[3].parentId`. */
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult<T> {
  ok: boolean;
  value: T | null;
  issues: ValidationIssue[];
}

export interface SceneValidationContext {
  /** Known asset ids from the project's asset manifest, if available. */
  assetIds?: ReadonlySet<string>;
  /** Known behavior ids from the behavior registry, if available. */
  behaviorIds?: ReadonlySet<string>;
  /** Declared property descriptors per behavior id, used to check property names/types. */
  behaviorProperties?: ReadonlyMap<string, ReadonlyMap<string, 'number' | 'boolean' | 'text' | 'enum' | 'entity' | 'asset'>>;
}

function error(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message, severity: 'error' };
}

function warning(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message, severity: 'warning' };
}

function zodIssues(prefix: string, err: z.ZodError): ValidationIssue[] {
  return err.issues.map((issue) => {
    const path = [prefix, ...issue.path.map(String)].filter(Boolean).join('.');
    return error(`schema:${issue.code}`, path, issue.message);
  });
}

/** Zod can be lenient about object identity; keep only one component of each singleton type. */
const SINGLETON_COMPONENTS = new Set(['primitive', 'model', 'camera', 'rigidBody', 'collider', 'animation', 'audio']);

export function parseScene(input: unknown, context: SceneValidationContext = {}): ValidationResult<SceneDocument> {
  const parsed = sceneSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, value: null, issues: zodIssues('scene', parsed.error) };
  }
  const scene = parsed.data;
  const issues = validateSceneRelationships(scene, context);
  return { ok: issues.every((i) => i.severity !== 'error'), value: scene, issues };
}

export function validateSceneRelationships(scene: SceneDocument, context: SceneValidationContext = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map<string, Entity>();

  scene.entities.forEach((entity, index) => {
    const at = `entities[${index}]`;
    if (byId.has(entity.id)) {
      issues.push(error('duplicate-entity-id', `${at}.id`, `entity id "${entity.id}" is used more than once`));
    } else {
      byId.set(entity.id, entity);
    }
    if (entity.parentId === entity.id) {
      issues.push(error('parent-self', `${at}.parentId`, `entity "${entity.name}" is its own parent`));
    }
    const { position, rotation, scale } = entity.transform;
    for (const [axis, value] of (['x', 'y', 'z'] as const).entries()) {
      if (!Number.isFinite(position[axis]) || !Number.isFinite(rotation[axis]) || !Number.isFinite(scale[axis])) {
        issues.push(error('non-finite-transform', `${at}.transform`, `transform of "${entity.name}" contains a non-finite value`));
        break;
      }
    }
    if (Math.abs(rotation[0] ** 2 + rotation[1] ** 2 + rotation[2] ** 2 + rotation[3] ** 2 - 1) > 1e-3) {
      issues.push(error('unnormalised-rotation', `${at}.transform.rotation`, `rotation of "${entity.name}" is not normalised`));
    }
    const seenTypes = new Set<string>();
    entity.components.forEach((component, cIndex) => {
      const cAt = `${at}.components[${cIndex}]`;
      if (SINGLETON_COMPONENTS.has(component.type) && seenTypes.has(component.type)) {
        issues.push(error('duplicate-component', cAt, `"${entity.name}" has more than one ${component.type} component`));
      }
      seenTypes.add(component.type);
    });
  });

  // Parent existence and cycles.
  for (const [index, entity] of scene.entities.entries()) {
    if (entity.parentId === null) continue;
    if (!byId.has(entity.parentId)) {
      issues.push(error('missing-parent', `entities[${index}].parentId`, `parent "${entity.parentId}" of "${entity.name}" does not exist`));
      continue;
    }
    const seen = new Set<string>([entity.id]);
    let cursor: string | null = entity.parentId;
    while (cursor) {
      if (seen.has(cursor)) {
        issues.push(error('parent-cycle', `entities[${index}].parentId`, `parent chain of "${entity.name}" contains a cycle`));
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
    }
  }

  // Active camera reference.
  if (scene.activeCameraId !== null) {
    const cameraEntity = byId.get(scene.activeCameraId);
    if (!cameraEntity) {
      issues.push(error('missing-active-camera', 'activeCameraId', `active camera "${scene.activeCameraId}" does not exist`));
    } else if (!cameraEntity.components.some((c) => c.type === 'camera')) {
      issues.push(error('active-camera-not-camera', 'activeCameraId', `active camera "${cameraEntity.name}" has no camera component`));
    }
  } else if (!scene.entities.some((e) => e.components.some((c) => c.type === 'camera'))) {
    issues.push(warning('no-camera', 'activeCameraId', 'scene has no camera; the runtime will fall back to a default view'));
  }

  // Asset, entity and behavior references.
  for (const [index, entity] of scene.entities.entries()) {
    for (const [cIndex, component] of entity.components.entries()) {
      const at = `entities[${index}].components[${cIndex}]`;
      const assetRefs: Array<[string, string]> = [];
      if (component.type === 'model') assetRefs.push(['assetId', component.assetId]);
      if (component.type === 'audio') assetRefs.push(['assetId', component.assetId]);
      for (const [field, id] of assetRefs) {
        if (context.assetIds && !context.assetIds.has(id)) {
          issues.push(error('missing-asset', `${at}.${field}`, `asset "${id}" is not present in the project asset manifest`));
        }
      }
      if (component.type === 'camera' && component.targetId !== null && !byId.has(component.targetId)) {
        issues.push(error('missing-entity-reference', `${at}.targetId`, `camera target "${component.targetId}" does not exist in this scene`));
      }
      if (component.type === 'behavior') {
        if (context.behaviorIds && !context.behaviorIds.has(component.behaviorId)) {
          issues.push(error('unknown-behavior', `${at}.behaviorId`, `behavior "${component.behaviorId}" is not registered`));
        }
        const descriptors = context.behaviorProperties?.get(component.behaviorId);
        if (descriptors) {
          for (const [key, value] of Object.entries(component.properties)) {
            const expected = descriptors.get(key);
            if (!expected) {
              issues.push(warning('unknown-behavior-property', `${at}.properties.${key}`, `property "${key}" is not declared by behavior "${component.behaviorId}"`));
              continue;
            }
            if (!matchesDescriptor(value, expected)) {
              issues.push(error('behavior-property-type', `${at}.properties.${key}`, `property "${key}" of "${component.behaviorId}" should be ${expected}`));
            }
          }
        }
      }
    }
  }

  return issues;
}

function matchesDescriptor(value: unknown, expected: 'number' | 'boolean' | 'text' | 'enum' | 'entity' | 'asset'): boolean {
  switch (expected) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'text':
    case 'enum':
      return typeof value === 'string';
    case 'entity':
    case 'asset':
      return value === null || typeof value === 'string';
    default:
      return true;
  }
}

export function parseGame(input: unknown): ValidationResult<GameDocument> {
  const parsed = gameSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, value: null, issues: zodIssues('game', parsed.error) };
  }
  const game = parsed.data;
  const issues: ValidationIssue[] = [];
  const sceneIds = new Set<string>();
  game.scenes.forEach((entry, index) => {
    if (sceneIds.has(entry.id)) {
      issues.push(error('duplicate-scene-id', `scenes[${index}].id`, `scene id "${entry.id}" is used more than once`));
    }
    sceneIds.add(entry.id);
  });
  if (!sceneIds.has(game.startScene)) {
    issues.push(error('missing-start-scene', 'startScene', `start scene "${game.startScene}" is not in the scene list`));
  }
  return { ok: issues.length === 0, value: game, issues };
}

export function parseAssetManifest(input: unknown): ValidationResult<AssetManifest> {
  const parsed = assetManifestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, value: null, issues: zodIssues('assets', parsed.error) };
  }
  const manifest = parsed.data;
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  manifest.assets.forEach((asset, index) => {
    if (ids.has(asset.id)) {
      issues.push(error('duplicate-asset-id', `assets[${index}].id`, `asset id "${asset.id}" is used more than once`));
    }
    ids.add(asset.id);
    if (paths.has(asset.path)) {
      issues.push(error('duplicate-asset-path', `assets[${index}].path`, `asset path "${asset.path}" is used more than once`));
    }
    paths.add(asset.path);
    if (asset.path.startsWith('/') || asset.path.includes('..')) {
      issues.push(error('unsafe-asset-path', `assets[${index}].path`, `asset path "${asset.path}" must be project-relative and cannot traverse upward`));
    }
  });
  return { ok: issues.length === 0, value: manifest, issues };
}

/** Parse a single component in isolation (used by the inspector and by agent tooling). */
export function parseComponent(input: unknown): ValidationResult<Component> {
  const parsed = componentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, value: null, issues: zodIssues('component', parsed.error) };
  }
  return { ok: true, value: parsed.data, issues: [] };
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `${i.severity.toUpperCase()} ${i.path}: ${i.message} (${i.code})`).join('\n');
}
