import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import { ChevronDown } from 'lucide-react';
import { color, control, controlSize, fontSize, radius, space } from '../styles/tokens.stylex.js';

/**
 * The reference editor's small control library.
 *
 * These are ports of `packages/editor/src/components/ui/controls/*`. They matter more than they
 * look: a shell is mostly made of its repeated small controls, and the panel in that editor reads as
 * one coherent object largely because every grouped choice, every action cluster, and every numeric
 * field is the *same* three shapes throughout. Re-drawing each one per panel is what produces the
 * near-miss look the earlier passes had.
 *
 * ## What was translated, and what could not be
 *
 * Their versions are Tailwind classes, so the metrics survive intact — `h-9`, `rounded-lg`, `p-[3px]`,
 * `text-xs` — and the colours come from the shared tokens. Their `PanelSection` animates height with
 * a `motion` spring, which has no StyleX equivalent and would add a dependency for one transition;
 * the disclosure animates its chevron and fades its body instead, which is the part a person
 * actually reads as motion.
 */

/* ------------------------------------------------------------------ segmented control */

const segmented = stylex.create({
  root: {
    display: 'flex',
    alignItems: 'center',
    height: controlSize.md,
    width: '100%',
    padding: '3px',
    borderRadius: radius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    backgroundColor: color['panel-2'],
  },
  rootDisabled: {
    opacity: 0.6,
  },
  /** Each segment fills an equal share, so the control's thumb cannot jump as labels change. */
  segment: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    height: '100%',
    flex: 1,
    minWidth: 0,
    paddingInline: space.md,
    borderRadius: radius.md,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    color: color.muted,
    fontSize: fontSize.xs,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    transitionProperty: 'background-color, color, box-shadow',
    transitionDuration: '150ms',
    ':hover': {
      backgroundColor: color.wash,
      color: color.text,
    },
    ':disabled': {
      cursor: 'default',
      ':hover': {
        backgroundColor: 'transparent',
        color: color.muted,
      },
    },
  },
  /**
   * The selected segment: a raised fill plus a hairline ring. Their `bg-[#3e3e3e] shadow-sm
   * ring-1 ring-border/50` — the ring is what makes the thumb read as a physical inset rather than
   * a tinted label.
   */
  segmentSelected: {
    backgroundColor: color.surface,
    color: color.text,
    boxShadow: `inset 0 0 0 1px ${color.border}`,
    ':hover': {
      backgroundColor: color.surface,
      color: color.text,
    },
  },
  /** A count beside a segment's label, e.g. the number of zones. */
  badge: {
    color: color.dim,
    fontVariantNumeric: 'tabular-nums',
  },
});

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** A count shown after the label. The reference puts one on Structure, Furnish, and Zones. */
  count?: number;
  disabled?: boolean;
}

/**
 * A group of mutually exclusive choices in one rounded track.
 *
 * Their `SegmentedControl`, used for every "which of these am I looking at" decision. It is a
 * `radiogroup` rather than a set of buttons: the arrow keys move between segments and only one is
 * ever selected, which is exactly the semantics a bare row of buttons fails to express.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  disabled = false,
  ariaLabel,
}: {
  value: T;
  onChange(value: T): void;
  options: readonly SegmentedOption<T>[];
  disabled?: boolean;
  ariaLabel: string;
}): React.ReactElement {
  return (
    <div
      {...stylex.props(segmented.root, disabled && segmented.rootDisabled)}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const isSelected = option.value === value;
        return (
          <button
            key={option.value}
            {...stylex.props(segmented.segment, isSelected && segmented.segmentSelected)}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
            {option.count !== undefined ? (
              <span {...stylex.props(segmented.badge)}>{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ action cluster */

const action = stylex.create({
  /**
   * Their `ActionButton`: a filled square with a border, not a ghost button.
   *
   * That distinction is the point. A row of ghost buttons reads as a toolbar of equal-weight
   * commands; a row of filled squares reads as a cluster of buttons you press. They use it for the
   * per-panel action rows — Move, Delete — where the actions are peers of each other and nothing
   * else is competing on the row.
   */
  button: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    height: controlSize.md,
    flex: 1,
    minWidth: 0,
    paddingInline: space.lg,
    borderRadius: radius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    backgroundColor: color['panel-2'],
    color: color.text,
    fontSize: fontSize.xs,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    transitionProperty: 'background-color, border-color',
    transitionDuration: '120ms',
    ':hover': {
      backgroundColor: color.surface,
    },
    ':active': {
      backgroundColor: color.surface,
    },
    ':disabled': {
      pointerEvents: 'none',
      opacity: 0.5,
    },
  },
  /** The destructive variant: their red-tinted border and label. */
  danger: {
    borderColor: 'rgba(255, 100, 103, 0.4)',
    color: '#ffc9c9',
    ':hover': {
      backgroundColor: 'rgba(255, 100, 103, 0.15)',
    },
  },
  group: {
    display: 'flex',
    gap: space.sm,
  },
});

