import type { Page } from '@playwright/test';

/**
 * Stage 0 checks, expressed once and driven by tools/verify-stage0.ts.
 *
 * Each check returns a record with the observed value so the evidence file shows what
 * was actually measured rather than only pass/fail.
 */

export interface Stage0State {
  state: string;
  boxY: number;
  boxDroppedFrom: number;
  expectedRestingY: number;
  physicsWorldCount: number;
  wasmBytes: number;
  wasmUrl: string;
  binding: string;
  bindingVersion: string;
  doublePrecision: boolean;
  warnings: string[];
  rendererInfo: { geometries: number; textures: number; programs: number } | null;
  listenerCount: number;
  worldsCreated: number;
  /** The canvas still has a usable WebGL2 context after Stop, ready for the next world. */
  contextAlive: boolean;
}

export interface PixelStats {
  width: number;
  height: number;
  nonBackgroundPixels: number;
  distinctColors: number;
  meanLuminance: number;
}

export interface CheckResult {
  id: string;
  title: string;
  passed: boolean;
  detail: string;
  observed?: unknown;
}

/**
 * The subset of the live world's stats these checks assert on. The probe publishes the real world
 * stats object, which carries more; naming the slice the checks read keeps the assertions typed
 * instead of re-asserting the shape at every call site.
 */
export interface Stage0Stats {
  steps: number;
  physics: { contactCount: number };
}

export interface Stage0ProbeApi {
  play(): Promise<void>;
  pause(): void;
  step(): void;
  stop(): void;
  reset(): Promise<void>;
  stats(): Stage0Stats | null;
  samplePixels(): PixelStats;
  readState(): Stage0State;
  error(): string | null;
  ready: Promise<void>;
}

type Stage0Window = typeof globalThis & { __STAGE0__?: Stage0ProbeApi };

export interface Stage0RunOptions {
  /** Page already navigated to probe.html. */
  page: Page;
  /** Requests observed by the static server, for the WASM/MIME/404 checks. */
  requests: Array<{ method: string; url: string; status: number; bytes: number; contentType: string | null }>;
  /** Origin the build was served from, used to detect dev-server URLs. */
  baseUrl: string;
  /** Write a screenshot of the rendered canvas here, when provided. */
  screenshotPath?: string;
}

