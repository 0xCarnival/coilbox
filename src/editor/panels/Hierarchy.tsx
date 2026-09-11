import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { Entity } from '@schema/index.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import { createEntity, reparentPreservingWorldTransform } from '../document/factory.js';
import { createEntityId, subtreeOf } from '../document/commands.js';

/**
 * Hierarchy panel (plan §3): search, selection, rename, visibility, lock, grouping.
 *
 * Visibility and locking here are the *editor's* view of the scene. Toggling them never
 * changes whether an object exists in the game — that is the separate "enabled" switch.
 */

interface TreeRow {
  entity: Entity;
  depth: number;
}

export function Hierarchy({ locked }: { locked: boolean }): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const [search, setSearch] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const scene = snapshot.project && session.scene ? session.scene : null;

  const rows = useMemo<TreeRow[]>(() => {
    if (!scene) return [];
    const byParent = new Map<string | null, Entity[]>();
    for (const entity of scene.entities) {
      const list = byParent.get(entity.parentId) ?? [];
      list.push(entity);
      byParent.set(entity.parentId, list);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

    const needle = search.trim().toLowerCase();
    const matches = (entity: Entity) => needle.length === 0 || entity.name.toLowerCase().includes(needle) || entity.id.includes(needle);
    const result: TreeRow[] = [];
    const visit = (parentId: string | null, depth: number) => {
      for (const entity of byParent.get(parentId) ?? []) {
        const childrenMatch = needle.length > 0 && subtreeOf(scene, entity.id).some((child) => child.id !== entity.id && matches(child));
        if (matches(entity) || childrenMatch) result.push({ entity, depth });
        visit(entity.id, depth + 1);
      }
    };
    visit(null, 0);
    return result;
  }, [scene, search]);

  if (!scene) {
    return <div className="panel-empty">No scene open</div>;
  }

  const selected = new Set(snapshot.selectedIds);

  const toggleEditorState = (entity: Entity, patch: { visible?: boolean; locked?: boolean }) => {
    session.execute({ kind: 'setEditorState', entityId: entity.id, editor: patch }, { coalesceKey: `editor:${entity.id}` });
  };

  const duplicate = (entity: Entity) => {
    const used = scene.entities.map((candidate) => candidate.id);
    const subtree = subtreeOf(scene, entity.id);
    const idMap = new Map<string, string>();
    for (const member of subtree) {
      idMap.set(member.id, createEntityId(`${member.name}-copy`, [...used, ...idMap.values()]));
    }
    const copies = subtree.map((member) => ({
      ...structuredClone(member),
      id: idMap.get(member.id)!,
      name: member.id === entity.id ? `${member.name} copy` : member.name,
      parentId: member.parentId && idMap.has(member.parentId) ? idMap.get(member.parentId)! : member.parentId,
    }));
    session.execute({ kind: 'insertEntities', entities: copies, label: `Duplicate ${entity.name}` });
    session.select(idMap.get(entity.id)!);
  };

  const groupSelection = () => {
    const primary = snapshot.primarySelection;
    if (!primary) return;
    const entity = scene.entities.find((candidate) => candidate.id === primary);
    if (!entity) return;
    const group = createEntity('group', {
      usedIds: scene.entities.map((candidate) => candidate.id),
      name: `${entity.name} group`,
      position: [...entity.transform.position] as [number, number, number],
    });
    const commands = [
      { kind: 'insertEntities' as const, entities: [group] },
      ...reparentPreservingWorldTransform(scene, entity.id, group.id, 0),
    ];
    if (session.transaction(`Group ${entity.name}`, commands)) session.select(group.id);
  };

  return (
    <div className="hierarchy">
      <div className="panel-header">
        <input
          className="search"
          type="search"
          placeholder="Search objects"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search objects"
        />
        <button type="button" title="Group the selected object" disabled={locked || !snapshot.primarySelection} onClick={groupSelection}>
          Group
        </button>
      </div>
      <div className="tree" role="tree" aria-label="Scene hierarchy">
        {rows.map(({ entity, depth }) => (
          <div
            key={entity.id}
            role="treeitem"
            aria-selected={selected.has(entity.id)}
            aria-level={depth + 1}
            className={`tree-row${selected.has(entity.id) ? ' selected' : ''}${entity.enabled ? '' : ' disabled-entity'}`}
            style={{ paddingLeft: 6 + depth * 12 }}
            onClick={(event) => session.select(entity.id, { additive: event.shiftKey || event.metaKey || event.ctrlKey })}
            onDoubleClick={() => !locked && setRenaming(entity.id)}
            data-entity-id={entity.id}
          >
            <button
              type="button"
              className="icon-toggle"
              title={entity.editor.visible ? 'Hide in the editor' : 'Show in the editor'}
              disabled={locked}
              onClick={(event) => {
                event.stopPropagation();
                toggleEditorState(entity, { visible: !entity.editor.visible });
              }}
            >
              {entity.editor.visible ? '◉' : '○'}
            </button>
            <button
              type="button"
              className="icon-toggle"
              title={entity.editor.locked ? 'Unlock' : 'Lock (prevents selection in the viewport)'}
              disabled={locked}
              onClick={(event) => {
                event.stopPropagation();
                toggleEditorState(entity, { locked: !entity.editor.locked });
              }}
            >
              {entity.editor.locked ? '🔒' : '·'}
            </button>
            <button
              type="button"
              className="icon-toggle"
              title={entity.enabled ? 'Enabled in the game — click to disable' : 'Disabled in the game — click to enable'}
              disabled={locked}
              onClick={(event) => {
                event.stopPropagation();
                session.execute({ kind: 'setEntityEnabled', entityId: entity.id, enabled: !entity.enabled });
              }}
            >
              {entity.enabled ? '▶' : '⏸'}
            </button>
            {renaming === entity.id ? (
              <input
                className="rename"
                autoFocus
                defaultValue={entity.name}
                onClick={(event) => event.stopPropagation()}
                onBlur={(event) => {
                  setRenaming(null);
                  if (event.target.value !== entity.name) {
                    session.execute({ kind: 'renameEntity', entityId: entity.id, name: event.target.value });
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                  if (event.key === 'Escape') setRenaming(null);
                  event.stopPropagation();
                }}
              />
            ) : (
              <span className="tree-name">{entity.name}</span>
            )}
            <span className="tree-actions">
              <button
                type="button"
                title="Duplicate"
                disabled={locked}
                onClick={(event) => {
                  event.stopPropagation();
                  duplicate(entity);
                }}
              >
                ⧉
              </button>
              <button
                type="button"
                title="Delete"
                disabled={locked}
                onClick={(event) => {
                  event.stopPropagation();
                  session.execute({ kind: 'deleteEntities', entityIds: [entity.id] });
                }}
              >
                ✕
              </button>
            </span>
          </div>
        ))}
        {rows.length === 0 && <div className="panel-empty">{search ? 'No matching objects' : 'This scene is empty'}</div>}
      </div>
    </div>
  );
}
