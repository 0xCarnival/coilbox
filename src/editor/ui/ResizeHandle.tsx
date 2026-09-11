import { useCallback, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { color } from '../styles/tokens.stylex.js';

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
  dragging: {
    backgroundColor: color.wash,
  },
  draggable: {
    touchAction: 'none',
  },
});

export interface ResizeHandleProps {
  /** The current width of the column being resized, in pixels. */
  width: number;
  /** Called with the clamped width as the pointer moves. */
  onResize(width: number): void;
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
}

export function ResizeHandle({
  width,
  onResize,
  min,
  max,
  onCollapse,
  collapseBelow,
  onCommit,
  label,
}: ResizeHandleProps): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const active = useRef(false);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      active.current = true;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!active.current) return;
      const next = event.clientX - 56;
      if (onCollapse && collapseBelow !== undefined && next < collapseBelow) {
        onCollapse();
        return;
      }
      onResize(Math.max(min, Math.min(next, max)));
    },
    [collapseBelow, max, min, onCollapse, onResize],
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
      {...stylex.props(styles.handle, styles.draggable, dragging && styles.dragging)}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}
