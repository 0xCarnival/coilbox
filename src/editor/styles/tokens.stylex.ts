import * as stylex from '@stylexjs/stylex';

/**
 * The editor's design tokens.
 *
 * `stylex.defineVars` compiles to CSS custom properties, so these are the *same* custom properties
 * the plain stylesheet declares — `base.css` still reads `var(--muted)` and the browser resolves it
 * against the `:root` block StyleX emits. That is what lets the panels migrate to StyleX one at a
 * time instead of requiring a single all-or-nothing rewrite.
 *
 * Keys are written in kebab-case precisely so the compiled `--panel-2` matches the name the
 * stylesheet already used. Renaming them would silently break every `var()` reference in
 * `base.css`, so the spelling here is part of the contract with that file.
 *
 * Nothing here is editor-specific except the *values*: the tokens live in the editor because the
 * runtime HUD and the exported game intentionally carry no styling dependency on the editor.
 * See `coilbox/no-stylex-outside-editor` in `oxlint.config.ts`.
 */

/** Surfaces, lines, text, and status colours. */
export const color = stylex.defineVars({
  bg: '#0d0f14',
  panel: '#141821',
  'panel-2': '#171c26',
  line: '#242a36',
  text: '#e6e9ef',
  muted: '#8b93a3',
  accent: '#5b9dff',
  danger: '#ff6b6b',
  warn: '#f0b45c',
  ok: '#54d1a0',
});

/**
 * Spacing scale.
 *
 * These are the values the stylesheet already repeats by hand; naming them is what makes the
 * "one hardcoded hex or pixel count off the scale" class of drift visible in review.
 */
export const space = stylex.defineVars({
  xxs: '2px',
  xs: '4px',
  sm: '6px',
  md: '10px',
  lg: '16px',
});

/** Corner radii. */
export const radius = stylex.defineVars({
  sm: '5px',
  md: '6px',
  lg: '8px',
  pill: '999px',
});

/** Type scale. The editor is a dense tool, so the range is deliberately narrow. */
export const fontSize = stylex.defineVars({
  xs: '11px',
  sm: '12.5px',
  md: '13px',
  lg: '15px',
});

/**
 * The editor's one font stack.
 *
 * StyleX has no `font:` shorthand, so the stack is a token and the size/weight are set separately.
 */
export const fontFamily = stylex.defineVars({
  sans: 'ui-sans-serif, -apple-system, "Segoe UI", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
});

/**
 * Shared button treatments.
 *
 * These were `.primary` and `.link` in `base.css`, written as `button.primary` / `button.link`.
 * A class-qualified element selector has specificity (0,1,1), which outranks one atomic class
 * (0,1,0) — so leaving them in the stylesheet would mean StyleX silently losing. They live here
 * instead, and a caller spreads the one definition rather than re-declaring the colours, which is
 * what keeps every "primary" button in the editor the same shade.
 */
export const button = stylex.create({
  primary: {
    backgroundColor: '#22406e',
    borderColor: '#35619f',
  },
  link: {
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    color: color.muted,
  },
});
