import type { Entity, EntityId, SceneDocument } from '@schema/index.js';
import { createEntityId, subtreeOf } from './commands.js';
import { selectionRoots } from './selection-roots.js';

export interface DuplicateEntitiesResult {
  entities: Entity[];
  selectIds: EntityId[];
}

export function duplicateEntities(scene: SceneDocument, entityIds: readonly EntityId[]): DuplicateEntitiesResult {
  const selected = new Set(entityIds);
  const roots = selectionRoots([...selected], (id) => scene.entities.find((entity) => entity.id === id)?.parentId ?? null);
  const used = scene.entities.map((entity) => entity.id);
  const idMap = new Map<string, string>();
  const entities: Entity[] = [];
  for (const rootId of roots) {
    const root = scene.entities.find((entity) => entity.id === rootId);
    if (!root) continue;
    for (const member of subtreeOf(scene, rootId)) {
      idMap.set(member.id, createEntityId(`${member.name}-copy`, [...used, ...idMap.values()]));
    }
    for (const member of subtreeOf(scene, rootId)) {
      entities.push({
        ...structuredClone(member),
        id: idMap.get(member.id)!,
        name: member.id === rootId ? `${member.name} copy` : member.name,
        parentId: member.parentId !== null && idMap.has(member.parentId) ? idMap.get(member.parentId)! : member.parentId,
      });
    }
  }
  return { entities, selectIds: roots.map((id) => idMap.get(id)!).filter(Boolean) };
}
