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
 *
 * ## The palette is deliberately near-monochrome
 *
 * Every surface is a true neutral — no blue cast. The earlier palette tinted `bg`, `panel`, and
 * `line` blue and spent a saturated blue on the accent, which is what made the editor read as a
 * stock dark theme rather than a tool with a point of view. Here the *only* chromatic values are
 * the accent and the three status colours, so an amber pixel always means "this is live" and a
 * green pixel always means "this succeeded".
 *
 * Warmth lives in the accent rather than in the surfaces. A warm-tinted surface (brown-black)
 * reads as muddy at this size and fights the viewport, which is the one region that should look
 * like the game. Keeping the metal cool and the indicator warm is what makes the accent read.
 */

/**
 * Surfaces, lines, text, and status colours.
 *
 * The surface ramp is a four-step neutral scale. Each step is a fixed lightness increment rather
 * than a hand-picked colour, so a new surface has an obvious next value instead of an inviting
 * guess. `panel` is the resting panel, `panel-2` is a panel header or the toolbar (one step
 * brighter, because it sits above content), and `elevated` is for things that float over the
 * editor — menus and popovers.
 *
 * `dim` is a third text tier. The old palette had only `text` and `muted`, which forced empty
 * states, timestamps, and disabled text to all claim the same weight as a real label.
 */
export const color = stylex.defineVars({
  /** The app backdrop behind the panel gutter. Deliberately darker than any panel. */
  bg: '#08090a',
  /** The resting panel surface. */
  panel: '#121316',
  /** Panel headers and the toolbar: one step above content. */
  'panel-2': '#17181c',
  /** Menus and popovers, which must separate from the panel beneath them. */
  elevated: '#1e2024',
  /** Hairline borders and the grid gap that acts as a divider. */
  line: '#26272c',
  /** A border that has to be visible against `line`: hover, focus-within, drag targets. */
  'line-strong': '#3a3c43',

  text: '#e9eaec',
  muted: '#a8aab1',
  /**
   * The quiet tier: metadata, timestamps, section labels, and icon strokes.
   *
   * Chosen by measuring, not by eye. The first attempt was `#6e7076`, which looked right on a panel
   * and failed everything else — 3.58:1 on the toolbar surface, where the save indicator actually
   * lives. `#8c8f96` is the darkest value that clears 4.5:1 against the *lightest* surface in the
   * palette, so one token is safe everywhere and no call site has to reason about which background
   * it will land on.
   *
   * The three text tiers are therefore `text` (values, 15:1), `muted` (labels, 7:1), and this
   * (metadata and glyphs, 5.5:1). All three are legible; the difference between them is emphasis,
   * never whether the text can be read.
   */
  dim: '#8c8f96',


  /**
   * The one accent: warm amber.
   *
   * Reserved for genuine state — the active tool, the selected row, focus rings, a live play
   * session. It is never decorative, which is what lets a single hue carry "where am I" across the
   * whole editor without a second colour being needed for emphasis.
   */
  accent: '#e0a458',
  /** A darker amber for selected fills, where full accent behind text would glare. */
  'accent-quiet': '#4a3a22',
  /**
   * Near-black, for text that sits *on* the accent. Hardcoded rather than reusing `bg`, because it
   * is a contrast requirement of the accent, not a surface.
   */
  'accent-ink': '#1a1408',

  danger: '#e06c5f',
  warn: '#d9a441',
  ok: '#77b892',

  /**
   * Translucent white, for a hover or pressed wash over *any* surface.
   *
   * These are tokens rather than `color-mix(in srgb, ...)` at each call site for a concrete reason:
   * a `color-mix()` string is an opaque literal to StyleX's type layer, and the same wash has to be
   * expressible in both `stylex.create` and the plain `button` rule in `styles.css`. Naming the two
   * steps means the element default and a component override cannot drift to different strengths.
   *
   * White over a neutral is a *lift*, which is what a hover should be. `stroke` is the hairline that
   * appears on a hovered surface, one step brighter than `line`.
   */
  wash: 'rgba(255, 255, 255, 0.055)',
  'wash-strong': 'rgba(255, 255, 255, 0.09)',
  stroke: 'rgba(255, 255, 255, 0.12)',
});

/**
 * Spacing scale.
 *
 * These are the values the stylesheet already repeats by hand; naming them is what makes the
 * "one hardcoded hex or pixel count off the scale" class of drift visible in review.
 *
 * `md` moved 10px -> 12px and `lg` 16px -> 20px so the scale is a clean 4px ladder; the old values
 * put 10 next to 16 with nothing between them, which is why panel padding ended up hand-written as
 * 8/12/14/24 across four different files.
 */
export const space = stylex.defineVars({
  xxs: '2px',
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '20px',
});

