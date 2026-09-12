import { useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Copy, Focus, Maximize2, Move, Plus, RotateCw, Ruler, Trash2 } from 'lucide-react';
import { createEntity, CREATABLE_KINDS, CREATABLE_LABELS, type CreatableKind } from '../document/factory.js';
import { createEntityId, subtreeOf } from '../document/commands.js';
import { color, radius, space } from '../styles/tokens.stylex.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import type { SnapSettings, TransformTool } from '../viewport/viewport-controller.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from './Menu.js';

/**
 * The floating tool dock over the stage.
 *
 * This is the reference's most distinctive piece of chrome, and the one the earlier passes were
 * furthest from: instead of a row of tools in the window's top bar, the tools float over the canvas
 * they act on, centred along its bottom edge, with each button's keyboard shortcut written in its
 * corner. Putting a mode switch next to the thing it changes is what lets the eye stay in one place,
 * and the shortcut captions are what teach the keyboard without a help screen.
 *
 * ## Why the top toolbar keeps its copy
 *
 * The transform tools, Create, and the play controls also exist in the toolbar. That is deliberate
 * for now rather than an oversight: the browser gates drive the toolbar's controls, and a dock is a
 * second surface for the same actions, not a replacement. The dock is where a person reaches; the
 * toolbar is where the keyboard hints and the automated checks are anchored.
 *
 * The dock hides the actions that do not apply — Duplicate, Delete, and Focus need a selection, and
 * the reference greys or drops them in the same situation.
 */

const styles = stylex.create({
  dock: {
    position: 'absolute',
    insetBlockEnd: space.xl,
    insetInlineStart: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: space.xxs,
    padding: space.xs,
    borderRadius: radius.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.border,
    /**
     * A translucent surface with a blur, not an opaque one. The dock floats over the render, and a
     * solid plate in the middle of the canvas reads as part of the scene rather than as UI above it.
     */
    backgroundColor: 'rgba(23, 23, 23, 0.88)',
    backdropFilter: 'blur(10px)',
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5)',
    zIndex: 40,
  },
  divider: {
    width: '1px',
    alignSelf: 'stretch',
    marginBlock: space.xs,
    marginInline: space.xs,
    backgroundColor: color.border,
    flexShrink: 0,
  },
  /**
   * A dock button is a 36px rounded square. The selected tool takes the surface fill, which is the
   * same "this one is active" treatment the tab strip and the tree use — one idea, one fill.
   */
  tool: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    paddingInline: 0,
    borderRadius: radius.lg,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    color: color.muted,
    cursor: 'pointer',
    transitionProperty: 'background-color, color',
    transitionDuration: '120ms',
    ':hover': {
      backgroundColor: color.wash,
      color: color.text,
    },
    ':disabled': {
      pointerEvents: 'none',
      opacity: 0.35,
    },
  },
  toolActive: {
    backgroundColor: color.surface,
    color: color.text,
  },
  /**
   * The keyboard hint, bottom-right of the button.
   *
   * It is a subscript rather than a tooltip because its job is to be read *in passing*: a tooltip
   * teaches the shortcut only to someone who already suspected there was one.
   */
  key: {
    position: 'absolute',
    insetBlockEnd: '2px',
    insetInlineEnd: '4px',
    fontSize: '9px',
    fontWeight: 600,
    lineHeight: 1,
    color: color.dim,
    pointerEvents: 'none',
  },
  keyActive: {
    color: color.text,
  },
  /** The count of objects a dock action would affect, shown on Duplicate and Delete. */
  count: {
    position: 'absolute',
    insetBlockStart: '3px',
    insetInlineEnd: '3px',
    paddingInline: '3px',
    borderRadius: radius.sm,
    backgroundColor: color.surface,
    fontSize: '9px',
    fontWeight: 600,
    color: color.muted,
    pointerEvents: 'none',
  },
  menuIcon: {
    display: 'flex',
    alignItems: 'center',
    color: color.dim,
  },
});

export interface ToolDockProps {
  tool: TransformTool;
  onToolChange(tool: TransformTool): void;
  onFocus(): void;
  snap: SnapSettings;
  onSnapChange(snap: SnapSettings): void;
  /** Hidden in Play mode, where authoring tools do not apply. */
  visible: boolean;
}

