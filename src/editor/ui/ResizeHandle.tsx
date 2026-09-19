import { useCallback, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { color } from '../styles/tokens.stylex.js';
import { nextSize } from './resize-math.js';

export { nextSize } from './resize-math.js';

/**
 * A draggable divider for a resizable column.
 *
 * The reference editor's sidebar is 300–800px, and its resize loop is a few lines: read `clientX`,
 * clamp, write the width. This is that, plus the two things a bare implementation usually forgets —
 * `setPointerCapture` so a fast drag that outruns the cursor keeps delivering moves, and locking the
 * body cursor and text selection for the duration so the drag does not select the panel's contents.
 *
 * The hit area is deliberately wider than the painted line: a 1px target is unusable, so the element
 * is 7px wide with the hairline drawn down its middle.
 */

const styles = stylex.create({
  handle: {
    position: 'relative',
    width: '7px',
    marginInline: '-3px',
    flexShrink: 0,
    cursor: 'col-resize',
    zIndex: 10,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    padding: 0,
    /** The painted hairline. Transparent at rest so the divider is the panel's own border. */
    '::after': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      insetInlineStart: '3px',
      width: '1px',
      backgroundColor: 'transparent',
      transitionProperty: 'background-color',
      transitionDuration: '120ms',
    },
    ':hover::after': {
      backgroundColor: color['border-strong'],
    },
  },
  handleY: {
    width: 'auto',
    height: '7px',
    marginInline: 0,
    marginBlock: '-3px',
    cursor: 'row-resize',
    '::after': {
      insetBlockStart: '3px',
      bottom: 'auto',
      insetInlineStart: 0,
      insetInlineEnd: 0,
      width: 'auto',
      height: '1px',
    },
  },
  dragging: {
    backgroundColor: color.wash,
  },
  draggable: {
    touchAction: 'none',
  },
});

export interface ResizeHandleProps {
  /** The current size of the panel being resized, in pixels. */
  size: number;
  /** Called with the clamped size as the pointer moves. */
  onResize(size: number): void;
  min: number;
  max: number;
  /**
   * Called when the pointer goes below `collapseBelow`. The reference collapses its sidebar rather
   * than letting it shrink to an unusable sliver, which is why this is separate from `min`.
   */
  onCollapse?(): void;
  collapseBelow?: number;
  /** Restores a stored width when the drag ends, so layout is persisted once, not per frame. */
  onCommit?(): void;
  label: string;
  axis?: 'x' | 'y';
  direction?: 1 | -1;
}

export function ResizeHandle({
  size,
  onResize,
  min,
  max,
  onCollapse,
  collapseBelow,
  onCommit,
  label,
  axis = 'x',
  direction = 1,
}: ResizeHandleProps): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const active = useRef(false);
  const startPointer = useRef(0);
  const startSize = useRef(size);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      active.current = true;
      startPointer.current = axis === 'x' ? event.clientX : event.clientY;
      startSize.current = size;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [axis, size],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!active.current) return;
      const pointer = axis === 'x' ? event.clientX : event.clientY;
      const raw = startSize.current + direction * (pointer - startPointer.current);
      if (onCollapse && collapseBelow !== undefined && raw < collapseBelow) {
        onCollapse();
        return;
      }
      onResize(nextSize({
        startSize: startSize.current,
        startPointer: startPointer.current,
        pointer,
        direction,
        min,
        max,
      }));
    },
    [axis, collapseBelow, direction, max, min, onCollapse, onResize],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const positive = axis === 'x' ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
      const negative = axis === 'x' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
      if (!positive && !negative) return;
      event.preventDefault();
      const pointer = positive ? 16 : -16;
      const raw = size + direction * pointer;
      if (onCollapse && collapseBelow !== undefined && raw < collapseBelow) {
        onCollapse();
        return;
      }
      onResize(nextSize({ startSize: size, startPointer: 0, pointer, direction, min, max }));
    },
    [axis, collapseBelow, direction, max, min, onCollapse, onResize, size],
  );

  const end = useCallback(() => {
    if (!active.current) return;
    active.current = false;
    setDragging(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    onCommit?.();
  }, [onCommit]);

  return (
    <div
      {...stylex.props(styles.handle, axis === 'y' && styles.handleY, styles.draggable, dragging && styles.dragging)}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}
