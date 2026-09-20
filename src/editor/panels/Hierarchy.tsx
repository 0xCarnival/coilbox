import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { Entity } from '@schema/index.js';
import {
  Box,
  ChevronRight,
  Boxes,
  Copy,
  Eye,
  EyeOff,
  Layers,
  Lightbulb,
  Lock,
  LockOpen,
  Pause,
  Play,
  Search,
  Trash2,
  Video,
  Workflow,
} from 'lucide-react';
import { color, control, controlSize, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { IconButton } from '../ui/Button.js';
import { DOM, DOM_STATE, withDomClass } from '../dom-contract.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import { createEntity, reparentPreservingWorldTransform } from '../document/factory.js';
import { applyAssetDrop, hasAssetDrag, readAssetDrag, type AssetDropTarget } from '../assets/asset-drop.js';


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
 * Rows painted above and below the visible band, so a scroll of a few rows lands on rows that
 * already exist rather than on a flash of blank panel.
 */
const OVERSCAN = 12;
/** Scenes at least this big open with their large root groups collapsed. */
const LARGE_SCENE_ROWS = 500;
const LARGE_GROUP_CHILDREN = 20;
/** The row height until one has been measured; the compact density's value. */
const FALLBACK_ROW_HEIGHT = 24;
/** The list height until the panel has been measured; tall enough that a small scene renders whole. */
const FALLBACK_LIST_HEIGHT = 800;

/**
 * Pick the glyph for an entity from the components it actually carries.
 *
 * The order matters: a camera is also a mesh-shaped thing to the schema, and a light with a behavior
 * attached is still a light. Matching most-specific-first is what keeps the icon honest — an entity
 * is labelled by what makes it *different* from the rows around it.
 *
 * These are `lucide-react` glyphs, the same set the reference editor uses. A hand-drawn icon set was
 * tried first here and read as amateurish next to a real one: lucide's 24px grid, 2px stroke, and
 * round caps are consistent across every glyph, which is not something a set drawn one at a time
 * arrives at by accident.
 */
function entityIcon(entity: Entity) {
  const types = new Set(entity.components.map((component) => component.type));
  if (types.has('light')) return Lightbulb;
  if (types.has('camera')) return Video;
  if (types.has('collider')) return Boxes;
  if (types.has('behavior')) return Workflow;
  /**
   * A group carries no renderable component of its own — it exists to transform its children. The
   * group glyph is the fall-through rather than a lookup because "has nothing that draws" *is* the
   * definition of a group here.
   */
  if (types.size === 0) return Layers;
  return Box;
}

/** The tree's base row layout, shared by the row and the muted name treatment. */
/**
 * The tree row: 24px tall, the reference's density.
 *
 * Selection is a filled neutral chip with no accent edge — the reference marks a selected row with
 * `bg-accent` and nothing else. An accent-coloured left border was the previous version's invention
 * and it made the tree look like a form with one field focused.
 */
const treeRow = {
  display: 'flex',
  alignItems: 'center',
  gap: space.xxs,
  height: controlSize.row,
  borderRadius: radius.sm,
  cursor: 'default',
} as const;

/**
 * The three per-row state toggles are inline rather than permanently painted.
 *
 * Their resting state is a 22px slot, not a 32px control: the reference's tree rows are 24px tall,
 * and a 32px button inside one would set the row height. The control inside is a real `IconButton`,
 * so the hit area is still the full slot. A row that is *already* hidden, locked, or disabled keeps
 * its toggle painted: hiding it would hide the explanation for why the row looks different, which is
 * the one case where the toggle carries information rather than offering an action.
 */
const rowToggleBase = {
  display: 'grid',
  placeItems: 'center',
  width: '22px',
  height: '22px',
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
  /**
   * The panel header carries a search field and a count. It is not a filled band with a rule under
   * it: a hairline and a slightly taller row is enough to separate a header from its list, and a
   * filled band would compete with the selected row for attention.
   */
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: color.border,
    flexShrink: 0,
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
    paddingInline: space.xs,
  },
  /**
   * The trailing controls occupy a fixed 68px lane that is reserved whether or not they are painted.
   *
   * This is the fix for a real misclick: with the toggles simply hidden, hovering a row made them
   * appear under the cursor, the row grew, and the click that followed landed on a toggle instead of
   * the name — silently hiding or locking the entity and pushing an `editor:*` entry onto the undo
   * stack after whatever edit the user had just made. Reserving the lane means revealing a control
   * cannot move anything.
   */
  treeRow: {
    ...treeRow,
    paddingInlineStart: space.md,
    paddingInlineEnd: 0,
    ':hover': {
      backgroundColor: color.wash,
    },
  },
  /**
   * The empty slot that keeps a childless row's icon aligned with its parent's. Without it the
   * whole tree shifts one indent left on every leaf.
   */
  /** The empty slot that keeps a leaf aligned with its parent's chevron. */
  treeDisclosureEmpty: {
    width: '16px',
    height: '16px',
    flexShrink: 0,
  },
  /**
   * Selection is a quiet accent fill with an accent edge, not a saturated block. The edge is what
   * carries "selected" at a glance; the fill only has to separate the row from its neighbours.
   */
  /** The reference's selected row: the same `accent` fill its tab bar uses, and nothing more. */
  treeRowSelected: {
    backgroundColor: color.surface,
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
  /**
   * The disclosure: a real button that opens and closes its branch.
   *
   * The earlier version drew a bullet for "has children" and promised an interaction it did not
   * have. A chevron that turns is the honest control, and collapsing a long scene is the thing a
   * tree is for.
   */
  treeDisclosure: {
    display: 'grid',
    placeItems: 'center',
    width: '16px',
    height: '16px',
    padding: 0,
    borderRadius: radius.sm,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    color: color.dim,
    flexShrink: 0,
    cursor: 'pointer',
    ':hover': {
      backgroundColor: color['wash-strong'],
      color: color.text,
    },
  },
  treeIconSelected: {
    color: color.text,
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
  /**
   * Duplicate and delete appear only on the hovered row. They are permanent-looking chrome that most
   * rows never need, and keeping them painted cost the name column 44px on a 256px panel — which is
   * why a five-word object name was rendering as "Wall No…".
   */
  treeActions: {
    display: 'none',
    gap: space.xxs,
    flexShrink: 0,
  },
  treeActionsVisible: {
    display: 'flex',
  },
  rowToggle: rowToggleBase,
  /**
   * `display: none` rather than `visibility: hidden`: a `visibility: hidden` element still
   * participates in hit testing, so a click aimed at the row could land on an invisible control.
   * The lane around these is reserved by `treeTrailing`, so removing one from the flow cannot move
   * anything else.
   */
  rowToggleHidden: {
    display: 'none',
  },
  /** The reserved trailing lane: three toggles plus the duplicate/delete pair. */
  treeTrailing: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xxs,
    width: '112px',
    justifyContent: 'flex-end',
    flexShrink: 0,
  },
  /** The two row actions share the lane and are hidden until the row is hovered. */
  treeTrailingActions: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xxs,
    width: '44px',
    justifyContent: 'flex-end',
    flexShrink: 0,
  },
  /** A toggle whose state is not the default: painted, and the row's only bright glyph. */
  rowToggleOn: {
    color: color.text,
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
  /**
   * Parents whose children are hidden.
   *
   * Tracked as the *collapsed* set rather than the expanded one so the default is open: a scene the
   * user has not touched shows everything, and only the branches they closed are remembered. The
   * opposite default would greet every project with a column of shut rows.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const scene = snapshot.project && session.scene ? session.scene : null;
  /**
   * The exception to open-by-default: a scene with thousands of rows opens with its big root
   * groups shut, so a racetrack greets the user with its sections rather than a wall of deck pieces.
   * Decided once per scene, then left to the user.
   */
  const sceneKey = scene ? `${snapshot.project?.id ?? ''}/${scene.id}` : null;
  useEffect(() => {
    if (!scene || scene.entities.length < LARGE_SCENE_ROWS) {
      setCollapsed(new Set());
      return;
    }
    const childCount = new Map<string, number>();
    for (const entity of scene.entities) {
      if (entity.parentId !== null) childCount.set(entity.parentId, (childCount.get(entity.parentId) ?? 0) + 1);
    }
    setCollapsed(new Set(scene.entities.filter((entity) => entity.parentId === null && (childCount.get(entity.id) ?? 0) >= LARGE_GROUP_CHILDREN).map((entity) => entity.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneKey]);

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
    /**
     * Whether anything under an entity matches, computed once for the whole tree. Asking each row
     * for its subtree instead is quadratic, and a two-thousand-row scene made every keystroke in the
     * search field a visible pause.
     */
    const descendantMatches = new Set<string>();
    if (needle.length > 0) {
      const mark = (parentId: string | null): boolean => {
        let any = false;
        for (const entity of byParent.get(parentId) ?? []) {
          const below = mark(entity.id);
          if (below) descendantMatches.add(entity.id);
          if (below || matches(entity)) any = true;
        }
        return any;
      };
      mark(null);
    }
    const result: TreeRow[] = [];
    const visit = (parentId: string | null, depth: number) => {
      for (const entity of byParent.get(parentId) ?? []) {
        if (matches(entity) || descendantMatches.has(entity.id)) result.push({ entity, depth });
        /**
         * A search overrides the collapse state: hiding a match inside a closed branch would make
         * the search look like it found nothing, which is the one thing a search must not do.
         */
        if (needle.length === 0 && collapsed.has(entity.id)) continue;
        visit(entity.id, depth + 1);
      }
    };
    visit(null, 0);
    return result;
  }, [scene, search, collapsed]);

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

  /**
   * Only the rows in view are in the DOM.
   *
   * A racetrack scene has thousands of entities, and painting a `div` with five buttons for each of
   * them cost more than the viewport did. The list scrolls a spacer the height of every row and
   * renders the band the scroll position lands on, plus a margin either side. Row height is read
   * from a rendered row rather than assumed, because the comfortable density makes rows taller.
   */
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(FALLBACK_LIST_HEIGHT);
  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_HEIGHT);
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const observer = new ResizeObserver(() => setListHeight(tree.clientHeight));
    observer.observe(tree);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const row = treeRef.current?.querySelector(`.${DOM.treeRow}`);
    if (row instanceof HTMLElement && row.offsetHeight > 0 && row.offsetHeight !== rowHeight) setRowHeight(row.offsetHeight);
  });
  const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const lastVisible = Math.min(rows.length, Math.ceil((scrollTop + listHeight) / rowHeight) + OVERSCAN);
  const visibleRows = rows.slice(firstVisible, lastVisible);

  /** Bring the primary selection into view when it changes, so picking in the viewport finds its row. */
  const primarySelection = snapshot.primarySelection;
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree || !primarySelection) return;
    const index = rows.findIndex((row) => row.entity.id === primarySelection);
    if (index < 0) return;
    const top = index * rowHeight;
    if (top < tree.scrollTop) tree.scrollTop = top;
    else if (top + rowHeight > tree.scrollTop + tree.clientHeight) tree.scrollTop = top + rowHeight - tree.clientHeight;
  }, [primarySelection, rows, rowHeight]);

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
    session.duplicateSelection([entity.id]);
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
            <Search size={control.iconSm} />
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
      <div
        {...stylex.props(styles.tree)}
        ref={treeRef}
        role="tree"
        aria-label="Scene hierarchy"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onDragOver={(event) => {
          if (locked || !hasAssetDrag(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(event) => {
          if (locked) return;
          const payload = readAssetDrag(event.dataTransfer);
          if (!payload) return;
          event.preventDefault();
          const result = applyAssetDrop(session, payload, { entityId: null, point: [0, 0, 0] });
          session.log(result.ok ? 'info' : 'warning', result.message);
        }}
      >
        {firstVisible > 0 && <div style={{ height: firstVisible * rowHeight }} aria-hidden="true" />}
        {visibleRows.map(({ entity, depth }) => {
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
              style={{ paddingInlineStart: 4 + depth * 10 }}
              onClick={(event) => {
                if (event.shiftKey) {
                  const primaryIndex = rows.findIndex((row) => row.entity.id === snapshot.primarySelection);
                  const clickedIndex = rows.findIndex((row) => row.entity.id === entity.id);
                  if (primaryIndex >= 0 && clickedIndex >= 0) {
                    const start = Math.min(primaryIndex, clickedIndex);
                    const end = Math.max(primaryIndex, clickedIndex);
                    session.selectMany(rows.slice(start, end + 1).map((row) => row.entity.id), { additive: true });
                    return;
                  }
                }
                session.select(entity.id, { additive: event.metaKey || event.ctrlKey });
              }}
              onDoubleClick={() => !locked && setRenaming(entity.id)}
              onMouseEnter={() => setHovered(entity.id)}
              onMouseLeave={() => setHovered((current) => (current === entity.id ? null : current))}
              onDragOver={(event) => {
                if (locked || !hasAssetDrag(event.dataTransfer)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
              }}
              onDrop={(event) => {
                const payload = readAssetDrag(event.dataTransfer);
                if (locked || !payload) return;
                event.preventDefault();
                event.stopPropagation();
                const target: AssetDropTarget =
                  payload.kind === 'model' ? { entityId: null, point: [0, 0, 0] } : { entityId: entity.id, point: [0, 0, 0] };
                const result = applyAssetDrop(session, payload, target);
                session.log(result.ok ? 'info' : 'warning', result.message);
              }}
              data-entity-id={entity.id}
            >
              {/**
               * The row reads: disclosure, kind, name — then the per-row state toggles, which only
               * appear on the hovered row. A row that is *already* hidden, locked, or disabled keeps
               * its toggle painted, because hiding it would hide the reason the row looks different.
               *
               * Everything before the name is a fixed-width slot, which is what keeps one
               * alignment line down the tree however deep a node sits.
               */}
              {hasChildren.has(entity.id) ? (
                <button
                  {...stylex.props(styles.treeDisclosure)}
                  type="button"
                  aria-label={collapsed.has(entity.id) ? `Expand ${entity.name}` : `Collapse ${entity.name}`}
                  aria-expanded={!collapsed.has(entity.id)}
                  onClick={(event) => {
                    event.stopPropagation();
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(entity.id)) next.delete(entity.id);
                      else next.add(entity.id);
                      return next;
                    });
                  }}
                >
                  <ChevronRight
                    size={control.iconSm}
                    style={{
                      transform: collapsed.has(entity.id) ? 'none' : 'rotate(90deg)',
                      transition: 'transform 120ms ease',
                    }}
                  />
                </button>
              ) : (
                <span {...stylex.props(styles.treeDisclosureEmpty)} aria-hidden="true" />
              )}
              <span {...stylex.props(styles.treeIcon, isSelected && styles.treeIconSelected)}>
                <EntityIcon size={control.iconSm} />
              </span>
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
              {/** The reserved trailing lane: row state, then the row actions. */}
              <span {...stylex.props(styles.treeTrailing)}>
                <span
                  {...stylex.props(
                    styles.rowToggle,
                    !isHovered && entity.editor.visible && styles.rowToggleHidden,
                    !entity.editor.visible && styles.rowToggleOn,
                  )}
                >
                  <IconButton
                    size="row"
                    label={entity.editor.visible ? 'Hide in the editor' : 'Show in the editor'}
                    disabled={locked}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleEditorState(entity, { visible: !entity.editor.visible });
                    }}
                  >
                    {entity.editor.visible ? <Eye size={control.iconSm} /> : <EyeOff size={control.iconSm} />}
                  </IconButton>
                </span>
                <span
                  {...stylex.props(
                    styles.rowToggle,
                    !isHovered && !entity.editor.locked && styles.rowToggleHidden,
                    entity.editor.locked && styles.rowToggleOn,
                  )}
                >
                  <IconButton
                    size="row"
                    label={entity.editor.locked ? 'Unlock' : 'Lock (prevents selection in the viewport)'}
                    disabled={locked}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleEditorState(entity, { locked: !entity.editor.locked });
                    }}
                  >
                    {entity.editor.locked ? <Lock size={control.iconSm} /> : <LockOpen size={control.iconSm} />}
                  </IconButton>
                </span>
                <span
                  {...stylex.props(
                    styles.rowToggle,
                    !isHovered && entity.enabled && styles.rowToggleHidden,
                    !entity.enabled && styles.rowToggleOn,
                  )}
                >
                  <IconButton
                    size="row"
                    label={
                      entity.enabled
                        ? 'Enabled in the game — click to disable'
                        : 'Disabled in the game — click to enable'
                    }
                    disabled={locked}
                    onClick={(event) => {
                      event.stopPropagation();
                      session.execute({ kind: 'setEntityEnabled', entityId: entity.id, enabled: !entity.enabled });
                    }}
                  >
                    {entity.enabled ? <Pause size={control.iconSm} /> : <Play size={control.iconSm} />}
                  </IconButton>
                </span>
                <span {...stylex.props(styles.treeActions, isHovered && styles.treeActionsVisible)}>
                  <IconButton
                    size="row"
                    label="Duplicate"
                    disabled={locked}
                    onClick={(event) => {
                      event.stopPropagation();
                      duplicate(entity);
                    }}
                  >
                    <Copy size={control.iconSm} />
                  </IconButton>
                  <IconButton
                    size="row"
                    label="Delete"
                    disabled={locked}
                    onClick={(event) => {
                      event.stopPropagation();
                      session.execute({ kind: 'deleteEntities', entityIds: [entity.id] });
                    }}
                  >
                    <Trash2 size={control.iconSm} />
                  </IconButton>
                </span>
              </span>
            </div>
          );
        })}
        {lastVisible < rows.length && <div style={{ height: (rows.length - lastVisible) * rowHeight }} aria-hidden="true" />}
        {rows.length === 0 && (
          <div {...withDomClass(styles.empty, DOM.panelEmpty)}>{search ? 'No matching objects' : 'This scene is empty'}</div>
        )}
      </div>
    </div>
  );
}
