import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Page } from '@playwright/test';
import { startApiServer, type ApiServerHandle } from '../server/api.js';
import { Workspace } from '../server/workspace.js';
import { startStaticServer } from './static-server.js';
import { waitForPlaySteps } from './verify-wait.js';

/**
 * Stage 1 gate (plan §15).
 *
 * Deliverable: minimal project list/create, scene schema, one viewport, transform inspector,
 * save/load, undo, Play/Stop, crude export.
 *
 * Required evidence: move a box, save/reopen it, simulate a fresh copy, stop without
 * changing authoring state, and run the export independently.
 *
 * Usage: pnpm verify:stage1 [--skip-build] [--headed]
 */

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');
const headed = args.has('--headed');

interface CheckResult {
  id: string;
  title: string;
  passed: boolean;
  detail: string;
  observed?: unknown;
}

const checks: CheckResult[] = [];
const steps: Array<{ name: string; ok: boolean; detail: string }> = [];

function record(result: CheckResult): CheckResult {
  checks.push(result);
  process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'}  ${result.title}\n        ${result.detail}\n`);
  return result;
}

async function run(name: string, command: string, commandArgs: string[]): Promise<boolean> {
  process.stdout.write(`\n== ${name} ==\n$ ${command} ${commandArgs.join(' ')}\n`);
  try {
    const { stdout, stderr } = await execFileAsync(command, commandArgs, {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    process.stdout.write(`${`${stdout}${stderr}`.trim().split('\n').slice(-8).join('\n')}\n`);
    steps.push({ name, ok: true, detail: 'exit 0' });
    return true;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number; message: string };
    process.stdout.write(`${`${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n')}\n`);
    steps.push({ name, ok: false, detail: `exit ${failure.code ?? 'unknown'}` });
    return false;
  }
}

async function main(): Promise<void> {
  const evidenceDir = join(root, 'docs', 'evidence', 'stage1');
  await mkdir(evidenceDir, { recursive: true });

  const typecheckOk = await run('typecheck', 'pnpm', ['exec', 'tsc', '--noEmit']);
  const testsOk = await run('unit tests', 'pnpm', ['exec', 'vitest', 'run']);
  if (!skipBuild) {
    await run('production build', 'pnpm', ['exec', 'vite', 'build']);
  } else {
    steps.push({ name: 'production build', ok: true, detail: 'skipped (--skip-build)' });
  }
  if (!typecheckOk || !testsOk) {
    process.stdout.write('\nAborting browser checks: typecheck or unit tests failed.\n');
    process.exit(1);
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'coilbox-stage1-'));
  const workspace = new Workspace({ root: workspaceRoot, templatesRoot: join(root, 'templates') });
  await workspace.ensureRoot();
  const api: ApiServerHandle = await startApiServer({ workspace, port: 0, quiet: true } as never);
  const editorServer = await startStaticServer({
    root: join(root, 'dist'),
    prefix: '/',
    quiet: true,
    proxy: { '/api': api.url },
  });

  process.stdout.write(`\n== browser checks ==\neditor at ${editorServer.url}\nworkspace ${workspaceRoot}\napi ${api.url}\n`);

  const browser = await chromium.launch({
    headless: !headed,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });

  const consoleErrors: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));

    await page.goto(editorServer.url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__STUDIO__ !== undefined, undefined, {
      timeout: 30_000,
    });

    // --- create a project through the UI -------------------------------------
    await page.click('button:has-text("+ New game")');
    await page.fill('input[placeholder="collect-room"]', 'stage1-room');
    await page.fill('input[placeholder="Collect Room"]', 'Stage 1 Room');
    await page.click('button[type="submit"]:has-text("Create")');
    await page.waitForSelector('.studio', { timeout: 20_000 });
    await page.waitForSelector('.tree-row', { timeout: 20_000 });

    const treeNames = await page.locator('.tree-row .tree-name').allTextContents();
    record({
      id: 'project-create-open',
      title: 'Create a project and open it in the editor',
      passed: treeNames.length >= 4 && existsSync(join(workspaceRoot, 'stage1-room', 'game.json')),
      detail: `hierarchy lists ${treeNames.length} objects: ${treeNames.join(', ')}`,
      observed: treeNames,
    });

    // --- select an object and move it through the inspector -------------------
    await page.click('.tree-row:has-text("Player")');
    await page.waitForSelector('.inspector .section-title:has-text("Transform")', { timeout: 10_000 });
    const positionInputs = page.locator('.section:has-text("Transform") .vector-field').first().locator('input[type="number"]');
    await positionInputs.nth(0).fill('3');
    await positionInputs.nth(0).blur();
    await page.waitForTimeout(300);

    const moveResult = await page.evaluate(() => {
      const studio = window.__STUDIO__;
      const player = studio?.session.scene?.entities.find((entity) => entity.id === 'player');
      return {
        document: player ? player.transform.position : null,
        projected: studio?.viewport?.()?.project('player') ?? null,
      };
    });
    record({
      id: 'inspector-move',
      title: 'Move an object in the inspector: the authored document changes',
      passed: Array.isArray(moveResult.document) && moveResult.document[0] === 3,
      detail: `document position is ${JSON.stringify(moveResult.document)} (the file is written on Save, checked below)`,
      observed: moveResult.document,
    });

    record({
      id: 'viewport-projection',
      title: 'The viewport projection follows the document',
      passed: Array.isArray(moveResult.projected) && Math.abs((moveResult.projected[0] ?? 0) - 3) < 1e-6,
      detail: `the projected object sits at ${JSON.stringify(moveResult.projected)}`,
      observed: moveResult.projected,
    });

    // --- undo and redo --------------------------------------------------------
    await page.keyboard.press('Escape');
    await page.click('.tree-row:has-text("Player")');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);
    const afterUndo = await currentPosition(page);
    await page.keyboard.press('Control+Shift+z');
    await page.waitForTimeout(200);
    const afterRedo = await currentPosition(page);
    record({
      id: 'undo-redo',
      title: 'Undo reverts an inspector edit and redo restores it',
      passed: afterUndo !== null && Math.abs(afterUndo) < 1e-6 && afterRedo === 3,
      detail: `position after undo ${afterUndo}, after redo ${afterRedo}`,
      observed: { afterUndo, afterRedo },
    });

    // --- save ----------------------------------------------------------------
    await page.click('button:has-text("Save")');
    await page.waitForFunction(
      () => document.querySelector('.save-indicator')?.getAttribute('data-save-state') === 'clean',
      undefined,
      { timeout: 15_000 },
    );
    const savedDocument = await readSceneFromDisk(join(workspaceRoot, 'stage1-room', 'scenes', 'main.scene.json'));
    record({
      id: 'save-acknowledged',
      title: 'Save writes through the workspace service and only then reports "Saved"',
      passed:
        savedDocument !== null &&
        savedDocument.revision >= 1 &&
        savedDocument.entities.find((entity: { id: string }) => entity.id === 'player')?.transform.position[0] === 3,
      detail: `revision ${savedDocument?.revision}, player x=${savedDocument?.entities.find((entity: { id: string }) => entity.id === 'player')?.transform.position[0]}`,
      observed: { revision: savedDocument?.revision },
    });

    await page.screenshot({ path: join(evidenceDir, 'editor.png') });

    // --- reopen: the saved document is what loads -----------------------------
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__STUDIO__ !== undefined, undefined, {
      timeout: 30_000,
    });
    await page.click('.card:has-text("Stage 1 Room") button:has-text("Open")');
    await page.waitForSelector('.tree-row', { timeout: 20_000 });
    await page.click('.tree-row:has-text("Player")');
    await page.waitForTimeout(300);
    const reopenedX = await currentPosition(page);
    record({
      id: 'reopen-persists',
      title: 'Reopening the project loads the saved scene',
      passed: reopenedX === 3,
      detail: `player x after reopening is ${reopenedX}`,
      observed: reopenedX,
    });

    // --- Play / Stop ----------------------------------------------------------
    const authoredBefore = await currentPosition(page);
    await page.click('button:has-text("Play")');
    await page.waitForSelector('.viewport-badge', { timeout: 15_000 });
    // Wait for simulated steps, not for the wall clock: a slow machine runs fewer fixed steps per
    // second by design, and this check is about the world running at all.
    await waitForPlaySteps(page, 60, { source: 'editor' });

    const playState = await page.evaluate(() => {
      const viewport = window.__STUDIO__?.viewport?.();
      const pixels = viewport?.samplePlayPixels() ?? null;
      const stats = (viewport?.playStats() ?? null) as {
        steps: number;
        physicsBodies: number;
        entities: number;
        state: string;
      } | null;
      return { pixels, stats };
    });
    const playRendered = playState.pixels
      ? playState.pixels.nonBackgroundPixels / (playState.pixels.width * playState.pixels.height)
      : 0;
    record({
      id: 'play-runs',
      title: 'Play builds a fresh runtime world and simulates it',
      passed: Boolean(playState.pixels && playState.pixels.distinctColors > 8 && playRendered > 0.05 && (playState.stats?.steps ?? 0) > 30),
      detail: playState.pixels
        ? `${playState.pixels.distinctColors} distinct colours, ${(playRendered * 100).toFixed(1)}% rendered, ${playState.stats?.steps ?? 0} fixed steps, ${playState.stats?.physicsBodies ?? 0} physics bodies`
        : 'no play canvas',
      observed: playState,
    });

    await page.screenshot({ path: join(evidenceDir, 'play-mode.png') });

    // Pause and Step must advance exactly the tick that was asked for, and nothing while paused
    // (plan §16). Reading the play world's step counter is the only honest way to say that.
    const stepCount = () =>
      page.evaluate(() => (window.__STUDIO__?.viewport?.()?.playStats() as { steps: number } | null)?.steps ?? -1);
    await page.click('button:has-text("Pause")');
    await page.waitForTimeout(300);
    const pausedSteps = await stepCount();
    await page.waitForTimeout(400);
    const stillPausedSteps = await stepCount();
    await page.click('button:has-text("Step")');
    await page.waitForTimeout(300);
    const steppedSteps = await stepCount();
    await page.waitForTimeout(400);
    const afterStepSteps = await stepCount();
    record({
      id: 'pause-and-step',
      title: 'Pause stops the clock and Step advances exactly one tick',
      passed:
        pausedSteps > 0 &&
        stillPausedSteps === pausedSteps &&
        steppedSteps === pausedSteps + 1 &&
        afterStepSteps === steppedSteps,
      detail: `paused at ${pausedSteps} steps, still ${stillPausedSteps} after 400 ms, ${steppedSteps} after one Step (and ${afterStepSteps} 400 ms later)`,
      observed: { pausedSteps, stillPausedSteps, steppedSteps, afterStepSteps },
    });

    await page.click('button:has-text("Stop")');
    await page.waitForSelector('.viewport-badge', { state: 'detached', timeout: 10_000 });
    await page.waitForTimeout(300);

    const authoredAfter = await currentPosition(page);
    record({
      id: 'play-does-not-mutate',
      title: 'Stop leaves the authored scene exactly as it was',
      passed: authoredAfter === authoredBefore,
      detail: `authored x before play ${authoredBefore}, after stop ${authoredAfter}`,
      observed: { authoredBefore, authoredAfter },
    });

    // --- export ---------------------------------------------------------------
    await page.click('button:has-text("Export Game")');
    await page.waitForFunction(
      () => (document.querySelector('.statusbar span')?.textContent ?? '').includes('Exported to'),
      undefined,
      { timeout: 120_000 },
    );
    const exportDir = join(workspaceRoot, 'stage1-room', '.coilbox', 'export');
    const exportIndex = join(exportDir, 'index.html');
    const exportedGame = await readFile(join(exportDir, 'project', 'game.json'), 'utf8').catch(() => null);
    record({
      id: 'export-produces-build',
      title: 'Export Game produces a standalone player plus the project documents',
      passed: existsSync(exportIndex) && exportedGame !== null,
      detail: existsSync(exportIndex)
        ? `index.html and project documents present in ${exportDir}`
        : `no index.html in ${exportDir}`,
      observed: { exportDir },
    });

    // The editor service is no longer needed: serve the export on its own origin. The editor page
    // is closed first, because an open tab keeps polling the service and would turn its shutdown
    // into console errors that have nothing to do with the product.
    await page.close();
    await api.close();
    const exportServer = await startStaticServer({ root: exportDir, prefix: '/games/stage1/', quiet: true });
    try {
      const exportPage = await context.newPage();
      exportPage.on('pageerror', (error) => consoleErrors.push(`export: ${String(error)}`));
      await exportPage.goto(exportServer.url, { waitUntil: 'load' });
      await exportPage.waitForFunction(() => window.__PLAYER__ !== undefined, undefined, {
        timeout: 30_000,
      });
      await exportPage.evaluate(() => window.__PLAYER__?.ready);
      // Steps, not seconds: the check is that the exported game renders, and a slow runner takes
      // fewer frames per second without the export being any less correct.
      await waitForPlaySteps(exportPage, 60);
      const exportState = await exportPage.evaluate(() => {
        const player = window.__PLAYER__;
        if (!player) throw new Error('no player');
        const pixels = player.samplePixels() as {
          nonBackgroundPixels: number;
          distinctColors: number;
          width: number;
          height: number;
        };
        return { state: player.state(), pixels };
      });
      const rendered = exportState.pixels.nonBackgroundPixels / (exportState.pixels.width * exportState.pixels.height);
      await exportPage.screenshot({ path: join(evidenceDir, 'export.png') });

      const failures = exportServer.requests.filter((entry) => entry.status >= 400);
      record({
        id: 'export-runs-standalone',
        title: 'The export runs with the editor and workspace service switched off',
        passed:
          failures.length === 0 &&
          (exportState.state as { errors: string[] }).errors.length === 0 &&
          rendered > 0.03 &&
          exportState.pixels.distinctColors > 8,
        detail: `${(exportState.state as { state: string }).state} at ${exportServer.url} — ${(rendered * 100).toFixed(1)}% rendered, ${exportState.pixels.distinctColors} colours, ${failures.length} failed requests`,
        observed: { requests: exportServer.requests.length, failures: failures.length },
      });
    } finally {
      await exportServer.close();
    }

    record({
      id: 'no-console-errors',
      title: 'No page errors in the editor or the export',
      passed: consoleErrors.length === 0,
      detail: consoleErrors.length === 0 ? 'clean console' : consoleErrors.slice(0, 4).join(' | '),
      observed: consoleErrors,
    });
  } finally {
    await browser.close();
    await editorServer.close();
    await api.close().catch(() => {});
  }

  const evidence = {
    stage: 1,
    generatedAt: new Date().toISOString(),
    node: process.version,
    workspaceRoot,
    steps,
    checks,
  };
  await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  const failed = checks.filter((check) => !check.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  process.stdout.write('Evidence written to docs/evidence/stage1/evidence.json\n');
  await rm(workspaceRoot, { recursive: true, force: true });
  if (failed.length > 0 || steps.some((step) => !step.ok)) {
    process.stdout.write('\nSTAGE 1 GATE FAILED\n');
    process.exit(1);
  }
  process.stdout.write('\nSTAGE 1 GATE PASSED\n');
}

async function readSceneFromDisk(path: string): Promise<{ revision: number; entities: Array<{ id: string; transform: { position: number[] } }> } | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as { revision: number; entities: Array<{ id: string; transform: { position: number[] } }> };
  } catch {
    return null;
  }
}

async function currentPosition(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const player = window.__STUDIO__?.session.scene?.entities.find((entity) => entity.id === 'player');
    return player ? player.transform.position[0] : null;
  });
}

await main();