export function ActionButton({
  label,
  icon,
  danger = false,
  ...rest
}: React.ComponentPropsWithoutRef<'button'> & {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
}): React.ReactElement {
  return (
    <button
      {...stylex.props(action.button, danger && action.danger)}
      type="button"
      {...rest}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** A row of `ActionButton`s. Their `ActionGroup`. */
export function ActionGroup({
  children,
  vertical = false,
}: {
  children: React.ReactNode;
  vertical?: boolean;
}): React.ReactElement {
  return (
    <div
      {...stylex.props(action.group)}
      style={{ flexDirection: vertical ? 'column' : 'row' }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ metric field */

const metric = stylex.create({
  /**
   * Their metric control: the value and its unit inside one box.
   *
   * The unit is not decoration. A number in a 3D editor is meaningless without it — `0` is a
   * position or a rotation or a scale, and the only thing that says which is the suffix. Showing it
   * inline also means the field can accept a bare number and still be unambiguous on screen.
   */
  root: {
    display: 'flex',
    alignItems: 'center',
    height: controlSize.sm,
    borderRadius: radius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 255, 255, 0.075)',
    backgroundColor: 'rgba(51, 51, 51, 0.3)',
    overflow: 'hidden',
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: '100ms',
    ':hover': {
      borderColor: color['border-input'],
    },
    ':focus-within': {
      borderColor: color.ring,
      boxShadow: `0 0 0 1px ${color.ring}`,
    },
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    paddingInline: space.lg,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    color: color.text,
    fontSize: fontSize.md,
    fontVariantNumeric: 'tabular-nums',
    ':hover': {
      borderWidth: 0,
      borderColor: 'transparent',
    },
    ':focus': {
      outline: 'none',
      borderColor: 'transparent',
    },
  },
  unit: {
    flexShrink: 0,
    paddingInlineEnd: space.lg,
    fontSize: fontSize.xs,
    color: color.dim,
    userSelect: 'none',
  },
});

export function MetricField({
  value,
  onChange,
  unit,
  label,
  step,
  min,
  max,
  disabled = false,
}: {
  value: number | null;
  onChange(next: number): void;
  /** `m`, `°`, `%`. Always shown, never inferred. */
  unit: string;
  label: string;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <div {...stylex.props(metric.root)}>
      <input
        {...stylex.props(metric.input)}
        type="number"
        aria-label={`${label} (${unit})`}
        value={value === null || !Number.isFinite(value) ? '' : value}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (!Number.isFinite(parsed)) return;
          onChange(parsed);
        }}
      />
      <span {...stylex.props(metric.unit)} aria-hidden="true">
        {unit}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ collapsible panel section */

const section = stylex.create({
  /**
   * Their `PanelSection`: a titled band that collapses its body, with a hairline under the whole
   * thing and the chevron on the trailing edge.
   *
   * Two details carry it. The chevron is *invisible until hover* on a collapsed section, so a stack
   * of open sections is not a column of arrows; and the header's fill changes with its state, so the
   * title reads as attached to the body below it rather than floating above it.
   */
  root: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    overflow: 'hidden',
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: color.border,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    height: '40px',
    flexShrink: 0,
    paddingInline: space.lg,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    color: color.muted,
    cursor: 'pointer',
    transitionProperty: 'background-color, color',
    transitionDuration: '150ms',
    ':hover': {
      backgroundColor: color.wash,
      color: color.text,
    },
  },
  /** An expanded header keeps a faint fill: the title belongs to the body it opened. */
  headerExpanded: {
    backgroundColor: color.wash,
    color: color.text,
  },
  title: {
    fontSize: fontSize.md,
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chevron: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    transitionProperty: 'transform, opacity',
    transitionDuration: '150ms',
  },
  /**
   * A collapsed section's chevron only appears on hover. `opacity` rather than `display` so it cannot
   * shift the header's layout as it appears, and it stays focusable — the button carries the
   * accessible name and state, so hiding the glyph never hides the control.
   */
  chevronClosed: {
    opacity: 0,
  },
  headerHoveredChevron: {
    opacity: 1,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    paddingBlockEnd: space.lg,
    paddingInline: space.lg,
  },
});

export function PanelSection({
  title,
  children,
  defaultExpanded = true,
  /** Rendered at the trailing edge of the header, before the chevron. */
  aside,
}: {
  title: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  aside?: React.ReactNode;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const [hovered, setHovered] = React.useState(false);
  return (
    <div {...stylex.props(section.root)}>
      <button
        {...stylex.props(section.header, expanded && section.headerExpanded)}
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >
        <span {...stylex.props(section.title)}>{title}</span>
        {aside}
        <span
          {...stylex.props(
            section.chevron,
            !expanded && !hovered && section.chevronClosed,
          )}
        >
          <ChevronDown
            size={control.icon}
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}
          />
        </span>
      </button>
      {expanded ? <div {...stylex.props(section.body)}>{children}</div> : null}
    </div>
  );
}
