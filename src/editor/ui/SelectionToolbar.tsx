import { useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Copy, Focus, Move, Trash2 } from 'lucide-react';
import { createEntityId, subtreeOf } from '../document/commands.js';
import { color, control, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import { Button, IconButton } from './Button.js';

/**
 * The floating action bar for the current selection.
 *
 * The reference editor shows a small floating menu over the selected object rather than putting every
 * object action in a crowded inspector footer or a tree row. It is the affordance that makes a
 * selection feel *selected*: the object carries its own verbs, and they appear where the eye already
 * is.
 *
 * It floats at the top of the stage rather than tracking the object's projected position. A panel
 * that follows the model needs to be repositioned from the render loop, and it ends up covering the
 * thing it describes when the object is centred; a fixed bar is steadier and never occludes.
 *
 * Only shown when authoring: in Play mode the selection is not what the user is looking at.
 */

const styles = stylex.create({
  bar: {
    position: 'absolute',
    top: space.md,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: space.xxs,
    padding: space.xxs,
    borderRadius: radius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.border,
    backgroundColor: 'rgba(23, 23, 23, 0.92)',
    backdropFilter: 'blur(8px)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
    zIndex: 30,
  },
  /** The object's name, so the bar says what it acts on without a second lookup. */
  title: {
    maxWidth: '200px',
    paddingInline: space.md,
    fontSize: fontSize.sm,
    fontWeight: 500,
    color: color.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  divider: {
    width: '1px',
    alignSelf: 'stretch',
    marginBlock: space.xs,
    backgroundColor: color.border,
    flexShrink: 0,
  },
});

export interface SelectionToolbarProps {
  /** The current transform tool, so its button can show as active. */
  tool: 'translate' | 'rotate' | 'scale';
  onToolChange(tool: 'translate' | 'rotate' | 'scale'): void;
  /** Centres the view on the selection. */
  onFocus(): void;
  /** True while authoring; the bar hides in Play mode. */
  visible: boolean;
}

export function SelectionToolbar({
  tool,
  onToolChange,
  onFocus,
  visible,
}: SelectionToolbarProps): JSX.Element | null {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const [busy, setBusy] = useState(false);
  const primary = snapshot.primarySelection;
  const scene = session.scene;
  const entity = primary && scene ? scene.entities.find((candidate) => candidate.id === primary) : undefined;

  if (!visible || !entity || !scene) return null;

  /**
   * Duplicate the selection's whole subtree.
   *
   * A child must be re-parented to its *copy*, not to the original's parent — copying an entity and
   * leaving its children behind is the version of this that looks right until someone groups
   * something. The id map is built in two passes for exactly that reason: every new id exists before
   * any parent reference is rewritten.
   */
  const duplicate = () => {
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
    <div {...stylex.props(styles.bar)} role="toolbar" aria-label="Selection actions">
      <span {...stylex.props(styles.title)} title={entity.name}>
        {entity.name}
      </span>
      <span {...stylex.props(styles.divider)} />
      <IconButton
        label="Move (W)"
        variant={tool === 'translate' ? 'secondary' : 'ghost'}
        aria-pressed={tool === 'translate'}
        onClick={() => onToolChange('translate')}
      >
        <Move size={control.icon} />
      </IconButton>
      <Button onClick={onFocus} title="Centre the view on this object (F)">
        <Focus size={control.icon} />
        Focus
      </Button>
      <IconButton label="Duplicate" disabled={busy} onClick={duplicate}>
        <Copy size={control.icon} />
      </IconButton>
      <IconButton
        label="Delete"
        onClick={() => session.execute({ kind: 'deleteEntities', entityIds: [entity.id] })}
      >
        <Trash2 size={control.icon} />
      </IconButton>
    </div>
  );
}
