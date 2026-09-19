import type { Entity, EntityId, SceneDocument } from '@schema/index.js';
import { isJsonString } from '../json-values.js';
import { createEntityId, subtreeOf } from './commands.js';
import { selectionRoots } from './selection-roots.js';

export interface DuplicateEntitiesResult {
  entities: Entity[];
  selectIds: EntityId[];
}

export type EntityReferenceKeys = (behaviorId: string) => readonly string[];

export function remapEntityReferences(
  entity: Entity,
  idMap: ReadonlyMap<EntityId, EntityId>,
  entityRefKeys?: EntityReferenceKeys,
): Entity {
  const components = entity.components.map((component) => {
    if (component.type === 'camera' && component.targetId !== null) {
      const targetId = idMap.get(component.targetId);
      if (targetId !== undefined) return { ...component, targetId };
    }
    if (component.type !== 'behavior' || !entityRefKeys) return component;
    const keys = entityRefKeys(component.behaviorId);
    if (keys.length === 0) return component;
    const properties = { ...component.properties };
    for (const key of keys) {
      const value = properties[key];
      if (isJsonString(value)) {
        const remapped = idMap.get(value);
        if (remapped !== undefined) properties[key] = remapped;
      }
    }
    return { ...component, properties };
  });
  return { ...entity, components };
}

export function duplicateEntities(
  scene: SceneDocument,
  entityIds: readonly EntityId[],
  entityRefKeys?: EntityReferenceKeys,
): DuplicateEntitiesResult {
  const selected = new Set(entityIds);
  const roots = selectionRoots([...selected], (id) => scene.entities.find((entity) => entity.id === id)?.parentId ?? null);
  const used = scene.entities.map((entity) => entity.id);
  const idMap = new Map<string, string>();
  const entities: Entity[] = [];
  const subtrees = roots.flatMap((rootId) => {
    const root = scene.entities.find((entity) => entity.id === rootId);
    return root ? [{ rootId, members: subtreeOf(scene, rootId) }] : [];
  });
  for (const { members } of subtrees) {
    for (const member of members) {
      idMap.set(member.id, createEntityId(`${member.name}-copy`, [...used, ...idMap.values()]));
    }
  }
  for (const { rootId, members } of subtrees) {
    for (const member of members) {
      const copiedId = idMap.get(member.id);
      if (copiedId === undefined) continue;
      entities.push(remapEntityReferences({
        ...structuredClone(member),
        id: copiedId,
        name: member.id === rootId ? `${member.name} copy` : member.name,
        parentId: member.parentId === null ? null : idMap.get(member.parentId) ?? member.parentId,
      }, idMap, entityRefKeys));
    }
  }
  const selectIds = roots.flatMap((id) => {
    const copiedId = idMap.get(id);
    return copiedId === undefined ? [] : [copiedId];
  });
  return { entities, selectIds };
}