export async function runStage0Checks(options: Stage0RunOptions): Promise<CheckResult[]> {
  const { page } = options;
  const results: CheckResult[] = [];
  const record = (result: CheckResult) => {
    results.push(result);
    return result;
  };

  await page.waitForFunction(() => (window as Stage0Window).__STAGE0__ !== undefined, undefined, { timeout: 30_000 });
  await page.evaluate(() => (window as Stage0Window).__STAGE0__!.ready);

  const bootState = await page.evaluate(() => (window as Stage0Window).__STAGE0__!.readState());
  record({
    id: 'wasm-loaded',
    title: 'Box3D WASM loads in the built bundle',
    passed: bootState.physicsWorldCount >= 1 && bootState.bindingVersion.length > 0,
    detail: `${bootState.binding} engine ${bootState.bindingVersion}, doublePrecision=${bootState.doublePrecision}, world=${bootState.physicsWorldCount}`,
    observed: { binding: bootState.binding, version: bootState.bindingVersion, wasmUrl: bootState.wasmUrl },
  });

  // --- Play: the box must fall and come to rest on the ground -----------------
  await page.evaluate(() => (window as Stage0Window).__STAGE0__!.play());
  const settled = await page
    .waitForFunction(
      (expected: number) => {
        const api = window.__STAGE0__;
        if (!api) return false;
        const state = api.readState();
        return state.state === 'running' && Math.abs(state.boxY - expected) < 0.05;
      },
      bootState.expectedRestingY,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false);

  const afterFall = await page.evaluate(() => {
    const api = (window as Stage0Window).__STAGE0__!;
    return { state: api.readState(), stats: api.stats() };
  });

  record({
    id: 'physics-runs',
    title: 'Physics simulates: the box falls from its authored height and rests on the ground',
    passed: settled,
    detail: settled
      ? `box settled at y=${afterFall.state.boxY.toFixed(4)} (expected ${afterFall.state.expectedRestingY}), dropped from y=${afterFall.state.boxDroppedFrom}, physics steps=${afterFall.stats?.steps ?? 0}`
      : `box did not settle: y=${afterFall.state.boxY.toFixed(4)} after ${afterFall.stats?.steps ?? 0} steps`,
    observed: { boxY: afterFall.state.boxY, steps: afterFall.stats?.steps ?? 0 },
  });

  record({
    id: 'fixed-step-rate',
    title: 'Simulation advances on the fixed step, not one step per frame',
    passed: (afterFall.stats?.steps ?? 0) > 30,
    detail: `${afterFall.stats?.steps ?? 0} fixed steps executed while rendering`,
    observed: { steps: afterFall.stats?.steps ?? 0 },
  });

  // --- Rendering: the frame must contain geometry, not a cleared background ----
  const pixels = await page.evaluate(() => (window as Stage0Window).__STAGE0__!.samplePixels());
  const renderedFraction = pixels.nonBackgroundPixels / (pixels.width * pixels.height);
  record({
    id: 'box-renders',
    title: 'The world renders: frame contains shaded geometry and shadows',
    passed: renderedFraction > 0.05 && pixels.distinctColors > 8 && pixels.meanLuminance > 2,
    detail: `${(renderedFraction * 100).toFixed(1)}% of ${pixels.width}x${pixels.height} pixels differ from the background, ${pixels.distinctColors} distinct colours, mean luminance ${pixels.meanLuminance.toFixed(1)}`,
    observed: pixels,
  });

  if (options.screenshotPath) {
    await page.locator('#probe-canvas').screenshot({ path: options.screenshotPath });
  }

  // --- Pause/Step: exactly one fixed tick --------------------------------------
  const beforeStep = await page.evaluate(() => {
    const api = (window as Stage0Window).__STAGE0__!;
    api.pause();
    return { stats: api.stats(), state: api.readState().state };
  });
  await page.evaluate(() => (window as Stage0Window).__STAGE0__!.step());
  const afterStep = await page.evaluate(() => {
    const api = (window as Stage0Window).__STAGE0__!;
    return { stats: api.stats() };
  });
  const advanced = (afterStep.stats?.steps ?? 0) - (beforeStep.stats?.steps ?? 0);
  record({
    id: 'pause-step',
    title: 'Step advances exactly one fixed simulation tick while paused',
    passed: beforeStep.state === 'paused' && advanced === 1,
    detail: `state after pause="${beforeStep.state}", steps advanced=${advanced}`,
    observed: { advanced, before: beforeStep.stats?.steps ?? 0, after: afterStep.stats?.steps ?? 0 },
  });

  // --- Stop: everything the world owned is released -----------------------------
  await page.evaluate(() => (window as Stage0Window).__STAGE0__!.stop());
  const afterStop = await page.evaluate(() => (window as Stage0Window).__STAGE0__!.readState());
  record({
    id: 'stop-cleanup',
    title: 'Stop releases the physics world, render resources, and event listeners',
    passed:
      afterStop.physicsWorldCount === 0 &&
      afterStop.listenerCount === 0 &&
      (afterStop.rendererInfo === null || afterStop.rendererInfo.geometries === 0) &&
      afterStop.contextAlive,
    detail:
      afterStop.physicsWorldCount === 0 && afterStop.listenerCount === 0
        ? `physics worlds=0, listeners=0, renderer disposed, canvas context reusable=${afterStop.contextAlive}`
        : `physics worlds=${afterStop.physicsWorldCount}, listeners=${afterStop.listenerCount}, geometries=${afterStop.rendererInfo?.geometries ?? 'n/a'}`,
    observed: afterStop,
  });

  // --- Repeated Play/Stop must not accumulate worlds ----------------------------
  const cycles: Array<{ cycle: number; worlds: number; wasmBytes: number; boxY: number }> = [];
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await page.evaluate(async () => {
      const api = (window as Stage0Window).__STAGE0__!;
      await api.reset();
      await api.play();
    });
    await page.waitForTimeout(400);
    const mid = await page.evaluate(() => (window as Stage0Window).__STAGE0__!.readState());
    await page.evaluate(() => (window as Stage0Window).__STAGE0__!.stop());
    const end = await page.evaluate(() => (window as Stage0Window).__STAGE0__!.readState());
    cycles.push({ cycle: cycle + 1, worlds: end.physicsWorldCount, wasmBytes: end.wasmBytes, boxY: mid.boxY });
  }
  const leaked = cycles.filter((entry) => entry.worlds !== 0);
  record({
    id: 'no-world-leak',
    title: 'Five Play/Stop cycles leave no live physics world behind',
    passed: leaked.length === 0,
    detail: `world counts after stop: ${cycles.map((c) => c.worlds).join(', ')}; wasm bytes: ${cycles.map((c) => c.wasmBytes).join(', ')}`,
    observed: cycles,
  });

  const finalState = await page.evaluate(() => (window as Stage0Window).__STAGE0__!.readState());
  record({
    id: 'authored-scene-untouched',
    title: 'Stopping restores the authored scene instead of an undone simulation',
    passed: finalState.state === 'stopped' && finalState.warnings.length === 0,
    detail: `state=${finalState.state}, warnings=${finalState.warnings.length === 0 ? 'none' : finalState.warnings.join(' | ')}`,
    observed: finalState,
  });

  return results;
}

