import * as stylex from '@stylexjs/stylex';

/**
 * The editor's design tokens.
 *
 * ## Where these values come from
 *
 * This palette and scale are a port of the design system in
 * [`pascalorg/editor`](https://github.com/pascalorg/editor) (MIT, Copyright (c) 2026 Pascal Group
 * Inc.) — see `THIRD_PARTY_NOTICES.md`. That project is the reference for what this editor should
 * look and feel like, so its values are adopted deliberately and wholesale rather than re-derived:
 * the point of a port is to match, and "close enough" is how the previous attempt ended up reading
 * as a generic dark theme.
 *
 * Their tokens are shadcn/ui's defaults on Tailwind v4, authored in `oklch`. StyleX's value
 * handling rejects some modern colour functions outright (`color-mix()` fails the compiler with
 * "Rule contains an unclosed function"), so every value here is the **sRGB hex equivalent** of
 * their `oklch` triple. The `oklch` source is in the comment beside each one, which is what keeps
 * the two comparable when their palette moves.
 *
 * The imported system is *not* generic. Three properties do most of the work:
 *
 * 1. **The chrome is strictly neutral.** Every surface is zero-chroma grey. There is no accent hue
 *    anywhere in the UI furniture — no blue focus ring, no amber active state. Emphasis comes from
 *    lightness instead: `#fafafa` on `#171717` is 16:1, and a hovered row is simply lighter than a
 *    resting one.
 * 2. **Foreground text is near-white, not grey.** `#fafafa`, not a bluish `#e9eaec`. Inspector
 *    values are the brightest thing on screen, which is what makes them scannable.
 * 3. **Borders are translucent white, not opaque grey.** A `white/10%` border composites against
 *    whatever surface it sits on, so one token reads correctly on the stage, on a panel, and on a
 *    popover. An opaque grey border has to be re-picked per surface.
 *
 * The one place a hue could appear is `primary`, and it does not: their default button is a
 * near-white fill with dark text, not a coloured one.
 */

/** Surfaces, lines, text, and status colours. */
export const color = stylex.defineVars({
  /** The app backdrop and the 3D stage. `oklch(0.205 0 0)`. */
  bg: '#171717',
  /** Panels and popovers. Same value as `bg` in their dark theme. `oklch(0.205 0 0)`. */
  panel: '#171717',
  /** A raised surface: toolbar, panel header. One step up. `oklch(0.249 0 0)`. */
  'panel-2': '#292929',
  /** The hover/selected fill, and the resting fill of a field. `oklch(0.269 0 0)`. */
  surface: '#333333',
  /** A sunken fill for wells and inset rows. `oklch(0.145 0 0)`. */
  sunken: '#0f0f0f',
  /** A raised popover, one step above a panel. `oklch(0.235 0 0)`. */
  elevated: '#272727',

  /** Opaque hairline, for the places a translucent border cannot reach (canvas overlays). */
  line: '#333333',
  /** `white/10%` — the standard border on every card, panel, menu, and separator. */
  border: 'rgba(255, 255, 255, 0.1)',
  /** `white/15%` — the border of a control that has to read as an input. */
  'border-input': 'rgba(255, 255, 255, 0.15)',
  /** A border at hover, one step brighter. */
  'border-strong': 'rgba(255, 255, 255, 0.2)',

  /** Primary text and inspector values. `oklch(0.985 0 0)` — 16.4:1 on `bg`. */
  text: '#fafafa',
  /** Field labels and secondary text. `oklch(0.708 0 0)` — 7.3:1 on `bg`. */
  muted: '#b4b4b4',
  /** A third tier for hints and placeholders. `oklch(0.556 0 0)` — 4.4:1, non-essential text only. */
  dim: '#8a8a8a',

  /** The inverted fill: near-white background with dark text. `oklch(0.922 0 0)` on `oklch(0.205 0 0)`. */
  primary: '#e8e8e8',
  'primary-ink': '#171717',

  /** `white/5%` — the wash on a value cell that is being hovered. */
  wash: 'rgba(255, 255, 255, 0.05)',
  /** `white/10%` — a hovered row, or a pressed button. */
  'wash-strong': 'rgba(255, 255, 255, 0.1)',

  /** The focus ring. Neutral, like theirs. `oklch(0.556 0 0)`. */
  ring: '#8a8a8a',

  /** Status only. These never appear in ordinary chrome. */
  danger: '#ff6467',
  warn: '#e8b04b',
  ok: '#77b892',
});

