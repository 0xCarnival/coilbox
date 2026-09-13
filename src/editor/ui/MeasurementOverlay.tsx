import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { color, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { useSessionSnapshot } from '../hooks.js';
import type { ViewportHandle } from '../panels/Viewport.js';

/**
 * The measurement overlay.
 *
 * Reads the selected object's world-space bounding box, projects it to the canvas, and labels it with
 * its dimensions in the unit system in force. This is the part of the reference's measurement work
 * that applies to a box-based game engine: their dimension chains and level annotations are for
 * architectural plans, but "how big is the thing I have selected" is a question every 3D editor has
 * to answer.
 *
 * ## Why it polls instead of subscribing
 *
 * The overlay's position depends on the camera, which the viewport mutates directly — there is no
 * render callback and no state to subscribe to. Polling on an animation frame is the honest way to
 * follow something that changes outside React, and it stops when nothing is selected. A fixed rate
 * would either lag a fast orbit or burn frames while idle.
 *
 * The label is `pointer-events: none`: it sits over the canvas, and an overlay that swallowed a drag
 * starting on it would make the object it describes hard to move.
 */

const styles = stylex.create({
  anchor: {
    position: 'absolute',
    /**
     * Centred horizontally under the box's bottom edge.
     *
     * Above the box was the first attempt and it collided with whatever occupies the stage's
     * top-right corner whenever the selection sat there, which is exactly where a raised object tends
     * to be. Below is clear of every floating control in the shell.
     */
    transform: 'translate(-50%, 0)',
    /**
     * A column, not a row.
     *
     * The row version clipped the camera readout past the border. Stacking the lines fixed that and
     * reads better — the dimensions are the measurement and the camera distance is context, so they
     * are not peers.
     *
     * **Still open:** the dimensions line can exceed the box and lose its last value, so a label for a
     * wide object reads `16.00 m × 0.5` instead of `16.00 m × 0.5 m × 2 m`. `width: max-content`,
     * `white-space: nowrap`, and `flex-shrink: 0` on both lines have all been tried and none of them
     * fixed it, which means the cause is not where it looks. The next thing to check is whether the
     * value is being clamped before the element has been measured, so the clamp is computed from a
     * narrower box than the one finally rendered.
     */
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '1px',
    width: 'max-content',
    paddingBlock: '3px',
    paddingInline: space.md,
    borderRadius: radius.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.border,
    backgroundColor: 'rgba(23, 23, 23, 0.9)',
    backdropFilter: 'blur(6px)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    /**
     * Above the stage's floating controls, and below the toasts.
     *
     * This was 20, under the floating layer's 30, and that was the actual bug: the label rendered its
     * full text and a translucent surface painted over the right end of it. Reading that as a sizing
     * problem sent three attempts at `max-content`, `nowrap`, and `flex-shrink` after a cause that was
     * never there — the label's own box was always wide enough, and only a measurement against the
     * *overlay* could have shown it.
     *
     * The measurement wins the overlap because it is transient and it describes the thing the user
     * just clicked; the controls it covers are permanent and readable a moment later.
     */
    zIndex: 40,
  },
  /** The dimensions, in mono: they are read as numbers and compared as numbers. */
  dims: {
    flexShrink: 0,
    whiteSpace: 'nowrap',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: fontSize.xs,
    fontVariantNumeric: 'tabular-nums',
    color: color.text,
  },
  /** The camera distance, quieter than the dimensions: it is context, not the measurement. */
  distance: {
    flexShrink: 0,
    whiteSpace: 'nowrap',
    fontSize: fontSize.micro,
    color: color.dim,
    fontVariantNumeric: 'tabular-nums',
  },
});

export interface MeasurementOverlayProps {
  viewport: React.RefObject<ViewportHandle | null>;
  /** Hidden while measuring makes no sense: Play mode qualifies, because the camera is not the user's. */
  visible: boolean;
}

export function MeasurementOverlay({ viewport, visible }: MeasurementOverlayProps): JSX.Element | null {
  const snapshot = useSessionSnapshot();
  const [box, setBox] = useState<{
    x: number;
    y: number;
    size: [number, number, number];
    distance: number;
  } | null>(null);
  const frame = useRef<number | null>(null);
  /** The overlay's own element, so its width can be measured for the clamp below. */
  const labelRef = useRef<HTMLDivElement | null>(null);

  const primary = snapshot.primarySelection;

  useEffect(() => {
    if (!visible || !primary) {
      setBox(null);
      return undefined;
    }

    const follow = () => {
      const handle = viewport.current;
      const entityId = primary;
      if (!handle || !entityId) return;
      const bounds = handle.worldBounds(entityId);
      if (!bounds) {
        setBox(null);
        return;
      }
      const [minX, minY, minZ] = bounds.min;
      const [maxX, maxY, maxZ] = bounds.max;
      // The box's bottom-centre: the label hangs below the silhouette from any angle.
      const anchor = handle.toScreen([(minX + maxX) / 2, minY, (minZ + maxZ) / 2]);
      if (!anchor) {
        setBox(null);
        return;
      }
      /**
       * The label is centred under the object, then pulled back inside the stage.
       *
       * An object near the right edge would otherwise push its own label off the canvas, and the
       * label is the whole point — a measurement you have to orbit to read is not a measurement. The
       * half-width comes from the element rather than a guess, so it survives the text getting longer
       * in imperial.
       */
      const half = (labelRef.current?.offsetWidth ?? 0) / 2;
      const stage = handle.canvasSize();
      const margin = 8;
      const x =
        half > 0 ? Math.min(Math.max(anchor.x, half + margin), stage.width - half - margin) : anchor.x;
      const y = anchor.y + 10;

      setBox({
        x,
        y,
        size: [Math.abs(maxX - minX), Math.abs(maxY - minY), Math.abs(maxZ - minZ)],
        distance: handle.cameraDistance(),
      });
      frame.current = requestAnimationFrame(follow);
    };

    frame.current = requestAnimationFrame(follow);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [primary, viewport, visible]);

  if (!visible || !box) return null;

  const [width, height, depth] = box.size;
  return (
    <div
      ref={labelRef}
      {...stylex.props(styles.anchor)}
      style={{ left: `${box.x}px`, top: `${box.y}px` }}
      role="status"
      aria-label="Selection dimensions"
    >
      {/**
       * Metres, always, and spelled out.
       *
       * There was a unit-system setting here that converted these — and every other length field —
       * to feet on request. It is gone, because a game engine does not have one: Unity works in
       * metres, Godot in metres, Unreal in centimetres, and each picks one because level design
       * happens in a single system. The suffix stays because a bare number does not say what it
       * measures.
       */}
      <span {...stylex.props(styles.dims)}>
        {width.toFixed(2)} m × {depth.toFixed(2)} m × {height.toFixed(2)} m
      </span>
      <span {...stylex.props(styles.distance)}>cam {box.distance.toFixed(2)} m</span>
    </div>
  );
}