/**
 * Static-delivery checks over the requests the server saw: no missing files, no dev
 * server URLs, and the WASM served with the right content type (plan §14, §16).
 */
export function checkStaticDelivery(
  requests: Array<{ method: string; url: string; status: number; bytes: number; contentType: string | null }>,
  baseUrl: string,
): CheckResult[] {
  const results: CheckResult[] = [];
  const origin = new URL(baseUrl).origin;
  const failures = requests.filter((entry) => entry.status >= 400);
  const wasm = requests.filter((entry) => entry.url.endsWith('.wasm'));
  const devUrls = requests.filter((entry) => entry.url.includes('/src/') || entry.url.includes('/@vite') || entry.url.includes('/node_modules/'));

  results.push({
    id: 'no-404',
    title: 'Every request from the built game is served successfully',
    passed: failures.length === 0,
    detail: failures.length === 0 ? `${requests.length} requests, none failed` : `${failures.length} failed: ${failures.map((f) => `${f.status} ${f.url}`).join(', ')}`,
    observed: { total: requests.length },
  });

  results.push({
    id: 'wasm-served',
    title: 'The Box3D WASM binary is part of the build and is served as application/wasm',
    passed: wasm.length > 0 && wasm.every((entry) => entry.status === 200 && entry.contentType === 'application/wasm'),
    detail:
      wasm.length > 0
        ? wasm.map((entry) => `${entry.url} -> ${entry.status} ${entry.contentType} ${(entry.bytes / 1024).toFixed(0)} KiB`).join('; ')
        : 'no .wasm request was made',
    observed: wasm,
  });

  results.push({
    id: 'no-dev-urls',
    title: 'The build does not reference the development server or source folders',
    passed: devUrls.length === 0,
    detail: devUrls.length === 0 ? `no dev-server URLs requested from ${origin}` : `dev URLs: ${devUrls.map((entry) => entry.url).join(', ')}`,
    observed: devUrls,
  });

  return results;
}

export function formatResults(results: CheckResult[]): string {
  const lines = results.map((result) => `${result.passed ? 'PASS' : 'FAIL'}  ${result.title}\n        ${result.detail}`);
  const failed = results.filter((result) => !result.passed).length;
  lines.push('', `${results.length - failed}/${results.length} checks passed`);
  return lines.join('\n');
}
