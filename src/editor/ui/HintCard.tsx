import { useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Box, MousePointerClick, X } from 'lucide-react';
import { color, control, fontSize, overlay, radius, space } from '../styles/tokens.stylex.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import { DOM, withDomClass } from '../dom-contract.js';
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
  /**
   * The band the card is centred in: the stage *minus the view gizmo's lane*.
   *
   * The card used to be centred on the stage with `insetInlineStart: 50%`, which put its right edge
   * 223px underneath whatever occupies that corner — that control is later in the DOM and shares the
   * card's `zIndex`, so it painted over the hint and clipped it mid-sentence. Raising the card's
   * `zIndex` would only have moved the problem: it would have covered that control instead.
   * Reserving the lane is what actually separates them.
   *
   * It is a wrapper rather than the card's own insets because those two cannot coexist with a
   * `fit-content` width: with `left`, `right`, and `width` all specified the box is over-constrained
   * and CSS drops the trailing inset, so the card kept its full content width and ran straight under
   * the gizmo. It passed a wide measurement by luck — the gizmo's lane is narrower than the panel it
   * replaced — and only failed once the stage was narrow enough for the difference to show.
   *
   * The wrapper therefore owns the geometry and a flex row centres a card that still hugs its text.
   */
  lane: {
    position: 'absolute',
    insetBlockStart: space.md,
    insetInlineStart: space.md,
    insetInlineEnd: overlay.lane,
    display: 'flex',
    justifyContent: 'center',
    /** A band across the top of the stage must not swallow drags aimed at the canvas behind it. */
    pointerEvents: 'none',
    zIndex: 30,
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    /**
     * The card has to be *allowed* to be narrower than its text.
     *
     * A flex item's automatic minimum size is its min-content size, and the hint line is `nowrap` —
     * so without this the card refused to shrink below its full text width and ran out of the lane it
     * had just been given. `minWidth: 0` is what lets it shrink; the ellipsis on the text is what
     * makes the shrinking readable rather than a clip.
     */
    minWidth: 0,
    maxWidth: overlay.card,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderRadius: radius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.border,
    backgroundColor: 'rgba(23, 23, 23, 0.92)',
    backdropFilter: 'blur(8px)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
    pointerEvents: 'auto',
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
  translate: 'Drag an arrow to move it. Turn on Snap in the toolbar to snap to the grid.',
  rotate: 'Drag a ring to rotate it. Turn on Snap in the toolbar to snap to the grid.',
  scale: 'Drag a handle to resize it. Turn on Snap in the toolbar to snap to the grid.',
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
    <div {...stylex.props(styles.lane)}>
      <div {...withDomClass(styles.card, DOM.hintCard)} role="status">
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
    </div>
  );
}
