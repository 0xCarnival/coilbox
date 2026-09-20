import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import { button, color, controlSize, space } from '../styles/tokens.stylex.js';

/**
 * The two button shapes, on the pattern left behind by the Radix investigation.
 *
 * Radix merges any `className` it receives, and that merge **replaces** StyleX's generated atomic
 * classes rather than adding to them — an element spreading `stylex.props()` into a Radix part
 * renders with no styles at all. So a component that is both a Radix part and a styled element is
 * always handed to Radix through `asChild`, which makes the styled `<button>` *be* the part. That is
 * why these take a `ref` and forward every prop: Radix clones them.
 *
 * The size is the caller's choice of one of two heights, and the variant is one of `button`'s. Both
 * are composed here rather than spread from inside another `stylex.create`, which the compiler
 * rejects.
 */

export type ButtonVariant = 'primary' | 'outline' | 'secondary' | 'ghost' | 'link' | 'danger';

const danger = stylex.create({
  icon: {
    color: color.danger,
    ':hover': {
      backgroundColor: 'rgba(255, 100, 103, 0.15)',
      color: color.danger,
    },
  },
});

const variantStyles = {
  primary: button.primary,
  outline: button.outline,
  secondary: button.secondary,
  ghost: button.ghost,
  link: button.link,
  danger: danger.icon,
} as const;

const sizeStyles = stylex.create({
  /** The default: `h-8` with horizontal padding, for a label with or without a leading icon. */
  sm: {
    paddingInline: space.md,
  },
  /** A form-scale control: `h-8`, used on the project home and in dialogs. */
  md: {
    height: controlSize.sm,
    paddingInline: space.lg,
  },
  /** A square icon-only control at the default height. */
  icon: {},
});

export interface ButtonProps extends React.ComponentPropsWithoutRef<'button'> {
  variant?: ButtonVariant;
  /** `sm` is the toolbar/panel default, `md` the form default, `icon` a square. */
  size?: 'sm' | 'md' | 'icon';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'sm', type = 'button', ...rest },
  ref,
) {
  const styles =
    size === 'icon'
      ? [button.iconBase, variantStyles[variant]]
      : [button.base, sizeStyles[size], variantStyles[variant]];
  return <button ref={ref} type={type} {...stylex.props(...styles)} {...rest} />;
});

/**
 * A square icon-only control.
 *
 * Split from `Button` rather than a size flag because a square control has no label, so it must
 * carry an accessible name — the `label` prop is required, which makes that a compile error rather
 * than a review comment.
 */
export interface IconButtonProps extends Omit<React.ComponentPropsWithoutRef<'button'>, 'aria-label'> {
  /** The accessible name. Required: an icon-only control has no text to fall back on. */
  label: string;
  variant?: ButtonVariant;
  /** `row` is the 22px square for a control inside a dense list row. */
  size?: 'sm' | 'row';
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', size = 'sm', type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      {...stylex.props(size === 'row' ? button.rowBase : button.iconBase, variantStyles[variant])}
      {...rest}
    />
  );
});
