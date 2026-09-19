import type { EntityId } from '@schema/index.js';

/** Selected ids none of whose ancestors are also selected. */
export function selectionRoots(selected: readonly EntityId[], parentOf: (id: EntityId) => EntityId | null): EntityId[] {
  const selectedSet = new Set(selected);
  return selected.filter((id) => {
    let parent = parentOf(id);
    while (parent !== null) {
      if (selectedSet.has(parent)) return false;
      parent = parentOf(parent);
    }
    return true;
  });
}