const TOOLS: ReadonlyArray<{ tool: TransformTool; label: string; key: string; Icon: typeof Move }> = [
  { tool: 'translate', label: 'Move', key: 'W', Icon: Move },
  { tool: 'rotate', label: 'Rotate', key: 'E', Icon: RotateCw },
  { tool: 'scale', label: 'Scale', key: 'R', Icon: Maximize2 },
];

export function ToolDock({
  tool,
  onToolChange,
  onFocus,
  snap,
  onSnapChange,
  visible,
}: ToolDockProps): JSX.Element | null {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const [busy, setBusy] = useState(false);
  const scene = session.scene;
  const primary = snapshot.primarySelection;
  const entity = primary && scene ? scene.entities.find((candidate) => candidate.id === primary) : undefined;

  if (!visible) return null;

  /** How many objects Duplicate would actually copy, shown on the button. */
  const subtreeSize = entity && scene ? subtreeOf(scene, entity.id).length : 0;

  /**
   * Duplicate the selection's subtree, re-parenting each copy to its own copy. The id map is built
   * in two passes so every new id exists before any parent reference is rewritten.
   */
  const duplicate = () => {
    if (!entity || !scene) return;
    setBusy(true);
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
    setBusy(false);
  };

  return (
    <div {...stylex.props(styles.dock)} role="toolbar" aria-label="Tools">
      {TOOLS.map(({ tool: candidate, label, key, Icon }) => (
        <button
          key={candidate}
          {...stylex.props(styles.tool, tool === candidate && styles.toolActive)}
          type="button"
          title={`${label} (${key})`}
          aria-label={label}
          aria-pressed={tool === candidate}
          onClick={() => onToolChange(candidate)}
        >
          <Icon size={16} />
          <span {...stylex.props(styles.key, tool === candidate && styles.keyActive)}>{key}</span>
        </button>
      ))}

      <span {...stylex.props(styles.divider)} />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button {...stylex.props(styles.tool)} type="button" title="Add an object" aria-label="Create">
            <Plus size={16} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent wide align="center" side="top">
          <DropdownMenuLabel>Add to scene</DropdownMenuLabel>
          {CREATABLE_KINDS.map((kind: CreatableKind) => (
            <DropdownMenuItem
              key={kind}
              onSelect={() => {
                if (!scene) return;
                const used = scene.entities.map((candidate) => candidate.id);
                const siblings = scene.entities.filter((candidate) => candidate.parentId === null);
                const created = createEntity(kind, {
                  usedIds: used,
                  order: siblings.length,
                  position: [0, kind === 'plane' ? 0 : 1, 0],
                });
                if (session.execute({ kind: 'insertEntities', entities: [created] })) session.select(created.id);
              }}
            >
              {CREATABLE_LABELS[kind]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <span {...stylex.props(styles.divider)} />

      <button
        {...stylex.props(styles.tool)}
        type="button"
        title="Duplicate (Ctrl+D)"
        aria-label="Duplicate"
        disabled={!entity || busy}
        onClick={duplicate}
      >
        <Copy size={16} />
        {entity ? <span {...stylex.props(styles.count)}>{subtreeSize}</span> : null}
      </button>
      <button
        {...stylex.props(styles.tool)}
        type="button"
        title="Delete (Del)"
        aria-label="Delete"
        disabled={!entity}
        onClick={() => {
          if (!entity) return;
          session.execute({ kind: 'deleteEntities', entityIds: [entity.id] });
        }}
      >
        <Trash2 size={16} />
      </button>

      <span {...stylex.props(styles.divider)} />

      <button
        {...stylex.props(styles.tool)}
        type="button"
        title="Centre the view on the selection (F)"
        aria-label="Focus selection"
        disabled={!entity}
        onClick={onFocus}
      >
        <Focus size={16} />
        <span {...stylex.props(styles.key)}>F</span>
      </button>
      <button
        {...stylex.props(styles.tool, snap.enabled && styles.toolActive)}
        type="button"
        title="Snap transforms to the grid"
        aria-label="Toggle snapping"
        aria-pressed={snap.enabled}
        onClick={() => onSnapChange({ ...snap, enabled: !snap.enabled })}
      >
        <Ruler size={16} />
        <span {...stylex.props(styles.key, snap.enabled && styles.keyActive)}>G</span>
      </button>
    </div>
  );
}
