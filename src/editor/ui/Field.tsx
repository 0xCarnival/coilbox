import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { color, control, fontSize, radius, space, surface } from '../styles/tokens.stylex.js';
import { mergedClass } from './merged-class.js';

/**
 * Switch, select, and the field wrappers the Inspector is built from.
 *
 * These follow the same rule as the menu: a Radix part that owns its element takes its class list as
 * a single merged string, and a part that should *be* a styled element is passed through `asChild`.
 * See `Menu.tsx` for why that is not optional.
 */

const switchStyles = stylex.create({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    width: '32px',
    height: '18px',
    padding: '2px',
    borderRadius: radius.pill,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    backgroundColor: color.surface,
    cursor: 'pointer',
    flexShrink: 0,
    transitionProperty: 'background-color, box-shadow',
    transitionDuration: '120ms',
    ':focus-visible': {
      outlineWidth: '3px',
      outlineStyle: 'solid',
      outlineColor: 'rgba(138, 138, 138, 0.5)',
      outlineOffset: '0px',
    },
    ':disabled': {
      cursor: 'default',
      opacity: 0.5,
    },
  },
  /** Checked is the near-white fill — the same "on" signal the primary button uses. */
  rootChecked: {
    backgroundColor: color.primary,
  },
  thumb: {
    display: 'block',
    width: '14px',
    height: '14px',
    borderRadius: radius.pill,
    backgroundColor: color.muted,
    transitionProperty: 'transform, background-color',
    transitionDuration: '120ms',
    transform: 'translateX(0)',
    willChange: 'transform',
  },
  thumbChecked: {
    backgroundColor: color['primary-ink'],
    transform: 'translateX(14px)',
  },
});

export interface SwitchProps
  extends Omit<React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>, 'className'> {
  /** The accessible name. A switch has no text of its own. */
  label: string;
}

export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  SwitchProps
>(function Switch({ label, checked, ...rest }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      aria-label={label}
      checked={checked}
      {...rest}
      className={mergedClass(switchStyles.root, checked && switchStyles.rootChecked)}
    >
      <SwitchPrimitive.Thumb
        className={mergedClass(switchStyles.thumb, checked && switchStyles.thumbChecked)}
      />
    </SwitchPrimitive.Root>
  );
});

const selectStyles = stylex.create({
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    height: control.sm,
    width: '100%',
    paddingInline: space.lg,
    borderRadius: radius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 255, 255, 0.075)',
    backgroundColor: 'rgba(51, 51, 51, 0.3)',
    color: color.text,
    fontSize: fontSize.md,
    cursor: 'pointer',
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: '100ms',
    ':hover': {
      borderColor: color['border-input'],
    },
    ':focus-visible': {
      borderColor: color.ring,
      boxShadow: `0 0 0 1px ${color.ring}`,
      outline: 'none',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'default',
    },
  },
  value: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'left',
  },
  chevron: {
    color: color.dim,
    flexShrink: 0,
  },
  content: {
    transformOrigin: 'var(--radix-select-content-transform-origin)',
    animationName: 'coilbox-menu-in',
    animationDuration: '100ms',
    animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
    animationFillMode: 'both',
    maxHeight: 'var(--radix-select-content-available-height)',
    minWidth: 'var(--radix-select-trigger-width)',
  },
  item: {},
  itemIndicator: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: control.iconSm,
    flexShrink: 0,
    color: color.text,
  },
  /** The scroll affordances Radix renders when a long list is clipped. */
  scrollButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '24px',
    color: color.dim,
  },
});

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export const Select = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Trigger>,
  {
    value: string;
    onValueChange(value: string): void;
    options: readonly SelectOption[];
    /** The accessible name for the trigger. */
    label: string;
    disabled?: boolean;
  }
>(function Select({ value, onValueChange, options, label, disabled }, ref) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger ref={ref} aria-label={label} className={mergedClass(selectStyles.trigger)}>
        <span {...stylex.props(selectStyles.value)}>
          <SelectPrimitive.Value />
        </span>
        <SelectPrimitive.Icon asChild>
          <span {...stylex.props(selectStyles.chevron)}>
            <ChevronDown size={control.iconSm} />
          </span>
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className={mergedClass(surface.menu, selectStyles.content)}
        >
          <SelectPrimitive.ScrollUpButton className={mergedClass(selectStyles.scrollButton)}>
            <ChevronUp size={control.iconSm} />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={mergedClass(surface.menuItem, selectStyles.item)}
              >
                <span {...stylex.props(selectStyles.itemIndicator)}>
                  <SelectPrimitive.ItemIndicator>
                    <Check size={control.iconSm} />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <span {...stylex.props(surface.menuItemLabel)}>
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                </span>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className={mergedClass(selectStyles.scrollButton)}>
            <ChevronDown size={control.iconSm} />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
});

/**
 * The field wrappers, which are the Inspector's whole vertical rhythm.
 *
 * Their settings panel is a `space-y-6` column of `space-y-2` groups: an uppercase micro-label, then
 * the control, then optional help text. These three components are that shape, so a new field cannot
 * invent its own spacing.
 */
const fieldStyles = stylex.create({
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.lg,
  },
  groupDivided: {
    borderBlockStartWidth: '1px',
    borderBlockStartStyle: 'solid',
    borderBlockStartColor: color.border,
  },
  label: {
    fontSize: fontSize.micro,
    fontWeight: 600,
    letterSpacing: '0.09em',
    textTransform: 'uppercase',
    color: color.dim,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.md,
  },
  /** A labelled row: the name on the left, the control on the right. */
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    minHeight: '24px',
  },
  rowText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    minWidth: 0,
  },
  rowTitle: {
    fontSize: fontSize.md,
    fontWeight: 500,
    color: color.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowHelp: {
    fontSize: fontSize.xs,
    color: color.dim,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

export function FieldGroup({
  label,
  children,
  divided = true,
}: {
  label: string;
  children: React.ReactNode;
  /** Draw a hairline above the group. The first group in a panel usually does not want one. */
  divided?: boolean;
}): React.ReactElement {
  return (
    <div {...stylex.props(fieldStyles.group, divided && fieldStyles.groupDivided)}>
      <span {...stylex.props(fieldStyles.label)}>{label}</span>
      <div {...stylex.props(fieldStyles.body)}>{children}</div>
    </div>
  );
}

/** A row with a name and optional help text on the left, and one control on the right. */
export function FieldRow({
  title,
  help,
  children,
}: {
  title: string;
  help?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div {...stylex.props(fieldStyles.row)}>
      <span {...stylex.props(fieldStyles.rowText)}>
        <span {...stylex.props(fieldStyles.rowTitle)}>{title}</span>
        {help ? <span {...stylex.props(fieldStyles.rowHelp)}>{help}</span> : null}
      </span>
      {children}
    </div>
  );
}

export { fieldStyles };
