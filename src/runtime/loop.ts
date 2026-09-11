/**
 * Fixed-timestep loop with a capped accumulator and render interpolation (plan §8).
 *
 * Rules implemented here:
 * - Physics advances in fixed steps of `fixedTimeStep` (initial 1/60 s).
 * - A variable frame rate never means "one physics step per rendered frame".
 * - Long delays are clamped, and accumulated time is dropped once `maxSubSteps` is hit
 *   instead of running an unbounded catch-up spiral.
 * - After the tab is backgrounded or the page resumes, the accumulator resets so the
 *   simulation resumes rather than replaying the paused interval.
 *
 * The loop is deliberately free of Three.js and DOM specifics: `advance()` takes the
 * frame delta from the caller, which makes the whole thing unit-testable.
 */

const STEP_EPSILON = 1e-9;

export interface FixedStepLoopOptions {
  /** Seconds per simulation step. */
  fixedTimeStep: number;
  /** Maximum simulation steps consumed in a single frame. */
  maxSubSteps: number;
  /** Called once per fixed simulation step. */
  onFixedStep: (fixedDelta: number) => void;
  /** Called once per frame with the interpolation factor in [0, 1). */
  onRender: (alpha: number, frameDelta: number) => void;
  /** Maximum frame delta accepted before clamping, in seconds. */
  maxFrameDelta?: number;
  requestFrame?: (callback: (timeMs: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  now?: () => number;
  /** Returns true when the page is hidden and time should be dropped. */
  isBackgrounded?: () => boolean;
}

export interface LoopStats {
  /** Frames rendered since start. */
  frames: number;
  /** Fixed steps executed since start. */
  steps: number;
  /** Time dropped because the accumulator hit `maxSubSteps`, in seconds. */
  droppedTime: number;
  /** Time dropped because the page was backgrounded or the delta was clamped, in seconds. */
  clampedTime: number;
  /** Steps executed during the most recent frame. */
  lastFrameSteps: number;
  /** Interpolation factor of the most recent frame. */
  lastAlpha: number;
}

export class FixedStepLoop {
  private readonly options: Required<Pick<FixedStepLoopOptions, 'fixedTimeStep' | 'maxSubSteps' | 'maxFrameDelta'>> &
    FixedStepLoopOptions;

  private accumulator = 0;
  private frameHandle: number | null = null;
  private lastTimeMs: number | null = null;
  private running = false;
  private readonly stats: LoopStats = {
    frames: 0,
    steps: 0,
    droppedTime: 0,
    clampedTime: 0,
    lastFrameSteps: 0,
    lastAlpha: 0,
  };

  constructor(options: FixedStepLoopOptions) {
    if (!(options.fixedTimeStep > 0)) throw new Error('fixedTimeStep must be positive');
    if (!Number.isInteger(options.maxSubSteps) || options.maxSubSteps < 1) {
      throw new Error('maxSubSteps must be a positive integer');
    }
    this.options = { maxFrameDelta: 0.25, ...options };
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return !this.running && this.frameHandle === null && this.lastTimeMs !== null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTimeMs = null;
    this.scheduleFrame();
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.cancelScheduledFrame();
    this.lastTimeMs = null;
  }

  stop(): void {
    this.running = false;
    this.cancelScheduledFrame();
    this.lastTimeMs = null;
    this.accumulator = 0;
  }

  /** Discard accumulated time; used when the page becomes visible again. */
  resetAccumulator(): void {
    this.accumulator = 0;
    this.lastTimeMs = null;
  }

  /** Advance exactly one fixed step and render once. Used by paused Step. */
  stepOnce(): void {
    if (this.running) throw new Error('stepOnce requires a paused loop');
    this.options.onFixedStep(this.options.fixedTimeStep);
    this.stats.steps += 1;
    this.stats.lastFrameSteps = 1;
    this.accumulator = 0;
    this.stats.lastAlpha = 0;
    this.options.onRender(0, 0);
    this.stats.frames += 1;
  }

  /**
   * Advance the simulation with an externally supplied frame delta.
   * `runFixedSteps: false` only interpolates and renders (used while paused).
   */
  advance(frameDelta: number, runFixedSteps = true): void {
    const { fixedTimeStep, maxSubSteps, maxFrameDelta } = this.options;
    let delta = Math.max(0, Number.isFinite(frameDelta) ? frameDelta : 0);

    if (this.options.isBackgrounded?.()) {
      this.stats.clampedTime += delta;
      this.accumulator = 0;
      delta = 0;
    } else if (delta > maxFrameDelta) {
      this.stats.clampedTime += delta - maxFrameDelta;
      delta = maxFrameDelta;
    }

    let steps = 0;
    if (runFixedSteps) {
      this.accumulator += delta;
      // The tolerance keeps exact multiples of the step (1/30 s, 6/360 s) from losing a
      // step to binary floating point.
      while (this.accumulator >= fixedTimeStep - STEP_EPSILON && steps < maxSubSteps) {
        this.options.onFixedStep(fixedTimeStep);
        this.accumulator -= fixedTimeStep;
        steps += 1;
      }
      if (this.accumulator >= fixedTimeStep - STEP_EPSILON) {
        // Hit the step cap: drop the backlog instead of spiralling.
        this.stats.droppedTime += this.accumulator;
        this.accumulator = 0;
      }
    }

    const alpha = runFixedSteps ? Math.min(this.accumulator / fixedTimeStep, 1) : 0;
    this.stats.steps += steps;
    this.stats.lastFrameSteps = steps;
    this.stats.lastAlpha = alpha;
    this.options.onRender(alpha, delta);
    this.stats.frames += 1;
  }

  getStats(): LoopStats {
    return { ...this.stats };
  }

  private scheduleFrame(): void {
    if (!this.running || this.frameHandle !== null) return;
    const requestFrame = this.options.requestFrame ?? defaultRequestFrame;
    this.frameHandle = requestFrame((timeMs) => {
      this.frameHandle = null;
      if (!this.running) return;
      const now = this.options.now ? this.options.now() : timeMs;
      const previous = this.lastTimeMs;
      this.lastTimeMs = now;
      const delta = previous === null ? 0 : (now - previous) / 1000;
      this.advance(delta);
      this.scheduleFrame();
    });
  }

  private cancelScheduledFrame(): void {
    if (this.frameHandle === null) return;
    const cancelFrame = this.options.cancelFrame ?? defaultCancelFrame;
    cancelFrame(this.frameHandle);
    this.frameHandle = null;
  }
}

function defaultRequestFrame(callback: (timeMs: number) => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(callback);
  }
  return setTimeout(() => callback(performance.now()), 16) as unknown as number;
}

function defaultCancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}
