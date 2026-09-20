import * as stylex from '@stylexjs/stylex';
import { color, controlSize, space } from './tokens.stylex.js';

/**
 * The light theme.
 *
 * The same neutral, zero-chroma system as the dark tokens, with lightness inverted rather than
 * re-designed: the reference editor's light palette is shadcn's, so these are its `oklch` values in
 * sRGB hex, the way `tokens.stylex.ts` does it. Three things change besides the obvious inversion:
 *
 * 1. **Borders and washes turn to translucent black.** A `white/10%` line disappears on a white
 *    panel; `black/10%` composites onto a light surface exactly as the white one did onto a dark one.
 * 2. **Shadows go lighter.** A layer floating over a light surface is lifted by a soft grey shadow,
 *    not a black one — at `0.5` black it looks torn out of the page.
 * 3. **The danger tints darken.** Pale red text on a pale surface has no contrast; the light theme
 *    uses a deep red ink on a faint pink wash instead.
 *
 * Applied at the studio root as a `stylex.createTheme`, so every `color.*` read anywhere below it
 * resolves to these values. `styles.css` mirrors the same values under `:root[data-theme='light']`
 * for the element defaults that plain CSS owns.
 */
export const lightTheme = stylex.createTheme(color, {
  /** `oklch(1 0 0)` — white, like theirs. */
  bg: '#ffffff',
  panel: '#ffffff',
  /** `oklch(0.97 0 0)`. */
  'panel-2': '#f5f5f5',
  /** `oklch(0.94 0 0)` — the hover fill. */
  surface: '#ebebeb',
  /** `oklch(0.985 0 0)` — a well, barely off white. */
  sunken: '#fafafa',
  elevated: '#ffffff',

  line: '#e5e5e5',
  border: 'rgba(0, 0, 0, 0.1)',
  'border-input': 'rgba(0, 0, 0, 0.15)',
  'border-strong': 'rgba(0, 0, 0, 0.25)',

  /** `oklch(0.145 0 0)` — 17:1 on white. */
  text: '#0a0a0a',
  /** `oklch(0.556 0 0)` — 5.9:1 on white. */
  muted: '#737373',
  /** 4.5:1 on white, matching the dark `dim`'s ratio: field labels and hints must stay legible. */
  dim: '#767676',

  /** Their light `primary`: near-black fill with white text. `oklch(0.205 0 0)`. */
  primary: '#171717',
  'primary-ink': '#fafafa',
  'primary-hover': '#292929',
  'primary-active': '#333333',
  'surface-hover': '#e0e0e0',

  wash: 'rgba(0, 0, 0, 0.05)',
  'wash-strong': 'rgba(0, 0, 0, 0.1)',

  ring: '#a3a3a3',
  'ring-soft': 'rgba(115, 115, 115, 0.5)',

  'border-faint': 'rgba(0, 0, 0, 0.08)',
  field: 'rgba(0, 0, 0, 0.035)',
  'field-border': 'rgba(0, 0, 0, 0.075)',

  overlay: 'rgba(255, 255, 255, 0.92)',
  'overlay-soft': 'rgba(255, 255, 255, 0.72)',
  scrim: 'rgba(0, 0, 0, 0.35)',
  'selection-wash': 'rgba(23, 23, 23, 0.1)',

  shadow: 'rgba(0, 0, 0, 0.18)',
  'shadow-soft': 'rgba(0, 0, 0, 0.1)',

  /** `oklch(0.577 0.245 27.325)` — their light `destructive`. */
  danger: '#e7000b',
  'danger-ink': '#a10008',
  'danger-border': 'rgba(231, 0, 11, 0.35)',
  'danger-wash': 'rgba(231, 0, 11, 0.08)',
  'danger-wash-soft': 'rgba(231, 0, 11, 0.05)',
  'danger-surface': 'rgba(255, 235, 235, 0.96)',
  'danger-text': '#7a0006',
  warn: '#a16207',
  ok: '#15803d',
});

/**
 * The comfortable density: the same scale, one step up.
 *
 * Every control height gains 4px and the spacing ladder widens from `md` upward, so the change
 * reads as "more room" rather than "bigger type". The font scale is left alone on purpose: a larger
 * font at the same control height is what makes text clip, and a larger font *and* a taller control
 * is a different design, not a denser or sparser one. The rail is not touched either — it is a
 * fixed-width column the layout is measured against, and widening it would move the stage.
 */
export const comfortableControls = stylex.createTheme(controlSize, {
  xs: '32px',
  sm: '36px',
  md: '40px',
  row: '28px',
});

export const comfortableSpace = stylex.createTheme(space, {
  md: '10px',
  lg: '14px',
  xl: '20px',
});