/**
 * Spacing scale.
 *
 * A 2px ladder matching the Tailwind steps their components are written against (`px-3` is 12px,
 * `py-1.5` is 6px, `gap-2` is 8px). The names are the editor's; the values are theirs.
 */
export const space = stylex.defineVars({
  xxs: '2px',
  xs: '4px',
  sm: '6px',
  md: '8px',
  lg: '12px',
  xl: '16px',
});

/**
 * Corner radii.
 *
 * Tailwind's scale, since their components use it: `rounded-sm` 4px, `rounded-md` 6px,
 * `rounded-lg` 8px, `rounded-xl` 10px.
 */
export const radius = stylex.defineVars({
  sm: '4px',
  md: '6px',
  lg: '8px',
  xl: '10px',
  pill: '999px',
});

/**
 * Type scale.
 *
 * Their components are `text-xs` (12px), `text-sm` (14px), and `text-base` (16px). This ladder
 * keeps those steps and adds `micro` for the tracked uppercase labels their panel headers and
 * section titles use.
 */
export const fontSize = stylex.defineVars({
  micro: '10px',
  xs: '12px',
  sm: '13px',
  md: '14px',
  lg: '16px',
  xl: '18px',
});

/**
 * The typeface.
 *
 * Their UI is set in **Barlow**, and so is this one now. The reference fetches it from Google Fonts;
 * this editor is local-first and an export must not depend on a network font, so the 400 and 500
 * weights are self-hosted from `@fontsource/barlow` (OFL-1.1) and imported in `src/editor/main.tsx`.
 * Vite fingerprints them into the build, and a check confirms the page makes no external request.
 *
 * The stack still names the system UI faces after Barlow. That is not decoration: it is what makes a
 * font that fails to load a degradation rather than a broken layout.
 */
export const fontFamily = stylex.defineVars({
  sans: 'Barlow, Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
});

/**
 * Control geometry, as numbers.
 *
 * These are plain numbers rather than `defineVars` custom properties because they are consumed by
 * JavaScript as well as by styles — an icon's `size` prop, an SVG's width. A custom property is a
 * string and would have to be parsed back out at every call site.
 *
 * The consequence is that a *length* in a `stylex.create` rule must be written as a literal, not
 * read from here: StyleX resolves its own variables, and a value it cannot resolve is dropped from
 * the emitted CSS silently. `control.rail` used as a `width` produced no declaration at all, and the
 * rail sized itself from its content — 37px instead of 56px. Anything that needs a tokenised length
 * uses `defineVars` below.
 */
export const control = {
  /** `h-7` — the editor's compact control: toolbar buttons and panel actions. */
  xs: '28px',
  /** `h-8` — the compact control: toolbar buttons, icon buttons, the scrub field. */
  sm: '32px',
  /** `h-9` — the default control: buttons and inputs in forms and menus. */
  md: '36px',
  /** `size-4` — the icon size inside a button. */
  icon: 16,
  /** `size-3.5` — a menu item's tick, a tree row's glyph. */
  iconSm: 14,
  /** The left icon rail in their layout. */
  rail: '56px',
} as const;

/**
 * The control lengths that styles need, as real custom properties.
 *
 * StyleX emits these as `--control-rail` and resolves them inside `stylex.create`, so a rule can
 * reference a named length and still get a declaration out the other side.
 */
export const controlSize = stylex.defineVars({
  rail: '56px',
  xs: '28px',
  sm: '32px',
  md: '36px',
  row: '24px',
  /** The reserved trailing lane in a tree row. */
  lane: '112px',
});

