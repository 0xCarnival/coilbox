import type { Component, ComponentType, Entity, EntityId, JsonValue, SceneDocument, Transform } from '@schema/index.js';
import { validateSceneRelationships, type ValidationIssue } from '@schema/index.js';

/**
 * The single command interface every committed authored change goes through (plan §8).
 *
 * Commands are values, not callbacks: an agent, the inspector, the hierarchy, or a
 * keyboard shortcut all produce the same shapes, and the same validation runs on all of
 * them. `planCommand` turns a command into the next scene plus the command that restores
 * the previous one, without mutating the input document.
 */

export type EditorCommand =
  | { kind: 'insertEntities'; entities: Entity[]; label?: string }
  | { kind: 'deleteEntities'; entityIds: EntityId[]; label?: string }
  | { kind: 'renameEntity'; entityId: EntityId; name: string }
  | { kind: 'setTransform'; entityId: EntityId; transform: Partial<Transform> }
  | { kind: 'setComponentProperty'; entityId: EntityId; componentType: ComponentType; property: string; value: JsonValue }
  | { kind: 'addComponent'; entityId: EntityId; component: Component }
  | { kind: 'removeComponent'; entityId: EntityId; componentType: ComponentType }
  | { kind: 'setEntityEnabled'; entityId: EntityId; enabled: boolean }
  | { kind: 'setEditorState'; entityId: EntityId; editor: Partial<Entity['editor']> }
  | { kind: 'reparentEntity'; entityId: EntityId; parentId: EntityId | null; index?: number }
  | { kind: 'setActiveCamera'; entityId: EntityId | null }
  | { kind: 'setSceneEnvironment'; patch: Partial<SceneDocument['environment']> }
  | { kind: 'setSceneName'; name: string };

export interface CommandPlan {
  ok: true;
  /** The scene after the command. Never the same object as the input. */
  next: SceneDocument;
  /** The command that restores the input scene exactly. */
  inverse: EditorCommand;
  /** Short description for the history menu. */
  label: string;
  /** Entities the command touched; used to restore selection on undo. */
  affected: EntityId[];
}

export interface CommandFailure {
  ok: false;
  issues: ValidationIssue[];
}

export type PlanResult = CommandPlan | CommandFailure;

function fail(code: string, message: string, path = 'command'): CommandFailure {
  return { ok: false, issues: [{ code, path, message, severity: 'error' }] };
}

/** Deep-clone the parts of a scene a command rewrites, keeping untouched entities shared. */
function cloneScene(scene: SceneDocument): SceneDocument {
  return { ...scene, entities: [...scene.entities] };
}

export function findEntity(scene: SceneDocument, entityId: EntityId): Entity | undefined {
  return scene.entities.find((entity) => entity.id === entityId);
}