/** Corner radii. */
export const radius = stylex.defineVars({
  /** Checkboxes, tags, and the smallest inline chips. */
  sm: '4px',
  /** Buttons, inputs, selects — everything the pointer lands on. */
  md: '6px',
  /** Panels, cards, menus. */
  lg: '10px',
  pill: '999px',
});

/**
 * Type scale.
 *
 * The editor is a dense tool, so the range is deliberately narrow — hierarchy comes from weight
 * and tracking, not from size. The roles:
 *
 * - `micro` (10px) is a section label. Uppercase and tracked, which is what lets it organise a
 *   panel *without* a rule or a filled band announcing it.
 * - `xs` (11px) is metadata: counts, timestamps, the save indicator.
 * - `sm` (12px) is the workhorse — field labels, tree rows, buttons, log lines.
 * - `md` (13px) is a value the user is reading or editing, and panel titles.
 * - `lg` (16px) is the project home heading.
 */
export const fontSize = stylex.defineVars({
  micro: '10px',
  xs: '11px',
  sm: '12px',
  md: '13px',
  lg: '16px',
});

/**
 * The editor's one font stack.
 *
 * StyleX has no `font:` shorthand, so the stack is a token and the size/weight are set separately.
 * The stack gained `Inter` ahead of the system faces: it is preinstalled on macOS, which is where
 * the editor is developed, and it degrades to the same system stack everywhere else. No webfont is
 * loaded, so an export and an offline editor start identically.
 */
export const fontFamily = stylex.defineVars({
  sans: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
});

/**
 * Shared control treatments.
 *
 * These were `.primary` and `.link` in `base.css`, written as `button.primary` / `button.link`.
 * A class-qualified element selector has specificity (0,1,1), which outranks one atomic class
 * (0,1,0) — so leaving them in the stylesheet would mean StyleX silently losing. They live here
 * instead, and a caller spreads the one definition rather than re-declaring the colours, which is
 * what keeps every "primary" button in the editor the same shade.
 *
 * `primary` is now an accent *fill* rather than a blue-tinted outline, because on a monochrome
 * chrome the one filled control in a region is the strongest possible signal of "this is the
 * action". That is why it is used sparingly — Play in the toolbar, and the new-game button on the
 * project home.
 */
export const button = stylex.create({
  primary: {
    backgroundColor: color.accent,
    color: color['accent-ink'],
    borderWidth: 0,
    borderStyle: 'none',
    fontWeight: 600,
    ':hover': {
      backgroundColor: '#eeb268',
    },
    ':active': {
      backgroundColor: '#cf9448',
    },
  },
  link: {
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    color: color.muted,
    ':hover': {
      color: color.text,
    },
  },
  /**
   * A control that reads as text until the pointer is near it — the project name in the toolbar,
   * the row affordances in the hierarchy. The affordance appears on hover rather than the control
   * carrying a permanent outline, which is what stops the chrome from looking like a form.
   */
  ghost: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    color: color.text,
  },
});

/**
 * Repeated surface treatments, defined once so the panels cannot drift.
 *
 * A panel and a card are the same object seen at two scales: a rounded surface with a hairline on
 * the app backdrop. Both are spelled here rather than in each panel, so "what is a panel" has one
 * answer in the codebase.
 */
export const surface = stylex.create({
  /** A region of the workspace: hierarchy, viewport, inspector, bottom panel. */
  panel: {
    backgroundColor: color.panel,
    borderRadius: radius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.line,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  /** A floating layer: the create menu, the component menu, an overflow menu. */
  menu: {
    backgroundColor: color.elevated,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.line,
    borderRadius: radius.lg,
    padding: space.xs,
    display: 'flex',
    flexDirection: 'column',
    minWidth: '180px',
    boxShadow: '0 16px 40px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4)',
  },
  /**
   * One row of a floating menu, and the label band above a group of them.
   *
   * Both live here rather than in each menu because the create menu, the add-component menu, and
   * the toolbar overflow all render the same row; three copies is how they end up three heights.
   */
  menuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    textAlign: 'left',
    borderRadius: radius.md,
    paddingBlock: space.sm,
    paddingInline: space.sm,
    color: color.text,
    ':hover': {
      backgroundColor: color.wash,
    },
  },
  menuLabel: {
    paddingBlock: space.xs,
    paddingInline: space.sm,
  },
  /**
   * The uppercase micro-label used for every section heading.
   *
   * One definition so the Inspector, the hierarchy group, and a menu band all agree on what a
   * section heading looks like. The `letterSpacing` and `textTransform` are the whole trick: at 10px
   * a label is unreadable in mixed case, and tracked uppercase reads as structure at a glance with
   * no border and no filled band announcing it.
   */
  microLabel: {
    fontSize: fontSize.micro,
    fontWeight: 600,
    letterSpacing: '0.09em',
    textTransform: 'uppercase',
    color: color.dim,
  },
});
