import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { color, control, fontSize, space, surface } from '../styles/tokens.stylex.js';
import { mergedClass } from './merged-class.js';

/**
 * Dropdown menu, on Radix.
 *
 * ## Why this file looks the way it does
 *
 * Radix's parts accept a `className` and merge it themselves — and that merge **replaces** the
 * classes StyleX generated rather than adding to them. An element that spreads `stylex.props()` into
 * a Radix part renders completely unstyled; this was verified against the installed version before
 * any of this was written, not assumed.
 *
 * So the rule for every Radix part in this editor is one of two shapes:
 *
 * - If the styled element *is* the part, it goes through `asChild`. Radix then clones the styled
 *   `<button>` and makes it the trigger, and the atomic classes survive because Radix never touches
 *   its `className`. `<DropdownMenuTrigger asChild><Button …/></DropdownMenuTrigger>`.
 * - If the part owns the element, the styling goes on the element's own `className` prop with **no**
 *   StyleX spread beside it, and any styled child lives inside it.
 *
 * This is why the exports below are thin: they exist to apply one style each, and to keep the
 * `asChild` rule in one place instead of at forty call sites.
 */

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const menuStyles = stylex.create({
  /**
   * The origin-aware entrance their `DropdownMenuContent` uses: the menu scales in from the corner
   * nearest its trigger and fades, over 100 ms. Radix publishes that corner as
   * `--radix-dropdown-menu-content-transform-origin`, and reading it here is what makes the motion
   * feel attached to the trigger rather than to the middle of the screen.
   */
  content: {
    transformOrigin: 'var(--radix-dropdown-menu-content-transform-origin)',
    animationName: 'coilbox-menu-in',
    animationDuration: '100ms',
    animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
    animationFillMode: 'both',
    maxHeight: 'var(--radix-dropdown-menu-content-available-height)',
  },
  item: {
    gap: space.md,
  },
  /** The panel's minimum width, as a style so it composes with the others. */
  contentDefault: {
    minWidth: '192px',
  },
  contentWide: {
    minWidth: '224px',
  },
  /** A destructive row: the label and its glyph both take the danger colour. */
  itemDanger: {
    color: color.danger,
    ':hover': {
      backgroundColor: 'rgba(255, 100, 103, 0.1)',
    },
  },
  /** The leading slot for an item's icon, so labels line up whether or not a row has one. */
  itemIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: control.icon,
    flexShrink: 0,
    color: color.dim,
  },
  itemLabel: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The keyboard hint on the trailing edge of a row. */
  shortcut: {
    marginInlineStart: 'auto',
    fontSize: fontSize.xs,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    color: color.dim,
    letterSpacing: '0.02em',
  },
  /** The filled dot on a radio row. */
  radioDot: {
    width: '6px',
    height: '6px',
    borderRadius: '999px',
    backgroundColor: color.primary,
  },
  /** The tick on a checkbox or radio row, indented into the leading slot. */
  indicator: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: control.iconSm,
    flexShrink: 0,
    color: color.text,
  },
});

export interface DropdownMenuContentProps
  extends Omit<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>, 'className'> {
  /** Widens the panel. Left to the caller: the create menu wants more room than a row menu. */
  wide?: boolean;
  /**
   * DOM-contract hook classes, appended to the merged class list.
   *
   * Radix owns this element's `className`, so a hook the browser gates select on cannot be applied
   * by the caller the usual way — a second `className` after a spread is what
   * `coilbox/no-classname-after-spread` forbids, and here it would also clobber the atomic classes.
   * Passing them as data keeps the hook and the style on speaking terms without either one winning.
   */
  hooks?: readonly string[];
}

export const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  DropdownMenuContentProps
>(function DropdownMenuContent({ wide, hooks, sideOffset = 6, ...rest }, ref) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={[
          mergedClass(
            surface.menu,
            menuStyles.content,
            menuStyles.contentDefault,
            wide && menuStyles.contentWide,
          ),
          ...(hooks ?? []),
        ]
          .filter(Boolean)
          .join(' ')}
        {...rest}
      />
    </DropdownMenuPrimitive.Portal>
  );
});

export const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    icon?: React.ReactNode;
    shortcut?: string;
    danger?: boolean;
  }
>(function DropdownMenuItem({ icon, shortcut, danger, children, ...rest }, ref) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={mergedClass(surface.menuItem, menuStyles.item, danger && menuStyles.itemDanger)}
      {...rest}
    >
      {icon ? <span {...stylex.props(menuStyles.itemIcon)}>{icon}</span> : null}
      <span {...stylex.props(menuStyles.itemLabel)}>{children}</span>
      {shortcut ? <span {...stylex.props(menuStyles.shortcut)}>{shortcut}</span> : null}
    </DropdownMenuPrimitive.Item>
  );
});

export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(function DropdownMenuCheckboxItem({ children, ...rest }, ref) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      className={mergedClass(surface.menuItem, menuStyles.item)}
      {...rest}
    >
      <span {...stylex.props(menuStyles.indicator)}>
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckGlyph />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      <span {...stylex.props(menuStyles.itemLabel)}>{children}</span>
    </DropdownMenuPrimitive.CheckboxItem>
  );
});

export const DropdownMenuRadioItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(function DropdownMenuRadioItem({ children, ...rest }, ref) {
  return (
    <DropdownMenuPrimitive.RadioItem
      ref={ref}
      className={mergedClass(surface.menuItem, menuStyles.item)}
      {...rest}
    >
      <span {...stylex.props(menuStyles.indicator)}>
        <DropdownMenuPrimitive.ItemIndicator>
          <span {...stylex.props(menuStyles.radioDot)} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      <span {...stylex.props(menuStyles.itemLabel)}>{children}</span>
    </DropdownMenuPrimitive.RadioItem>
  );
});

export const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(function DropdownMenuLabel({ children, ...rest }, ref) {
  return (
    <DropdownMenuPrimitive.Label ref={ref} {...rest} className={mergedClass(surface.menuLabel)}>
      {children}
    </DropdownMenuPrimitive.Label>
  );
});

export const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(function DropdownMenuSeparator(radixProps, ref) {
  return (
    <DropdownMenuPrimitive.Separator ref={ref} {...radixProps} className={mergedClass(surface.separator)} />
  );
});

/** A subtle 12px tick, drawn rather than imported so the menu owns no icon dependency. */
function CheckGlyph(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6.2 4.8 8.5 9.5 3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