export function childrenOf(scene: SceneDocument, parentId: EntityId | null): Entity[] {
  return scene.entities
    .filter((entity) => entity.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** The entity plus every descendant, in parent-before-child order. */
export function subtreeOf(scene: SceneDocument, entityId: EntityId): Entity[] {
  const result: Entity[] = [];
  const visit = (id: EntityId) => {
    const entity = findEntity(scene, id);
    if (!entity) return;
    result.push(entity);
    for (const child of childrenOf(scene, id)) visit(child.id);
  };
  visit(entityId);
  return result;
}

function replaceEntity(scene: SceneDocument, nextEntity: Entity): SceneDocument {
  return {
    ...scene,
    entities: scene.entities.map((entity) => (entity.id === nextEntity.id ? nextEntity : entity)),
  };
}

function sortEntities(entities: Entity[]): Entity[] {
  return [...entities].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function componentEquals(a: Component, b: Component): boolean {
  return a.type === b.type && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Plan a command: produce the next scene, the inverse command, and a label.
 *
 * Every plan is validated with the same relationship checks the loader uses, so a command
 * can never leave the document in a state the runtime would refuse to load.
 */
export function planCommand(scene: SceneDocument, command: EditorCommand): PlanResult {
  const planned = planUnchecked(scene, command);
  if (!planned.ok) return planned;

  const issues = validateSceneRelationships(planned.next);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    return { ok: false, issues: errors };
  }
  return planned;
}

function planUnchecked(scene: SceneDocument, command: EditorCommand): PlanResult {
  switch (command.kind) {
    case 'insertEntities': {
      if (command.entities.length === 0) return fail('empty-command', 'no entities to insert');
      const existing = new Set(scene.entities.map((entity) => entity.id));
      const duplicates = command.entities.filter((entity) => existing.has(entity.id)).map((entity) => entity.id);
      if (duplicates.length > 0) {
        return fail('duplicate-entity-id', `entity ids already exist: ${duplicates.join(', ')}`);
      }
      const next = cloneScene(scene);
      next.entities = sortEntities([...next.entities, ...command.entities]);
      return {
        ok: true,
        next,
        inverse: { kind: 'deleteEntities', entityIds: command.entities.map((entity) => entity.id) },
        label: command.label ?? `Add ${command.entities.length === 1 ? command.entities[0]?.name ?? 'entity' : `${command.entities.length} entities`}`,
        affected: command.entities.map((entity) => entity.id),
      };
    }

    case 'deleteEntities': {
      const removed = new Map<string, Entity>();
      for (const id of command.entityIds) {
        for (const entity of subtreeOf(scene, id)) removed.set(entity.id, entity);
      }
      if (removed.size === 0) return fail('missing-entity', 'nothing to delete');
      const next = cloneScene(scene);
      next.entities = next.entities.filter((entity) => !removed.has(entity.id));
      if (next.activeCameraId !== null && removed.has(next.activeCameraId)) next.activeCameraId = null;
      const label =
        removed.size === 1
          ? `Delete ${[...removed.values()][0]?.name ?? 'entity'}`
          : `Delete ${removed.size} entities`;
      return {
        ok: true,
        next,
        inverse: { kind: 'insertEntities', entities: [...removed.values()], label: `Restore ${removed.size} entities` },
        label,
        affected: [...removed.keys()],
      };
    }

    case 'renameEntity': {
      const entity = findEntity(scene, command.entityId);
      if (!entity) return fail('missing-entity', `entity "${command.entityId}" does not exist`);
      const name = command.name.trim();
      if (name.length === 0) return fail('invalid-name', 'an entity name cannot be empty');
      if (name.length > 200) return fail('invalid-name', 'an entity name cannot exceed 200 characters');
      if (name === entity.name) return fail('no-op', 'the name is unchanged');
      return {
        ok: true,
        next: replaceEntity(scene, { ...entity, name }),
        inverse: { kind: 'renameEntity', entityId: entity.id, name: entity.name },
        label: `Rename ${entity.name} to ${name}`,
        affected: [entity.id],
      };
    }

    case 'setTransform': {
      const entity = findEntity(scene, command.entityId);
      if (!entity) return fail('missing-entity', `entity "${command.entityId}" does not exist`);
      const transform: Transform = { ...entity.transform, ...command.transform };
      for (const [key, value] of Object.entries(transform)) {
        if (!Array.isArray(value) || value.some((component) => !Number.isFinite(component))) {
          return fail('non-finite-transform', `transform.${key} must contain finite numbers`);
        }
      }
      if (transform.scale.some((component) => component === 0)) {
        return fail('zero-scale', 'scale cannot contain a zero component');
      }
      if (Math.abs(transform.rotation[0] ** 2 + transform.rotation[1] ** 2 + transform.rotation[2] ** 2 + transform.rotation[3] ** 2 - 1) > 1e-3) {
        return fail('unnormalised-rotation', 'rotations are stored as normalised quaternions');
      }
      const changed = (['position', 'rotation', 'scale'] as const).some(
        (key) => JSON.stringify(transform[key]) !== JSON.stringify(entity.transform[key]),
      );
      if (!changed) return fail('no-op', 'the transform is unchanged');
      return {
        ok: true,
        next: replaceEntity(scene, { ...entity, transform }),
        inverse: { kind: 'setTransform', entityId: entity.id, transform: { ...entity.transform } },
        label: `Transform ${entity.name}`,
        affected: [entity.id],
      };
    }

    case 'setComponentProperty': {
      const entity = findEntity(scene, command.entityId);
      if (!entity) return fail('missing-entity', `entity "${command.entityId}" does not exist`);
      const index = entity.components.findIndex((component) => component.type === command.componentType);
      if (index < 0) {
        return fail('missing-component', `entity "${entity.name}" has no ${command.componentType} component`);
      }
      const component = entity.components[index] as Component;
      if (!(command.property in component)) {
        return fail(
          'unknown-property',
          `${command.componentType} has no property "${command.property}"`,
        );
      }
      const nextComponent = { ...component, [command.property]: command.value } as Component;
      if (componentEquals(component, nextComponent)) return fail('no-op', 'the property is unchanged');
      const components = [...entity.components];
      components[index] = nextComponent;
      return {
        ok: true,
        next: replaceEntity(scene, { ...entity, components }),
        inverse: {
          kind: 'setComponentProperty',
          entityId: entity.id,
          componentType: command.componentType,
          property: command.property,
          value: (component as unknown as Record<string, JsonValue>)[command.property] ?? null,
        },
        label: `${entity.name}: ${command.property}`,
        affected: [entity.id],
      };
    }

    case 'addComponent': {
      const entity = findEntity(scene, command.entityId);
      if (!entity) return fail('missing-entity', `entity "${command.entityId}" does not exist`);
      const singletonTypes = new Set(['primitive', 'model', 'camera', 'rigidBody', 'collider', 'animation', 'audio']);
      if (singletonTypes.has(command.component.type) && entity.components.some((c) => c.type === command.component.type)) {
        return fail('duplicate-component', `entity "${entity.name}" already has a ${command.component.type} component`);
      }
      return {
        ok: true,
        next: replaceEntity(scene, { ...entity, components: [...entity.components, command.component] }),
        inverse: { kind: 'removeComponent', entityId: entity.id, componentType: command.component.type },
        label: `Add ${command.component.type} to ${entity.name}`,
        affected: [entity.id],
      };
    }

    case 'removeComponent': {
      const entity = findEntity(scene, command.entityId);
      if (!entity) return fail('missing-entity', `entity "${command.entityId}" does not exist`);
      const component = entity.components.find((c) => c.type === command.componentType);
      if (!component) return fail('missing-component', `entity "${entity.name}" has no ${command.componentType} component`);
      // A rigid body without a collider can be derived; a collider without a body cannot.
      if (command.componentType === 'rigidBody' && entity.components.some((c) => c.type === 'collider')) {
        return fail('collider-without-body', 'remove the collider before removing the rigid body');
      }
      return {
        ok: true,
        next: replaceEntity(scene, {
          ...entity,
          components: entity.components.filter((c) => c.type !== command.componentType),
        }),
        inverse: { kind: 'addComponent', entityId: entity.id, component },
        label: `Remove ${command.componentType} from ${entity.name}`,
        affected: [entity.id],
      };
    }

    case 'setEntityEnabled': {
      const entity = findEntity(scene, command.entityId);
      if (!entity) return fail('missing-entity', `entity "${command.entityId}" does not exist`);
      if (entity.enabled === command.enabled) return fail('no-op', 'the enabled state is unchanged');
      return {
        ok: true,
        next: replaceEntity(scene, { ...entity, enabled: command.enabled }),
        inverse: { kind: 'setEntityEnabled', entityId: entity.id, enabled: entity.enabled },
        label: `${command.enabled ? 'Enable' : 'Disable'} ${entity.name}`,
        affected: [entity.id],
      };
    }

    case 'setEditorState': {
      const entity = findEntity(scene, command.entityId);
      if (!entity) return fail('missing-entity', `entity "${command.entityId}" does not exist`);
      const editor = { ...entity.editor, ...command.editor };
      return {
        ok: true,
        next: replaceEntity(scene, { ...entity, editor }),
        inverse: { kind: 'setEditorState', entityId: entity.id, editor: { ...entity.editor } },
        label: `Update ${entity.name} in the editor`,
        affected: [entity.id],
      };
    }

    case 'reparentEntity': {
      const entity = findEntity(scene, command.entityId);
      if (!entity) return fail('missing-entity', `entity "${command.entityId}" does not exist`);
      if (command.parentId === entity.id) return fail('parent-self', 'an entity cannot be its own parent');
      if (command.parentId !== null) {
        if (!findEntity(scene, command.parentId)) {
          return fail('missing-entity', `parent "${command.parentId}" does not exist`);
        }
        // Refuse to move an entity under its own descendant.
        const descendants = new Set(subtreeOf(scene, entity.id).map((entry) => entry.id));
        if (descendants.has(command.parentId)) {
          return fail('parent-cycle', 'an entity cannot be reparented under its own descendant');
        }
      }
      const siblings = childrenOf(scene, command.parentId).filter((entry) => entry.id !== entity.id);
      const index = command.index === undefined ? siblings.length : Math.max(0, Math.min(command.index, siblings.length));
      const reordered = [...siblings.slice(0, index), entity, ...siblings.slice(index)];
      const orderById = new Map(reordered.map((entry, position) => [entry.id, position]));
      const next = cloneScene(scene);
      next.entities = sortEntities(
        next.entities.map((entry) => {
          if (entry.id === entity.id) {
            return { ...entry, parentId: command.parentId, order: orderById.get(entry.id) ?? entry.order };
          }
          const order = orderById.get(entry.id);
          return order === undefined ? entry : { ...entry, order };
        }),
      );
      return {
        ok: true,
        next,
        inverse: { kind: 'reparentEntity', entityId: entity.id, parentId: entity.parentId, index: entity.order },
        label: `Move ${entity.name}`,
        affected: [entity.id],
      };
    }

    case 'setActiveCamera': {
      if (command.entityId !== null) {
        const entity = findEntity(scene, command.entityId);
        if (!entity) return fail('missing-entity', `entity "${command.entityId}" does not exist`);
        if (!entity.components.some((component) => component.type === 'camera')) {
          return fail('active-camera-not-camera', `entity "${entity.name}" has no camera component`);
        }
      }
      if (scene.activeCameraId === command.entityId) return fail('no-op', 'the active camera is unchanged');
      return {
        ok: true,
        next: { ...scene, activeCameraId: command.entityId },
        inverse: { kind: 'setActiveCamera', entityId: scene.activeCameraId },
        label: 'Set active camera',
        affected: command.entityId ? [command.entityId] : [],
      };
    }

    case 'setSceneEnvironment': {
      const environment = { ...scene.environment, ...command.patch };
      return {
        ok: true,
        next: { ...scene, environment },
        inverse: { kind: 'setSceneEnvironment', patch: { ...scene.environment } },
        label: 'Update environment',
        affected: [],
      };
    }

    case 'setSceneName': {
      const name = command.name.trim();
      if (name.length === 0) return fail('invalid-name', 'a scene name cannot be empty');
      if (name === scene.name) return fail('no-op', 'the scene name is unchanged');
      return {
        ok: true,
        next: { ...scene, name },
        inverse: { kind: 'setSceneName', name: scene.name },
        label: `Rename scene to ${name}`,
        affected: [],
      };
    }

    default: {
      const exhaustive: never = command;
      return fail('unknown-command', `unsupported command: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Generate an entity id that is unique in the scene and stable across sessions.
 * `usedIds` may include ids reserved by a command that has not been applied yet.
 */
export function createEntityId(prefix: string, usedIds: Iterable<string>): string {
  const used = new Set(usedIds);
  const base = prefix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'entity';
  if (!used.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}
