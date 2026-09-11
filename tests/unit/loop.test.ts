import { describe, expect, it } from 'vitest';
import { FixedStepLoop } from '@runtime/loop.js';

/**
 * Fixed-timestep loop (plan §8): a variable frame rate must not mean one physics step per
 * rendered frame, long delays are clamped, and the accumulator does not spiral.
 */

function makeLoop(options: { backgrounded?: boolean } = {}) {
  const steps: number[] = [];
  const frames: Array<{ alpha: number; delta: number }> = [];
  const loop = new FixedStepLoop({
    fixedTimeStep: 1 / 60,
    maxSubSteps: 5,
    onFixedStep: (dt) => steps.push(dt),
    onRender: (alpha, delta) => frames.push({ alpha, delta }),
    isBackgrounded: () => options.backgrounded === true,
  });
  return { loop, steps, frames };
}

describe('FixedStepLoop', () => {
  it('runs a fixed number of steps regardless of frame rate', () => {
    const slow = makeLoop();
    // One 1/30 s frame: two fixed steps, not one.
    slow.loop.advance(1 / 30);
    expect(slow.steps).toHaveLength(2);
    expect(slow.frames).toHaveLength(1);

    const fast = makeLoop();
    // Six 1/360 s frames add up to exactly one 1/60 s step, however many frames it took.
    for (let i = 0; i < 6; i += 1) fast.loop.advance(1 / 360);
    expect(fast.steps).toHaveLength(1);
    expect(fast.frames).toHaveLength(6);
    for (let i = 0; i < 6; i += 1) fast.loop.advance(1 / 360);
    expect(fast.steps).toHaveLength(2);
  });

  it('clamps a long frame and drops the backlog instead of spiralling', () => {
    const { loop, steps, frames } = makeLoop();
    loop.advance(5);
    expect(steps).toHaveLength(5);
    expect(frames[0]?.delta).toBeCloseTo(0.25, 6);
    const stats = loop.getStats();
    expect(stats.clampedTime).toBeCloseTo(4.75, 6);
    expect(stats.droppedTime).toBeGreaterThan(0);
  });

  it('resets accumulated time while the page is backgrounded', () => {
    const { loop, steps } = makeLoop({ backgrounded: true });
    loop.advance(2);
    expect(steps).toHaveLength(0);
    expect(loop.getStats().clampedTime).toBeCloseTo(2, 6);
  });

  it('renders with an interpolation factor in [0, 1)', () => {
    const { loop, frames } = makeLoop();
    loop.advance(1 / 60 + 1 / 240);
    expect(frames[0]?.alpha).toBeGreaterThan(0.2);
    expect(frames[0]?.alpha).toBeLessThan(1);
  });

  it('steps exactly once when paused via stepOnce', () => {
    const { loop, steps, frames } = makeLoop();
    loop.stepOnce();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toBeCloseTo(1 / 60, 9);
    expect(frames[0]?.alpha).toBe(0);
    expect(loop.getStats().steps).toBe(1);
  });

  it('rejects stepOnce while running', () => {
    const { loop } = makeLoop();
    loop.start();
    expect(() => loop.stepOnce()).toThrow(/paused/);
    loop.stop();
  });

  it('uses an injected clock rather than wall time', () => {
    let now = 0;
    const steps: number[] = [];
    const scheduled: Array<(timeMs: number) => void> = [];
    const loop = new FixedStepLoop({
      fixedTimeStep: 1 / 60,
      maxSubSteps: 4,
      onFixedStep: () => steps.push(now),
      onRender: () => {},
      now: () => now,
      requestFrame: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelFrame: () => {},
    });
    loop.start();
    // First frame establishes the clock without advancing.
    scheduled.shift()?.(0);
    expect(steps).toHaveLength(0);
    now = 100;
    scheduled.shift()?.(0);
    // 100 ms needs six steps; the cap is four, and the backlog is dropped rather than replayed.
    expect(steps).toHaveLength(4);
    expect(loop.getStats().droppedTime).toBeGreaterThan(0);
    loop.stop();
  });
});
