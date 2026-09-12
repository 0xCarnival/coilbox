import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { color, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { useSessionSnapshot } from '../hooks.js';
import { format } from '../units.js';
import { useUnitSystem } from '../units-context.js';
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
     * Above the box was the first attempt and it collided with the display panel whenever the
     * selection sat in the top-right of the stage, which is exactly where a raised object tends to
     * be. Below is clear of every panel in the shell.
     */
    transform: 'translate(-50%, 0)',
    /**
     * A column, not a row, and `max-content` wide.
     *
     * The row version clipped: an absolutely positioned box sizes to its containing block, so the
     * camera readout rendered past the border instead of widening it. Stacking the lines gives the box
     * a natural width from its longer one, and reads better — the dimensions are the measurement and
     * the camera distance is context, so they are not peers.
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
    zIndex: 20,
  },
  /** The dimensions, in mono: they are read as numbers and compared as numbers. */
  dims: {
    flexShrink: 0,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: fontSize.xs,
    fontVariantNumeric: 'tabular-nums',
    color: color.text,
  },
  /** The camera distance, quieter than the dimensions: it is context, not the measurement. */
  distance: {
    fontSize: fontSize.micro,
    color: color.dim,
    fontVariantNumeric: 'tabular-nums',
  },
});

/**
 * The y below which the label is meant to clear the display panel.
 *
 * A floor rather than a computed edge, because the panel's height depends on which rows are showing
 * and it is not trivial to measure from here. **This does not fully work yet**: a selection in the
 * stage's top-right still puts its label partly under the panel, because the clamp pulls the label
 * inside the *stage* and the panel floats over the stage's right-hand side. Closing it properly means
 * either giving the overlay the panel's measured box or moving the panel, and neither is done.
 */
const DISPLAY_PANEL_CLEARANCE = 300;

export interface MeasurementOverlayProps {
  viewport: React.RefObject<ViewportHandle | null>;
  /** Hidden while measuring makes no sense: Play mode and the 2D view both qualify. */
  visible: boolean;
}

export function MeasurementOverlay({ viewport, visible }: MeasurementOverlayProps): JSX.Element | null {
  const snapshot = useSessionSnapshot();
  const units = useUnitSystem();
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
      const x = half > 0 ? Math.min(Math.max(anchor.x, half + 8), stage.width - half - 8) : anchor.x;
      /**
       * Below the object, and below the display panel.
       *
       * The panel occupies the stage's top-right corner and the selection can be anywhere, so the
       * only vertical band that is reliably clear is under both. `DISPLAY_PANEL_CLEARANCE` is that
       * band's top edge — the panel is 248px wide and its body roughly 260px tall, measured from the
       * content it renders.
       */
      const y = Math.max(anchor.y + 10, DISPLAY_PANEL_CLEARANCE);

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
      <span {...stylex.props(styles.dims)}>
        {format(width, units, 'length')} × {format(depth, units, 'length')} ×{' '}
        {format(height, units, 'length')}
      </span>
      <span {...stylex.props(styles.distance)}>cam {format(box.distance, units, 'length')}</span>
    </div>
  );
}