/**
 * The geometry the floating overlays on the stage share.
 *
 * `gizmo` is the view gizmo's ball and `lane` is the column it occupies once its gutters are counted,
 * measured from the stage's trailing edge. The hint card centres itself in what is left rather than
 * in the stage as a whole: centred on the stage, its 460px reached 223px underneath the control that
 * occupies that corner and was painted over mid-sentence.
 *
 * The two are one token pair rather than two literals because they have to agree — a ball that
 * changes size without its lane changing is the same bug again. `lane` also has to cover the overlays
 * button in the same column, which is narrower than the ball.
 */
export const overlay = stylex.defineVars({
  gizmo: '92px',
  lane: '116px',
  card: '460px',
});

/**
 * The gizmo's ball size as a number, for the arithmetic that places its six handles.
 *
 * The same split as `control` and `controlSize`: a handle's position is `centre ± radius`, computed in
 * JavaScript from the camera's basis every frame, and a custom property is a string that would have to
 * be parsed back out. `overlay.gizmo` and this must agree.
 */
export const GIZMO_SIZE = 92;

/**
 * Shared button treatments.
 *
 * Their `buttonVariants`, reduced to the four variants this editor actually uses. `primary` is the
 * near-white fill — their "default" — and is the strongest signal available in a monochrome
 * chrome, so it stays rare: Play, and creating a project.
 *
 * Every variant carries their focus treatment: a 3px ring at 50% opacity, on `:focus-visible` only.
 */
export const button = stylex.create({
  /** Near-white fill, dark text. Their `variant: default`. */
  primary: {
    backgroundColor: color.primary,
    color: color['primary-ink'],
    borderWidth: 0,
    borderStyle: 'none',
    fontWeight: 500,
    ':hover': {
      backgroundColor: '#dcdcdc',
    },
    ':active': {
      backgroundColor: '#c9c9c9',
    },
  },
  /** A bordered, transparent control. Their `variant: outline`. */
  outline: {
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color['border-input'],
    color: color.text,
    ':hover': {
      backgroundColor: color.wash,
      borderColor: color['border-strong'],
    },
  },
  /** A filled control with no border. Their `variant: secondary`. */
  secondary: {
    backgroundColor: color.surface,
    borderWidth: 0,
    borderStyle: 'none',
    color: color.text,
    ':hover': {
      backgroundColor: '#3d3d3d',
    },
  },
  /** No chrome at rest, a wash on hover. Their `variant: ghost`, and the editor's workhorse. */
  ghost: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    color: color.muted,
    ':hover': {
      backgroundColor: color.wash,
      color: color.text,
    },
  },
  /** A text-only control. Their `variant: link`. */
  link: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    color: color.muted,
    paddingInline: 0,
    ':hover': {
      color: color.text,
    },
  },
  /**
   * The one geometry every variant shares: their `h-8` / `gap-1.5` / `rounded-md` / `text-sm`, plus
   * the 3px focus ring. Composed at the call site beside a variant, since StyleX cannot spread one
   * `stylex.create` style inside another.
   */
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    height: control.xs,
    paddingInline: space.md,
    borderRadius: radius.md,
    fontSize: fontSize.sm,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    cursor: 'pointer',
    transitionProperty: 'background-color, border-color, color',
    transitionDuration: '120ms',
    ':focus-visible': {
      outlineWidth: '3px',
      outlineStyle: 'solid',
      outlineColor: 'rgba(138, 138, 138, 0.5)',
      outlineOffset: '0px',
    },
    ':disabled': {
      pointerEvents: 'none',
      opacity: 0.5,
    },
  },
  /**
   * A 22px square, for a control that lives inside a dense list row.
   *
   * The tree's per-row toggles need this. A 32px control dropped into a 22px slot overflowed by
   * 10px into the name beside it, so a click aimed at the name landed on a toggle — the row
   * silently locked itself and pushed an `editor:*` entry onto the undo stack after whatever edit
   * the user had just made.
   *
   * It is a separate style rather than a descendant override on the slot, because StyleX has no
   * descendant selector: `& > button` fails the compiler with "Invalid pseudo or at-rule".
   */
  rowBase: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '22px',
    width: '22px',
    paddingInline: 0,
    borderRadius: '4px',
    flexShrink: 0,
    cursor: 'pointer',
    transitionProperty: 'background-color, color',
    transitionDuration: '120ms',
    ':disabled': {
      pointerEvents: 'none',
      opacity: 0.45,
    },
  },
  /** A square icon-only control at the same height as `base`. */
  iconBase: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: control.xs,
    width: control.xs,
    paddingInline: 0,
    borderRadius: radius.md,
    flexShrink: 0,
    cursor: 'pointer',
    transitionProperty: 'background-color, color',
    transitionDuration: '120ms',
    ':focus-visible': {
      outlineWidth: '3px',
      outlineStyle: 'solid',
      outlineColor: 'rgba(138, 138, 138, 0.5)',
      outlineOffset: '0px',
    },
    ':disabled': {
      pointerEvents: 'none',
      opacity: 0.5,
    },
  },
});

