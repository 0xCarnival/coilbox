
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Box } from 'lucide-react';
import { color, control, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { useSession, useSessionSnapshot } from '../hooks.js';

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
    paddingInline: space.sm,
    fontSize: fontSize.sm,
    fontWeight: 500,
    color: color.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The kind glyph, so the badge says what sort of object is selected, not only its name. */
  glyph: {
    display: 'flex',
    alignItems: 'center',
    paddingInlineStart: space.md,
    color: color.dim,
  },
  /** The reminder of where the verbs now live. Quiet: it is read once and then known. */
  hint: {
    paddingInlineStart: space.md,
    paddingInlineEnd: space.md,
    fontSize: fontSize.xs,
    color: color.dim,
    whiteSpace: 'nowrap',
  },
});

export interface SelectionToolbarProps {
  /** True while authoring; the bar hides in Play mode. */
  visible: boolean;
  /** The dock's verbs act on this selection; this bar says what it is. */
  hint: string;
}

/**
 * The selection's identity badge, over the stage.
 *
 * It began as a full action bar with Duplicate, Delete, and Focus. Those verbs now live in the tool
 * dock, which is where the reference puts them, and two surfaces offering the same four actions is
 * worse than either alone. What is left is the part the dock cannot say: *which object* the next
 * action will apply to.
 */
export function SelectionToolbar({ visible, hint }: SelectionToolbarProps): JSX.Element | null {
  const snapshot = useSessionSnapshot();
  const session = useSession();
  const primary = snapshot.primarySelection;
  const scene = session.scene;
  const entity = primary && scene ? scene.entities.find((candidate) => candidate.id === primary) : undefined;

  if (!visible || !entity) return null;

  return (
    <div {...stylex.props(styles.bar)} role="toolbar" aria-label="Selection actions">
      <span {...stylex.props(styles.glyph)}>
        <Box size={control.iconSm} />
      </span>
      <span {...stylex.props(styles.title)} title={entity.name}>
        {entity.name}
      </span>
      <span {...stylex.props(styles.hint)}>{hint}</span>
    </div>
  );
}
