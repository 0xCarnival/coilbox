import { useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Box, MousePointerClick, X } from 'lucide-react';
import { color, control, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import { IconButton } from './Button.js';
import type { TransformTool } from '../viewport/viewport-controller.js';

/**
 * The floating hint card.
 *
 * The reference shows a small card beside the selection that says what the selection *is* and what
 * can be done with it. It is how the editor answers "what am I looking at, and what now" without a
 * modal, a tour, or a manual — the two questions a new user has, answered where their eye already is.
 *
 * ## Why it is dismissible and stays dismissed
 *
 * A hint that cannot be closed is an obstruction, and one that reappears on every selection is
 * worse. This one is closed for the session once dismissed; the same information stays available in
 * the inspector and the dock, so nothing is lost by hiding it.
 *
 * It carries the selection's *identity* as well. The badge above the stage used to do that, and
 * having two floating overlays over one canvas — one naming the object, one explaining it — was one
 * overlay too many. They are the same card now.
 */

const styles = stylex.create({
  card: {
    position: 'absolute',
    insetBlockStart: space.md,
    insetInlineStart: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    maxWidth: '460px',
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: radius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.border,
    backgroundColor: 'rgba(23, 23, 23, 0.92)',
    backdropFilter: 'blur(8px)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
    zIndex: 30,
    /**
     * The entrance is the toast's keyframes reused. One arrival motion for every floating layer
     * means a card appearing always looks like the same kind of event.
     */
    animationName: 'coilbox-toast-in',
    animationDuration: '140ms',
    animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
    animationFillMode: 'both',
  },
  glyph: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    color: color.dim,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    minWidth: 0,
  },
  title: {
    fontSize: fontSize.sm,
    fontWeight: 600,
    color: color.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  hint: {
    fontSize: fontSize.xs,
    color: color.muted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

/**
 * What each transform tool does, so the card can explain the active one.
 *
 * Inferred from the literal and keyed by the tool union, not an open `Record<string, string>`: an
 * open dictionary would accept a typo in a key and silently fall back to the default hint for a real
 * tool. `satisfies` keeps the keys checked while leaving the values as literals.
 */
const TOOL_HINTS = {
  translate: 'Drag an arrow to move it. Hold G to snap to the grid.',
  rotate: 'Drag a ring to rotate it. Hold Shift while dragging for 15° steps.',
  scale: 'Drag a handle to resize it. Drag the centre to scale uniformly.',
} satisfies Partial<Record<TransformTool, string>>;

export interface HintCardProps {
  /**
   * The active transform tool, which decides the hint.
   *
   * Typed as the union rather than `string` so the lookup below needs no assertion — a `string` here
   * would force a cast to index `TOOL_HINTS`, and a cast is what the editor's lint rules exist to
   * make you justify rather than reach for.
   */
  tool: TransformTool;
  /** Hidden in Play mode, where authoring hints do not apply. */
  visible: boolean;
}

export function HintCard({ tool, visible }: HintCardProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);
  const snapshot = useSessionSnapshot();
  const session = useSession();
  const primary = snapshot.primarySelection;
  const scene = session.scene;
  const entity = primary && scene ? scene.entities.find((candidate) => candidate.id === primary) : undefined;

  if (!visible || dismissed || !entity) return null;

  return (
    <div {...stylex.props(styles.card)} role="status">
      <span {...stylex.props(styles.glyph)}>
        <Box size={control.icon} />
      </span>
      <span {...stylex.props(styles.body)}>
        <span {...stylex.props(styles.title)}>{entity.name}</span>
        <span {...stylex.props(styles.hint)}>
          <MousePointerClick size={10} style={{ verticalAlign: '-1px', marginRight: '4px' }} />
          {TOOL_HINTS[tool] ?? 'Select an object to edit its properties.'}
        </span>
      </span>
      <IconButton size="row" label="Dismiss hint" onClick={() => setDismissed(true)}>
        <X size={control.iconSm} />
      </IconButton>
    </div>
  );
}
