import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Horizontal drag-to-scrub, as a hook.
 *
 * The reference editor's inspector is built on this gesture, and it is the reason their number
 * fields feel like instruments: you drag across a label and watch the value move instead of
 * selecting text and typing. `ScrubField` is the full control built on it; this hook is the gesture
 * on its own, for the places where the markup has to stay a real `<input>` — the Inspector's vector
 * rows, whose inputs the browser gates drive directly and which therefore cannot become spans.
 *
 * Pointer capture semantics are handled by listening on `window` and tearing down in the effect
 * cleanup, so a drag that ends outside the window still finishes and still reports its end.
 */

export interface ScrubOptions {
  value: number;
  onChange(value: number): void;
  /** Value change per pixel of horizontal travel. `Shift` x10, `Alt` x0.1. */
  step: number;
  precision?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** Reports the start and end of a gesture, for undo coalescing. */
  onInteractionChange?(active: boolean): void;
}

export interface ScrubHandle {
  onPointerDown(event: React.PointerEvent): void;
  dragging: boolean;
}

export function useScrub({
  value,
  onChange,
  step,
  precision = 2,
  min,
  max,
  disabled = false,
  onInteractionChange,
}: ScrubOptions): ScrubHandle {
  const [dragging, setDragging] = useState(false);
  const origin = useRef({ x: 0, value: 0 });

  const clamp = useCallback(
    (candidate: number) => {
      if (min !== undefined && candidate < min) return min;
      if (max !== undefined && candidate > max) return max;
      return candidate;
    },
    [max, min],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (disabled) return;
      event.preventDefault();
      origin.current = { x: event.clientX, value };
      setDragging(true);
      onInteractionChange?.(true);
    },
    [disabled, onInteractionChange, value],
  );

  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (event: PointerEvent) => {
      const multiplier = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
      const delta = (event.clientX - origin.current.x) * step * multiplier;
      const factor = 10 ** precision;
      const next = Math.round(clamp(origin.current.value + delta) * factor) / factor;
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
    // `value` is deliberately absent: the loop reads the value it captured at pointer-down from
    // `origin`, and re-subscribing on every change would rebind the listener mid-gesture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, step, precision, clamp, onChange, onInteractionChange]);

  return { onPointerDown, dragging };
}
