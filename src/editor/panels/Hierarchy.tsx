import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { Entity } from '@schema/index.js';
import { color, fontSize, space } from '../styles/tokens.stylex.js';
import { DOM, DOM_STATE, withDomClass } from '../dom-contract.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import { createEntity, reparentPreservingWorldTransform } from '../document/factory.js';
import { createEntityId, subtreeOf } from '../document/commands.js';
import {
  IconBehavior,
  IconCamera,
  IconClose,
  IconEye,
  IconGroup,
  IconLight,
  IconLock,
  IconMesh,
  IconPause,
  IconPlay,
  IconSearch,
  IconTrigger,
} from './icons.js';

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

/**
 * Pick the glyph for an entity from the components it actually carries.
 *
 * The order matters: a camera is also a mesh-shaped thing to the schema, and a light with a
 * behavior attached is still a light. Matching most-specific-first is what keeps the icon honest —
 * an entity is labelled by what makes it *different* from the rows around it.
 */
function entityIcon(entity: Entity) {
  const types = new Set(entity.components.map((component) => component.type));
  if (types.has('light')) return IconLight;
  if (types.has('camera')) return IconCamera;
  if (types.has('collider')) return IconTrigger;
  if (types.has('behavior')) return IconBehavior;
  /**
   * A group carries no renderable component of its own — it exists to transform its children. The
   * group glyph is the fall-through rather than a lookup because "has nothing that draws" *is* the
   * definition of a group here.
   */
  if (types.size === 0) return IconGroup;
  return IconMesh;
}

/** The tree's base row layout, shared by the row and the muted name treatment. */
const treeRow = {
  display: 'flex',
  alignItems: 'center',
  gap: space.xs,
  paddingBlock: '3px',
  paddingInline: space.sm,
  cursor: 'default',
  borderInlineStartWidth: '2px',
  borderInlineStartStyle: 'solid',
  borderInlineStartColor: 'transparent',
} as const;

/** Bare icon buttons: no chrome, muted, and sized to the glyph they carry. */
const iconButton = {
  backgroundColor: 'transparent',
  borderWidth: 0,
  borderStyle: 'none',
  display: 'grid',
  placeItems: 'center',
  width: '18px',
  height: '18px',
  paddingInline: 0,
  color: color.dim,
  flexShrink: 0,
} as const;

