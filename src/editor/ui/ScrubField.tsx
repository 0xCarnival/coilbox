import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { color, fontFamily, fontSize, radius, space } from '../styles/tokens.stylex.js';

/**
 * The drag-to-scrub number field — the reference editor's signature control.
 *
 * This is the piece that does the most work in their inspector and the piece the previous version of
 * this editor was furthest from. A plain `<input type="number">` asks the user to select text, type,
 * and commit; a scrub field lets them drag horizontally across it and watch the value move, which is
 * how a transform gets tuned. Clicking the value still opens a real text input, so both motions work.
 *
 * ## Behaviour ported from their `NumberInput`
 *
 * - **Drag the label** to scrub. Shift multiplies the step by 10, Alt divides it by 10.
 * - **Click the value** to type. Enter and blur commit; Escape reverts.
 * - The value renders in mono with tabular figures so it does not jitter as it changes.
 * - `:focus-within` draws the ring, so the field reads as one control rather than a box around a box.
 *
 * ## What is deliberately different
 *
 * Their version pauses and resumes a global temporal store so a drag produces one history entry. This
 * editor's history is command-based: the caller passes `onCommitStart`/`onCommitEnd`, and `App`-level
 * coalescing turns the run of mid-drag changes into a single undo step. Keeping that policy with the
 * caller is what stops this component from knowing how undo works.
 */

export interface ScrubFieldProps {
  /** The field name shown at the left. Also the accessible name for the typed input. */
  label: string;
  value: number;
  onChange(value: number): void;
  /** Called once when a drag or an edit begins, and once when it ends. Used for undo coalescing. */
  onInteractionChange?(active: boolean): void;
  min?: number;
  max?: number;
  /** Decimal places shown and stored. */
  precision?: number;
  /** Units added per pixel of drag. Shift x10, Alt x0.1. */
  step?: number;
  disabled?: boolean;
  /** Omitted for a field with no label column of its own — a component inside a vector row. */
  hideLabel?: boolean;
}

const styles = stylex.create({
  /**
   * The field row. Their `flex items-center rounded-lg border`, with `focus-within` promoted to the
   * ring. The resting border is at 50% of the input border so a dense inspector does not read as a
   * grid of outlines; hover and focus bring it to full strength.
   */
  field: {
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    borderRadius: radius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 255, 255, 0.075)',
    backgroundColor: 'rgba(51, 51, 51, 0.3)',
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: '75ms',
    ':hover': {
      borderColor: 'rgba(255, 255, 255, 0.15)',
    },
    ':focus-within': {
      borderColor: color.ring,
      boxShadow: `0 0 0 1px ${color.ring}`,
    },
  },
  fieldDragging: {
    borderColor: color['border-strong'],
    boxShadow: `0 0 0 1px ${color.border}`,
  },
  fieldDisabled: {
    opacity: 0.5,
  },
  /**
   * The label doubles as the drag handle, so it is the affordance as well as the name: the
   * `ew-resize` cursor is what tells the user this can be dragged at all.
   */
  label: {
    flexShrink: 0,
    paddingBlock: space.sm,
    paddingInlineStart: space.md,
    paddingInlineEnd: space.xs,
    fontSize: fontSize.xs,
    fontWeight: 500,
    color: color.muted,
    cursor: 'ew-resize',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    transitionProperty: 'color',
    transitionDuration: '120ms',
    ':hover': {
      color: color.text,
    },
  },
  labelDragging: {
    color: color.text,
    cursor: 'ew-resize',
  },
  /** A spacer for a field with no label, so its value still lines up with its neighbours'. */
  labelEmpty: {
    width: space.md,
    flexShrink: 0,
  },
  /**
   * The value readout. Mono and tabular so digits do not shift width as the number changes — the
   * single detail that makes a scrub field feel like an instrument rather than a text box.
   */
  value: {
    flex: 1,
    minWidth: 0,
    paddingBlock: space.sm,
    paddingInline: space.md,
    textAlign: 'right',
    fontFamily: fontFamily.mono,
    fontSize: fontSize.md,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '-0.01em',
    color: color.text,
    cursor: 'text',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    borderRadius: radius.md,
    transitionProperty: 'background-color',
    transitionDuration: '120ms',
    ':hover': {
      backgroundColor: color.wash,
    },
  },
  /** The typed state replaces the readout in place, matching its metrics so nothing jumps. */
  input: {
    flex: 1,
    minWidth: 0,
    paddingBlock: space.sm,
    paddingInline: space.md,
    textAlign: 'right',
    fontFamily: fontFamily.mono,
    fontSize: fontSize.md,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
    color: color.text,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    outlineWidth: 0,
  },
  /** The axis chip that precedes a value in a vector row: `X`, `Y`, `Z`. */
  axis: {
    flexShrink: 0,
    paddingInlineStart: space.md,
    fontSize: fontSize.xs,
    fontWeight: 600,
    color: color.dim,
    userSelect: 'none',
  },
});

