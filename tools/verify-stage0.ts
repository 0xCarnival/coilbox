import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { startStaticServer } from './static-server.js';
import { checkStaticDelivery, formatResults, runStage0Checks, type CheckResult } from '../tests/stage0/checks.js';

/**
 * Stage 0 gate (plan §15).
 *
 * Deliverable: pinned Three.js/Box3D/Vite setup, blank runtime, simple falling box.
 * Required evidence: box renders, physics runs, Stop cleans up, and a production build
 * loads its WASM from a static server under a nested path.
 *
 * Usage:
 *   pnpm verify:stage0              full run (typecheck, unit tests, build, browser checks)
 *   pnpm verify:stage0 --skip-build reuse the existing dist/
 *   pnpm verify:stage0 --headed     show the browser window
 */

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');
const headed = args.has('--headed');
const NESTED_PREFIX = '/nested/coilbox/';

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

const steps: StepResult[] = [];

async function run(name: string, command: string, commandArgs: string[]): Promise<StepResult> {
  process.stdout.write(`\n== ${name} ==\n$ ${command} ${commandArgs.join(' ')}\n`);
  try {
    const { stdout, stderr } = await execFileAsync(command, commandArgs, {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const output = `${stdout}${stderr}`.trim();
    process.stdout.write(`${output.split('\n').slice(-12).join('\n')}\n`);
    const result = { name, ok: true, detail: 'exit 0' };
    steps.push(result);
    return result;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number; message: string };
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim();
    process.stdout.write(`${output.split('\n').slice(-40).join('\n')}\n`);
    const result = { name, ok: false, detail: `exit ${failure.code ?? 'unknown'}: ${failure.message.split('\n')[0]}` };
    steps.push(result);
    return result;
  }
}

async function main(): Promise<void> {
  const evidenceDir = join(root, 'docs', 'evidence', 'stage0');
  await mkdir(evidenceDir, { recursive: true });

  const typecheck = await run('typecheck', 'pnpm', ['exec', 'tsc', '--noEmit']);
  const unitTests = await run('unit tests', 'pnpm', ['exec', 'vitest', 'run']);
  if (!skipBuild) {
    await run('production build', 'pnpm', ['exec', 'vite', 'build']);
  } else {
    steps.push({ name: 'production build', ok: true, detail: 'skipped (--skip-build), reusing dist/' });
  }

  if (!typecheck.ok || !unitTests.ok) {
    process.stdout.write('\nAborting browser checks: typecheck or unit tests failed.\n');
    process.exit(1);
  }

  const server = await startStaticServer({
    root: join(root, 'dist'),
    prefix: NESTED_PREFIX,
    quiet: true,
  });
  process.stdout.write(`\n== browser checks ==\nserving dist/ at ${server.url}\n`);

  const browser = await chromium.launch({
    headless: !headed,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });

  const results: CheckResult[] = [];
  const browserErrors: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    page.on('pageerror', (error) => browserErrors.push(String(error)));

    await page.goto(`${server.url}probe.html`, { waitUntil: 'load' });
    results.push(...(await runStage0Checks({ page, requests: server.requests, baseUrl: server.url, screenshotPath: join(evidenceDir, 'probe.png') })));

    // Player: the same runtime loading a project from plain files next to the build.
    const playerRequestsBefore = server.requests.length;
    await page.goto(`${server.url}player.html?project=./probe-project/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__PLAYER__ !== undefined, undefined, { timeout: 30_000 });
    await page.evaluate(() => window.__PLAYER__!.ready);
    await page.waitForTimeout(1500);
    const playerState = await page.evaluate(() => {
      const handle = window.__PLAYER__!;
      return { state: handle.state(), pixels: handle.samplePixels() as { nonBackgroundPixels: number; distinctColors: number; width: number; height: number } };
    });
    await page.locator('#game-canvas').screenshot({ path: join(evidenceDir, 'player.png') });

    const playerRendered = playerState.pixels.nonBackgroundPixels / (playerState.pixels.width * playerState.pixels.height);
    results.push({
      id: 'player-loads-project',
      title: 'Standalone player loads a project from files and runs the same runtime',
      passed:
        playerState.state.errors.length === 0 &&
        playerState.state.state === 'running' &&
        playerRendered > 0.05 &&
        playerState.pixels.distinctColors > 8,
      detail: `project="${playerState.state.projectName}" scene="${playerState.state.sceneName}" state=${playerState.state.state} rendered=${(playerRendered * 100).toFixed(1)}% errors=${playerState.state.errors.length}`,
      observed: playerState,
    });

    results.push(...checkStaticDelivery(server.requests.slice(playerRequestsBefore), `${server.url}player.html`));

    const nonProbeFailures = server.requests.filter((entry) => entry.status >= 400 && !entry.url.includes('favicon'));
    results.push({
      id: 'no-missing-assets-anywhere',
      title: 'No request for either page returned an error',
      passed: nonProbeFailures.length === 0,
      detail:
        nonProbeFailures.length === 0
          ? `${server.requests.length} requests across probe and player, none failed`
          : nonProbeFailures.map((entry) => `${entry.status} ${entry.url}`).join(', '),
      observed: nonProbeFailures,
    });
  } finally {
    await browser.close();
    await server.close();
  }

  const consoleFailures = browserErrors.filter((text) => !text.includes('favicon'));
  results.push({
    id: 'no-console-errors',
    title: 'No page errors or console errors while running the built game',
    passed: consoleFailures.length === 0,
    detail: consoleFailures.length === 0 ? 'clean console' : consoleFailures.slice(0, 5).join(' | '),
  });

  process.stdout.write(`\n${formatResults(results)}\n`);

  const failed = results.filter((result) => !result.passed);
  const evidence = {
    stage: 0,
    generatedAt: new Date().toISOString(),
    node: process.version,
    nestedPrefix: NESTED_PREFIX,
    baseUrl: server.url,
    steps,
    checks: results,
    browserErrors,
  };
  await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nEvidence written to docs/evidence/stage0/evidence.json\n`);

  if (failed.length > 0 || steps.some((step) => !step.ok)) {
    process.stdout.write(`\nSTAGE 0 GATE FAILED (${failed.length} failing checks)\n`);
    process.exit(1);
  }
  process.stdout.write('\nSTAGE 0 GATE PASSED\n');
}

await main();
