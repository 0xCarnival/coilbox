import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGame } from './build.js';
import { Workspace } from './workspace.js';

/**
 * `studio test <game-id>`: the bounded check an agent runs before reporting a game as done.
 *
 * It validates the project, exports it, serves the export on a loopback static server, and runs
 * it in a headless browser for a fixed number of seconds — asserting that the project loads, its
 * behaviors register, the simulation advances, and nothing throws. Every step has a timeout and
 * the command always ends with an exit status, as the plan requires of automated test commands.
 */

export interface GameTestOptions {
  workspace: Workspace;
  projectId: string;
  /** Seconds of simulated play to allow. */
  seconds?: number;
  /** Keep the exported build instead of deleting it. */
  keepBuild?: boolean;
  log?: (message: string) => void;
}

export interface GameTestCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface GameTestResult {
  ok: boolean;
  checks: GameTestCheck[];
  durationMs: number;
  exportDir: string | null;
}

export async function testGame(options: GameTestOptions): Promise<GameTestResult> {
  const started = Date.now();
  const log = options.log ?? (() => {});
  const seconds = options.seconds ?? 3;
  const checks: GameTestCheck[] = [];
  const record = (id: string, passed: boolean, detail: string) => {
    checks.push({ id, passed, detail });
    log(`${passed ? 'ok  ' : 'FAIL'} ${id}: ${detail}`);
  };

  const validation = await options.workspace.validateProject(options.projectId);
  const errors = validation.issues.filter((issue) => issue.severity === 'error');
  record(
    'validate',
    validation.ok,
    validation.ok ? 'the project validates' : errors.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
  );
  for (const issue of validation.issues.filter((candidate) => candidate.severity === 'warning')) {
    log(`warn ${issue.path}: ${issue.message}`);
  }
  if (!validation.ok) {
    return { ok: false, checks, durationMs: Date.now() - started, exportDir: null };
  }

  const scratch = await mkdtemp(join(tmpdir(), 'coilbox-test-'));
  let exportDir: string | null = null;
  let server: { url: string; close(): Promise<void>; requests: Array<{ status: number; url: string }> } | null = null;
  let browser: { close(): Promise<void> } | null = null;

  try {
    const build = await buildGame({
      workspace: options.workspace,
      projectId: options.projectId,
      outSubdirectory: join('.coilbox', 'test-build'),
      log: (message) => log(`     ${message}`),
    });
    exportDir = build.outDir;
    record('build', build.files.length > 0, `exported ${build.files.length} files (${(build.totalBytes / 1024 / 1024).toFixed(2)} MiB)`);

    const { startStaticServer } = await import('../tools/static-server.js');
    const staticServer = await startStaticServer({ root: build.outDir, prefix: '/games/under-test/', quiet: true });
    server = staticServer;

    const { chromium } = await import('@playwright/test');
    const browserInstance = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
    browser = browserInstance;

    const page = await browserInstance.newPage({ viewport: { width: 1024, height: 640 } });
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(staticServer.url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForFunction(() => (window as unknown as { __PLAYER__?: unknown }).__PLAYER__ !== undefined, undefined, {
      timeout: 30_000,
    });
    const state = await page.evaluate(
      () => (window as unknown as { __PLAYER__: { state(): { errors: string[]; projectName: string; sceneName: string } } }).__PLAYER__.state(),
    );
    record('loads', state.errors.length === 0, state.errors.length === 0 ? `loaded "${state.projectName}" (${state.sceneName})` : state.errors.join('; '));

    const behaviors = await page.evaluate(() =>
      (window as unknown as { __PLAYER__: { behaviorList(): Array<{ behaviorId: string }> } }).__PLAYER__.behaviorList(),
    );
    record('behaviors-registered', behaviors.length > 0, `${behaviors.length} behavior instance(s): ${[...new Set(behaviors.map((entry) => entry.behaviorId))].join(', ') || 'none'}`);

    // Dismiss the start overlay when the game has one, then let it run.
    await page
      .click('.coilbox-hud .hud-overlay[data-hud-id="start-overlay"] button', { timeout: 3000 })
      .catch(() => undefined);
    await page.waitForTimeout(seconds * 1000);

    const after = await page.evaluate(() => {
      const player = (window as unknown as {
        __PLAYER__: { stats(): { steps: number; drawCalls: number; behaviors: number } | null; gameState(): Record<string, unknown> | null };
      }).__PLAYER__;
      return { stats: player.stats(), gameState: player.gameState() };
    });
    const steps = after.stats?.steps ?? 0;
    record('simulates', steps > seconds * 30, `${steps} fixed steps in ${seconds}s, ${after.stats?.drawCalls ?? 0} draw calls`);
    record('renders', (after.stats?.drawCalls ?? 0) > 0, `${after.stats?.drawCalls ?? 0} draw calls in the final frame`);

    const failedRequests = staticServer.requests.filter((entry) => entry.status >= 400);
    record('assets', failedRequests.length === 0, failedRequests.length === 0 ? `${staticServer.requests.length} requests, none failed` : failedRequests.map((entry) => `${entry.status} ${entry.url}`).join(', '));

    const realErrors = consoleErrors.filter((text) => !/Failed to load resource/.test(text));
    record('no-errors', realErrors.length === 0, realErrors.length === 0 ? 'clean console' : realErrors.slice(0, 3).join(' | '));

    const html = await page.content();
    record('hud-or-canvas', html.includes('game-canvas'), 'the game canvas is present');
    void scratch;
  } catch (error) {
    record('run', false, String(error));
  } finally {
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    if (exportDir && !options.keepBuild) {
      await rm(exportDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    ok: checks.every((check) => check.passed),
    checks,
    durationMs: Date.now() - started,
    exportDir: options.keepBuild ? exportDir : null,
  };
}

/** Absolute path of this repository, used by the CLI to locate tools. */
export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