/**
 * Repeated surface treatments.
 *
 * Their `rounded-md border bg-popover p-1 shadow-md` for a floating layer, and the equivalent for a
 * menu row. Defined once so a dropdown, a select, and a popover cannot drift apart.
 */
export const surface = stylex.create({
  /**
   * A workspace region: the hierarchy column, the inspector column, the bottom panel.
   *
   * Deliberately **not** rounded and **not** self-bordered. The three columns plus the bottom panel
   * are laid out with no gap, so each region contributes only the edges it actually has — a single
   * hairline between neighbours rather than two lines 1px apart. Which edges a given region owns is
   * the caller's decision, because it depends on where the region sits in the grid.
   */
  panel: {
    backgroundColor: color.panel,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  /** A horizontal hairline at the bottom of a region: the toolbar, a column, the bottom panel. */
  edgeBottom: {
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: color.border,
  },
  /** A vertical hairline on the trailing edge of the left column. */
  edgeEnd: {
    borderInlineEndWidth: '1px',
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: color.border,
  },
  /** A vertical hairline on the leading edge of the inspector column. */
  edgeStart: {
    borderInlineStartWidth: '1px',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: color.border,
  },
  /**
   * A floating layer: dropdown menu, select content, popover.
   *
   * Unlike a panel this *is* rounded, bordered on all sides, and carries a shadow — it floats over
   * the workspace rather than dividing it, and the shadow is what says so.
   */
  menu: {
    backgroundColor: color.elevated,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.border,
    borderRadius: radius.md,
    padding: space.xs,
    minWidth: '128px',
    overflowY: 'auto',
    overflowX: 'hidden',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -2px rgba(0, 0, 0, 0.4)',
    zIndex: 50,
  },
  /**
   * A menu row: their `rounded-sm px-2 py-1.5 text-sm`, with the glyph muted and the label bright.
   * Their `[&_svg]` descendant rules are not expressible in StyleX, so an icon inside a menu row is
   * given its colour by the row and its size by the caller.
   */
  menuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radius.sm,
    paddingBlock: space.sm,
    paddingInline: space.md,
    color: color.text,
    fontSize: fontSize.md,
    textAlign: 'left',
    cursor: 'default',
    userSelect: 'none',
    ':hover': {
      backgroundColor: color.surface,
    },
  },
  /** The label slot of a menu row, so an icon-bearing row and a plain one align. */
  menuItemLabel: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** A group label inside a menu. */
  menuLabel: {
    paddingBlock: space.xs,
    paddingInline: space.md,
    fontSize: fontSize.micro,
    fontWeight: 600,
    letterSpacing: '0.09em',
    textTransform: 'uppercase',
    color: color.dim,
  },
  /** The 1px divider their `Separator` renders. */
  separator: {
    height: '1px',
    width: '100%',
    flexShrink: 0,
    backgroundColor: color.border,
  },
  separatorVertical: {
    width: '1px',
    height: '100%',
    flexShrink: 0,
    backgroundColor: color.border,
  },
});

/**
 * The tracked uppercase micro-label.
 *
 * Used for panel headers, section headings, and menu group labels so they all agree. At 10px, mixed
 * case is unreadable; tracked uppercase reads as structure without needing a rule or a filled band.
 */
export const microLabel = stylex.create({
  base: {
    fontSize: fontSize.micro,
    fontWeight: 600,
    letterSpacing: '0.09em',
    textTransform: 'uppercase',
    color: color.dim,
  },
});
