import { Fragment } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { railPanelsFor, type DeclaredPanel, type RailPanel } from './rail-registry.js';
import { color, controlSize, radius, space } from '../styles/tokens.stylex.js';
import { mergedClass } from './merged-class.js';

/**
 * The left icon rail.
 *
 * The reference editor's shell is a 56px rail of icon buttons down the left edge, then the panel
 * column they switch. It is the single most recognisable thing about their layout, and it is what
 * lets a panel collapse to nothing without the navigation disappearing with it — clicking a rail
 * icon reopens its panel, and clicking the active one closes it.
 *
 * ## Why the labels are tooltips
 *
 * A rail button has no text, so the name has to live somewhere: `aria-label` for assistive tech and
 * a Radix tooltip on the right for everyone else. The tooltip is the real Radix one rather than a
 * `title` attribute — it is keyboard reachable, it does not wait a second to appear, and it is not
 * suppressed by the platform.
 */

const styles = stylex.create({
  rail: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space.xs,
    width: controlSize.rail,
    flexShrink: 0,
    paddingBlock: space.md,
    backgroundColor: color.bg,
    borderInlineEndWidth: '1px',
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: color.border,
  },
  /** A 36px rounded square, the reference's `h-9 w-9 rounded-lg`. */
  button: {
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
    color: color.dim,
    cursor: 'pointer',
    transitionProperty: 'background-color, color',
    transitionDuration: '120ms',
    ':hover': {
      backgroundColor: color.wash,
      color: color.text,
    },
    ':focus-visible': {
      outlineWidth: '3px',
      outlineStyle: 'solid',
      outlineColor: 'rgba(138, 138, 138, 0.5)',
      outlineOffset: '0px',
    },
  },
  /** The active panel: a filled neutral chip, and the glyph comes up to full brightness. */
  active: {
    backgroundColor: color.surface,
    color: color.text,
  },
  divider: {
    width: '32px',
    height: '1px',
    marginBlock: space.sm,
    backgroundColor: color.border,
    flexShrink: 0,
  },
  spacer: {
    flex: 1,
  },
  tooltip: {
    zIndex: 60,
    paddingBlock: space.xs,
    paddingInline: space.md,
    borderRadius: radius.md,
    backgroundColor: color.text,
    color: color.bg,
    fontSize: '12px',
    fontWeight: 500,
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.4)',
  },
});

export interface IconRailProps {
  /** The panel whose contents are currently showing. */
  active: string;
  onSelect(id: string): void;
  /**
   * Panels the project declares, or null when it declares none.
   *
   * Passed in rather than read from the session here, so the rail stays a presentational component
   * and the shell keeps the one place that reads project state.
   */
  declared: readonly DeclaredPanel[] | null;
}

export function IconRail({ active, onSelect, declared }: IconRailProps): JSX.Element {
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <nav {...stylex.props(styles.rail)} aria-label="Editor panels">
        {railPanelsFor(declared).map(({ id, label, Icon }: RailPanel, index: number) => {
          const isActive = id === active;
          return (
            <Fragment key={id}>
              {/**
               * A hairline separates the object tree from the project-level panels, which is where
               * the reference puts its divider. It sits between the Fragment's children rather than
               * inside the tooltip root, which takes a single child.
               */}
              {index === 1 ? <span {...stylex.props(styles.divider)} /> : null}
              <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>
                  <button
                    type="button"
                    aria-label={label}
                    aria-pressed={isActive}
                    onClick={() => onSelect(id)}
                    {...stylex.props(styles.button, isActive && styles.active)}
                  >
                    <Icon size={18} />
                  </button>
                </TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                  <TooltipPrimitive.Content
                    side="right"
                    sideOffset={8}
                    className={mergedClass(styles.tooltip)}
                  >
                    {label}
                  </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
              </TooltipPrimitive.Root>
            </Fragment>
          );
        })}
      </nav>
    </TooltipPrimitive.Provider>
  );
}