const styles = stylex.create({
  hierarchy: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
  },
  /**
   * The panel header carries the search field and a count, and it is deliberately *not* a filled
   * band with a rule under it. The count is what tells the reader the panel is a live list, which
   * a border never did.
   */
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    paddingBlock: space.sm,
    paddingInline: space.sm,
  },
  searchWrap: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
    color: color.dim,
  },
  searchIcon: {
    position: 'absolute',
    insetInlineStart: '7px',
    pointerEvents: 'none',
    display: 'grid',
    placeItems: 'center',
  },
  search: {
    flex: 1,
    minWidth: 0,
    paddingInlineStart: '25px',
  },
  count: {
    color: color.dim,
    fontSize: fontSize.xs,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
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
      backgroundColor: color.wash,
    },
  },
  /**
   * The empty slot that keeps a childless row's icon aligned with its parent's. Without it the
   * whole tree shifts one indent left on every leaf.
   */
  treeDisclosureEmpty: {
    width: '12px',
    flexShrink: 0,
  },
  /**
   * Selection is a quiet accent fill with an accent edge, not a saturated block. The edge is what
   * carries "selected" at a glance; the fill only has to separate the row from its neighbours.
   */
  treeRowSelected: {
    backgroundColor: color['accent-quiet'],
    borderInlineStartColor: color.accent,
  },
  /**
   * The entity's kind, as a glyph. Three identical dots in a column told the reader nothing about
   * which row was the camera; the icon is the only thing in this panel that makes a long tree
   * scannable rather than merely readable.
   */
  treeIcon: {
    display: 'grid',
    placeItems: 'center',
    width: '18px',
    color: color.dim,
    flexShrink: 0,
  },
  /**
   * The disclosure marker.
   *
   * It is a dot rather than a rotating chevron: a chevron implies the row expands in place, but
   * this tree is always fully expanded, so the only fact worth showing is *has children*. A fixed
   * glyph is the honest version of that, and it stops the tree from promising an interaction it
   * does not have.
   */
  treeDisclosure: {
    width: '12px',
    display: 'grid',
    placeItems: 'center',
    color: color.dim,
    flexShrink: 0,
  },
  treeIconSelected: {
    color: color.accent,
  },
  treeName: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: fontSize.sm,
  },
  /**
   * A disabled entity is struck through and muted. This replaced
   * `.tree-row.disabled-entity .tree-name`, which StyleX cannot express: the child's colour
   * depends on the parent's state, so the decoration lives on the child's own conditional style
   * instead of on a descendant selector.
   */
  treeNameDisabled: {
    color: color.dim,
    textDecorationLine: 'line-through',
  },
  treeActions: {
    display: 'none',
    gap: space.xxs,
    flexShrink: 0,
  },
  treeActionsVisible: {
    display: 'flex',
  },
  iconToggle: iconButton,
  /**
   * The visibility, lock, and enabled toggles are per-row state that most rows never change, so
   * they only appear on the hovered row. A permanently visible column of toggles is what made the
   * tree read as a table of controls rather than a list of objects.
   *
   * A row that is *already* hidden, locked, or disabled keeps its toggle visible: hiding it would
   * hide the explanation for why that row looks different, which is the one case where the toggle
   * is information rather than an action.
   */
  iconToggleHidden: {
    display: 'none',
  },
  rename: {
    flex: 1,
  },
  empty: {
    color: color.dim,
    padding: space.lg,
    textAlign: 'center',
    fontSize: fontSize.sm,
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

  /**
   * Which entities are a parent of something.
   *
   * Derived in one pass from the same `parentId` relation the rows were built from, rather than
   * scanning the scene once per row. It sits above the "no scene" return because a hook cannot
   * follow an early return, and the rows memo above has the same constraint.
   */
  const hasChildren = useMemo(() => {
    const parents = new Set<string>();
    for (const entity of scene?.entities ?? []) {
      if (entity.parentId !== null) parents.add(entity.parentId);
    }
    return parents;
  }, [scene]);

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
        <span {...stylex.props(styles.searchWrap)}>
          <span {...stylex.props(styles.searchIcon)}>
            <IconSearch size={12} />
          </span>
          <input
            {...stylex.props(styles.search)}
            type="search"
            placeholder="Search objects"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search objects"
          />
        </span>
        <span {...stylex.props(styles.count)}>{rows.length}</span>
        <button type="button" title="Group the selected object" disabled={locked || !snapshot.primarySelection} onClick={groupSelection}>
          Group
        </button>
      </div>
      <div {...stylex.props(styles.tree)} role="tree" aria-label="Scene hierarchy">
        {rows.map(({ entity, depth }) => {
          const EntityIcon = entityIcon(entity);
          const isSelected = selected.has(entity.id);
          const isHovered = hovered === entity.id;
          return (
            <div
              key={entity.id}
              role="treeitem"
              aria-selected={isSelected}
              aria-level={depth + 1}
              {...withDomClass(
                styles.treeRow,
                isSelected && styles.treeRowSelected,
                DOM.treeRow,
                isSelected && DOM_STATE.selected,
              )}
              style={{ paddingLeft: 6 + depth * 12 }}
              onClick={(event) => session.select(entity.id, { additive: event.shiftKey || event.metaKey || event.ctrlKey })}
              onDoubleClick={() => !locked && setRenaming(entity.id)}
              onMouseEnter={() => setHovered(entity.id)}
              onMouseLeave={() => setHovered((current) => (current === entity.id ? null : current))}
              data-entity-id={entity.id}
            >
              {/**
               * Visibility and lock are per-row state that most rows never change, so they only
               * appear on the hovered row. The exception is a row that is *already* hidden or
               * locked: hiding that toggle would hide the reason the row looks different, so it
               * stays visible and takes the accent.
               */}
              <button
                {...stylex.props(
                  styles.iconToggle,
                  !isHovered && entity.editor.visible && styles.iconToggleHidden,
                  !entity.editor.visible && styles.treeIconSelected,
                )}
                type="button"
                title={entity.editor.visible ? 'Hide in the editor' : 'Show in the editor'}
                aria-label={entity.editor.visible ? 'Hide in the editor' : 'Show in the editor'}
                disabled={locked}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleEditorState(entity, { visible: !entity.editor.visible });
                }}
              >
                <IconEye size={13} hidden={!entity.editor.visible} />
              </button>
              <button
                {...stylex.props(
                  styles.iconToggle,
                  !isHovered && !entity.editor.locked && styles.iconToggleHidden,
                  entity.editor.locked && styles.treeIconSelected,
                )}
                type="button"
                title={entity.editor.locked ? 'Unlock' : 'Lock (prevents selection in the viewport)'}
                aria-label={entity.editor.locked ? 'Unlock' : 'Lock'}
                disabled={locked}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleEditorState(entity, { locked: !entity.editor.locked });
                }}
              >
                <IconLock size={13} open={!entity.editor.locked} />
              </button>
              <button
                {...stylex.props(
                  styles.iconToggle,
                  !isHovered && entity.enabled && styles.iconToggleHidden,
                  !entity.enabled && styles.treeIconSelected,
                )}
                type="button"
                title={entity.enabled ? 'Enabled in the game — click to disable' : 'Disabled in the game — click to enable'}
                aria-label={entity.enabled ? 'Disable in the game' : 'Enable in the game'}
                disabled={locked}
                onClick={(event) => {
                  event.stopPropagation();
                  session.execute({ kind: 'setEntityEnabled', entityId: entity.id, enabled: !entity.enabled });
                }}
              >
                {entity.enabled ? <IconPause size={12} /> : <IconPlay size={12} />}
              </button>
              <span {...stylex.props(styles.treeIcon, isSelected && styles.treeIconSelected)}>
                <EntityIcon size={13} />
              </span>
              {hasChildren.has(entity.id) ? (
                <span {...stylex.props(styles.treeDisclosure)} aria-hidden="true">
                  ·
                </span>
              ) : (
                <span {...stylex.props(styles.treeDisclosureEmpty)} />
              )}
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
              <span {...stylex.props(styles.treeActions, isHovered && styles.treeActionsVisible)}>
                <button
                  {...stylex.props(styles.iconToggle)}
                  type="button"
                  title="Duplicate"
                  aria-label="Duplicate"
                  disabled={locked}
                  onClick={(event) => {
                    event.stopPropagation();
                    duplicate(entity);
                  }}
                >
                  ⧉
                </button>
                <button
                  {...stylex.props(styles.iconToggle)}
                  type="button"
                  title="Delete"
                  aria-label="Delete"
                  disabled={locked}
                  onClick={(event) => {
                    event.stopPropagation();
                    session.execute({ kind: 'deleteEntities', entityIds: [entity.id] });
                  }}
                >
                  <IconClose size={12} />
                </button>
              </span>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div {...withDomClass(styles.empty, DOM.panelEmpty)}>{search ? 'No matching objects' : 'This scene is empty'}</div>
        )}
      </div>
    </div>
  );
}
