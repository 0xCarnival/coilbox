import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { Entity } from '@schema/index.js';
import { color, fontSize, space } from '../styles/tokens.stylex.js';
import { DOM, DOM_STATE, withDomClass } from '../dom-contract.js';
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

/** The tree's base row layout, shared by the row and the muted name treatment. */
const treeRow = {
  display: 'flex',
  alignItems: 'center',
  gap: space.xs,
  paddingBlock: space.xxs,
  paddingInline: space.sm,
  cursor: 'default',
  borderInlineStartWidth: '2px',
  borderInlineStartStyle: 'solid',
  borderInlineStartColor: 'transparent',
} as const;

/** Bare icon buttons: no chrome, muted, and sized to the 11px glyph they carry. */
const iconButton = {
  backgroundColor: 'transparent',
  borderWidth: 0,
  borderStyle: 'none',
  paddingBlock: 0,
  paddingInline: '3px',
  color: color.muted,
  fontSize: fontSize.xs,
} as const;

const styles = stylex.create({
  hierarchy: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
  },
  panelHeader: {
    display: 'flex',
    gap: space.sm,
    padding: space.sm,
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: color.line,
  },
  search: {
    flex: 1,
  },
  tree: {
    overflow: 'auto',
    flex: 1,
    paddingBlock: space.xs,
    paddingInline: 0,
  },
  treeRow: {
    ...treeRow,
    ':hover': {
      backgroundColor: '#1a2030',
    },
  },
  treeRowSelected: {
    backgroundColor: '#22314c',
    borderInlineStartColor: color.accent,
  },
  treeName: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /**
   * A disabled entity is struck through and muted. This replaced
   * `.tree-row.disabled-entity .tree-name`, which StyleX cannot express: the child's colour
   * depends on the parent's state, so the decoration lives on the child's own conditional style
   * instead of on a descendant selector.
   */
  treeNameDisabled: {
    color: color.muted,
    textDecorationLine: 'line-through',
  },
  treeActions: {
    display: 'none',
    gap: space.xxs,
  },
  treeActionsVisible: {
    display: 'flex',
  },
  iconToggle: iconButton,
  rename: {
    flex: 1,
  },
  empty: {
    color: color.muted,
    padding: '14px',
    textAlign: 'center',
  },
});

export function Hierarchy({ locked }: { locked: boolean }): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const [search, setSearch] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
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
    return (
      <div {...withDomClass(styles.empty, DOM.panelEmpty)}>No scene open</div>
    );
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
    const { position } = entity.transform;
    const group = createEntity('group', {
      usedIds: scene.entities.map((candidate) => candidate.id),
      name: `${entity.name} group`,
      position: [position[0], position[1], position[2]],
    });
    const commands = [
      { kind: 'insertEntities' as const, entities: [group] },
      ...reparentPreservingWorldTransform(scene, entity.id, group.id, 0),
    ];
    if (session.transaction(`Group ${entity.name}`, commands)) session.select(group.id);
  };

  return (
    <div {...stylex.props(styles.hierarchy)}>
      <div {...stylex.props(styles.panelHeader)}>
        <input
          {...stylex.props(styles.search)}
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
      <div {...stylex.props(styles.tree)} role="tree" aria-label="Scene hierarchy">
        {rows.map(({ entity, depth }) => (
          <div
            key={entity.id}
            role="treeitem"
            aria-selected={selected.has(entity.id)}
            aria-level={depth + 1}
            {...withDomClass(
              styles.treeRow,
              selected.has(entity.id) && styles.treeRowSelected,
              DOM.treeRow,
              selected.has(entity.id) && DOM_STATE.selected,
            )}
            style={{ paddingLeft: 6 + depth * 12 }}
            onClick={(event) => session.select(entity.id, { additive: event.shiftKey || event.metaKey || event.ctrlKey })}
            onDoubleClick={() => !locked && setRenaming(entity.id)}
            onMouseEnter={() => setHovered(entity.id)}
            onMouseLeave={() => setHovered((current) => (current === entity.id ? null : current))}
            data-entity-id={entity.id}
          >
            <button
              {...stylex.props(styles.iconToggle)}
              type="button"
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
              {...stylex.props(styles.iconToggle)}
              type="button"
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
              {...stylex.props(styles.iconToggle)}
              type="button"
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
                {...stylex.props(styles.rename)}
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
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') setRenaming(null);
                  event.stopPropagation();
                }}
              />
            ) : (
              <span {...withDomClass(styles.treeName, !entity.enabled && styles.treeNameDisabled, DOM.treeName)}>
                {entity.name}
              </span>
            )}
            <span {...stylex.props(styles.treeActions, hovered === entity.id && styles.treeActionsVisible)}>
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
        {rows.length === 0 && (
          <div {...withDomClass(styles.empty, DOM.panelEmpty)}>{search ? 'No matching objects' : 'This scene is empty'}</div>
        )}
      </div>
    </div>
  );
}