/** Round to the field's precision, so a drag cannot produce `0.30000000000000004`. */
function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export function ScrubField({
  label,
  value,
  onChange,
  onInteractionChange,
  min,
  max,
  precision = 2,
  step = 0.1,
  disabled = false,
  hideLabel = false,
}: ScrubFieldProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState('');
  const drag = useRef({ startX: 0, startValue: 0 });

  const clamp = useCallback(
    (candidate: number) => {
      if (min !== undefined && candidate < min) return min;
      if (max !== undefined && candidate > max) return max;
      return candidate;
    },
    [min, max],
  );

  const commit = useCallback(
    (candidate: number) => {
      const next = round(clamp(candidate), precision);
      if (next !== value) onChange(next);
    },
    [clamp, onChange, precision, value],
  );

  /**
   * The drag loop.
   *
   * Pointer capture is what makes this reliable: without it, a fast drag that outruns the cursor
   * leaves the element and the move events stop. The listeners live on `window` and are removed in
   * the effect cleanup, so a drag that ends outside the window still finishes.
   */
  const startDrag = useCallback(
    (event: React.PointerEvent) => {
      if (disabled || editing) return;
      event.preventDefault();
      drag.current = { startX: event.clientX, startValue: value };
      setDragging(true);
      onInteractionChange?.(true);
    },
    [disabled, editing, onInteractionChange, value],
  );

  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (event: PointerEvent) => {
      const multiplier = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
      const delta = (event.clientX - drag.current.startX) * step * multiplier;
      const next = round(clamp(drag.current.startValue + delta), precision);
      if (next !== value) onChange(next);
    };
    const onUp = () => {
      setDragging(false);
      onInteractionChange?.(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [clamp, dragging, onChange, onInteractionChange, precision, step, value]);

  const beginEdit = useCallback(() => {
    if (disabled) return;
    setDraft(value.toFixed(precision));
    setEditing(true);
  }, [disabled, precision, value]);

  const endEdit = useCallback(
    (commitEdit: boolean) => {
      if (commitEdit) {
        const parsed = Number.parseFloat(draft);
        if (!Number.isNaN(parsed)) commit(parsed);
      }
      setEditing(false);
      onInteractionChange?.(false);
    },
    [commit, draft, onInteractionChange],
  );

  return (
    <div
      {...stylex.props(styles.field, dragging && styles.fieldDragging, disabled && styles.fieldDisabled)}
    >
      {hideLabel ? (
        <span {...stylex.props(styles.labelEmpty)} />
      ) : (
        <span
          {...stylex.props(styles.label, dragging && styles.labelDragging)}
          onPointerDown={startDrag}
          title={`${label} — drag to change, Shift for coarse, Alt for fine`}
        >
          {label}
        </span>
      )}
      {editing ? (
        <input
          {...stylex.props(styles.input)}
          autoFocus
          aria-label={label}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => endEdit(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') endEdit(true);
            if (event.key === 'Escape') endEdit(false);
          }}
        />
      ) : (
        <span
          {...stylex.props(styles.value)}
          role="spinbutton"
          tabIndex={disabled ? -1 : 0}
          aria-label={label}
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={max}
          onClick={beginEdit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') beginEdit();
            // Arrow keys step, which is what a keyboard user expects from a spinbutton.
            if (event.key === 'ArrowUp') commit(value + step * (event.shiftKey ? 10 : 1));
            if (event.key === 'ArrowDown') commit(value - step * (event.shiftKey ? 10 : 1));
          }}
        >
          {value.toFixed(precision)}
        </span>
      )}
    </div>
  );
}

/**
 * One axis of a vector row: the `X`/`Y`/`Z` chip followed by a label-less scrub field.
 *
 * Their inspector groups the three axes of a position into a single row of equal-width fields, which
 * is why the axis letter sits *outside* the field's box rather than inside it.
 */
export function ScrubAxis({
  axis,
  value,
  onChange,
  onInteractionChange,
  step = 0.1,
  precision = 2,
  disabled = false,
}: Omit<ScrubFieldProps, 'label' | 'hideLabel'> & { axis: string }): JSX.Element {
  return (
    <div {...stylex.props(axisRow.wrap)}>
      <span {...stylex.props(styles.axis)}>{axis}</span>
      <span {...stylex.props(axisRow.grow)}>
        <ScrubField
          label={axis}
          value={value}
          onChange={onChange}
          onInteractionChange={onInteractionChange}
          step={step}
          precision={precision}
          disabled={disabled}
          hideLabel
        />
      </span>
    </div>
  );
}

const axisRow = stylex.create({
  wrap: {
    display: 'flex',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  grow: {
    display: 'flex',
    flex: 1,
    minWidth: 0,
  },
});
