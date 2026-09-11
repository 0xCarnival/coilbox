import type { Page } from '@playwright/test';

/**
 * Waiting on simulated time instead of wall-clock time.
 *
 * The runtime is fixed-step and by design drops a backlog rather than replaying it (plan §8), so on
 * a slow machine a browser session takes *fewer* simulation steps in the same wall-clock second. A
 * gate that sleeps for a fixed number of milliseconds and then asserts that the player walked a
 * certain distance is therefore asserting the speed of the machine rather than the behaviour of the
 * engine — which is exactly how these gates failed on a two-core CI runner while passing on a
 * development laptop.
 *
 * These helpers wait for the simulation to reach a step count, bounded by a wall-clock timeout so a
 * genuinely stuck world still fails loudly.
 */

export interface StepWaitOptions {
  /** Which surface to read: the editor's Play world, or a standalone player page. */
  source?: 'editor' | 'player';
  timeoutMs?: number;
  /** How often to ask. */
  pollMs?: number;
}

/** The fixed-step count of the running world, or `-1` when no world is running yet. */
export async function playSteps(page: Page, source: 'editor' | 'player' = 'player'): Promise<number> {
  return page.evaluate((surface: string) => {
    if (surface === 'editor') return window.__STUDIO__?.viewport?.()?.playStats()?.steps ?? -1;
    return window.__PLAYER__?.stats()?.steps ?? -1;
  }, source);
}

/**
 * Resolve once the running world has taken `target` steps, and return the step count it saw. Throws
 * when the world never gets there, naming the count it did reach.
 */
export async function waitForPlaySteps(page: Page, target: number, options: StepWaitOptions = {}): Promise<number> {
  const source = options.source ?? 'player';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;
  const started = Date.now();
  let seen = await playSteps(page, source);
  while (seen < target) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`the world reached ${seen} of the ${target} steps expected within ${timeoutMs} ms`);
    }
    await page.waitForTimeout(pollMs);
    seen = await playSteps(page, source);
  }
  return seen;
}

/** How many steps a world takes in `seconds` of simulated time. */
export function stepsForSeconds(seconds: number, fixedTimeStep = 1 / 60): number {
  return Math.ceil(seconds / fixedTimeStep);
}
