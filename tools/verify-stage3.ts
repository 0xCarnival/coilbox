import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Page } from '@playwright/test';
import { startApiServer, type ApiServerHandle } from '../server/api.js';
import { Workspace } from '../server/workspace.js';
import { startStaticServer } from './static-server.js';
import { playSteps, stepsForSeconds, waitForPlaySteps } from './verify-wait.js';

/**
 * Stage 3 gate (plan §15).
 *
 * Deliverable: physics components, registered behaviors, player input/camera, HUD, game rules,
 * transitions.
 *
 * Required evidence: "Both demonstration games are playable using the shared runtime; level
 * layout and key tuning values are editable."
 *
 * Both games are played through the standalone player — the same runtime an export ships — with
 * real keyboard and pointer input. The editing half runs in the studio, changing tuning values
 * and observing the effect in the next play session.
 *
 * Usage: pnpm verify:stage3 [--skip-build] [--headed]
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

function record(result: CheckResult): void {
  checks.push(result);
  process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'}  ${result.title}\n        ${result.detail}\n`);
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
    process.stdout.write(`${`${stdout}${stderr}`.trim().split('\n').slice(-6).join('\n')}\n`);
    steps.push({ name, ok: true, detail: 'exit 0' });
    return true;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    process.stdout.write(`${`${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim().split('\n').slice(-30).join('\n')}\n`);
    steps.push({ name, ok: false, detail: `exit ${failure.code ?? 'unknown'}` });
    return false;
  }
}

async function main(): Promise<void> {
  const evidenceDir = join(root, 'docs', 'evidence', 'stage3');
  await mkdir(evidenceDir, { recursive: true });

  const typecheckOk = await run('typecheck', 'pnpm', ['exec', 'tsc', '--noEmit']);
  const testsOk = await run('unit tests', 'pnpm', ['exec', 'vitest', 'run']);
  if (!skipBuild) {
    await run('game sources', 'pnpm', ['exec', 'tsx', 'tools/write-games.ts']);
    await run('production build', 'pnpm', ['exec', 'vite', 'build']);
  }
  if (!typecheckOk || !testsOk) {
    process.stdout.write('\nAborting browser checks: typecheck or unit tests failed.\n');
    process.exit(1);
  }

  // Copy the two games into a scratch workspace so the checks never mutate the committed ones.
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'coilbox-stage3-'));
  const workspace = new Workspace({ root: workspaceRoot, templatesRoot: join(root, 'templates') });
  await workspace.ensureRoot();
  for (const id of ['collect-room', 'physics-targets']) {
    await execFileAsync('cp', ['-R', join(root, 'games', id), join(workspaceRoot, id)]);
  }
  for (const id of ['collect-room', 'physics-targets']) {
    const validation = await workspace.validateProject(id);
    record({
      id: `validate-${id}`,
      title: `The ${id} project validates on disk`,
      passed: validation.ok,
      detail: validation.ok ? 'no validation errors' : validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
    });
  }

  const api: ApiServerHandle = await startApiServer({ workspace, port: 0 });
  const server = await startStaticServer({
    root: join(root, 'dist'),
    prefix: '/',
    quiet: true,
    // Games sit next to the player on one origin, exactly as an exported build does.
    mounts: { '/games/': workspaceRoot },
    proxy: { '/api': api.url },
  });

  process.stdout.write(`\n== browser checks ==\nstudio at ${server.url}\nworkspace ${workspaceRoot}\n`);

  const browser = await chromium.launch({
    headless: !headed,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });

  const consoleErrors: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

    // ---------------------------------------------------------------- collect-room
    const collect = await context.newPage();
    collect.on('pageerror', (error) => consoleErrors.push(`collect-room: ${String(error)}`));
    collect.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`collect-room: ${message.text()}`);
    });
    await collect.goto(`${server.url}player.html?project=./games/collect-room/`, { waitUntil: 'load' });
    await collect.waitForFunction(() => window.__PLAYER__ !== undefined, undefined, {
      timeout: 30_000,
    });
    await collect.evaluate(() => window.__PLAYER__?.ready);

    const collectBehaviors = await collect.evaluate(() => window.__PLAYER__?.behaviorList() ?? []);
    record({
      id: 'collect-room-behaviors',
      title: 'Collect Room runs registered behaviors from the shared runtime',
      passed: collectBehaviors.length >= 5 && collectBehaviors.some((entry) => entry.behaviorId === 'player.mover'),
      detail: `${collectBehaviors.length} behavior instances: ${[...new Set(collectBehaviors.map((entry) => entry.behaviorId))].join(', ')}`,
      observed: collectBehaviors,
    });

    // Dismiss the start overlay the way a player does; the click also unlocks audio.
    await collect.click('.coilbox-hud .hud-overlay[data-hud-id="start-overlay"] button');
    await collect.waitForTimeout(400);

    // Walk the player: hold a movement key for a fixed amount of *simulated* time and check the
    // physics body actually moved. Wall-clock waits would measure the machine, not the engine: a
    // slow runner takes fewer fixed steps in the same second and the player walks less far.
    const beforeWalk = await readPlayer(collect);
    const walkStartSteps = await playSteps(collect);
    await collect.keyboard.down('KeyW');
    await waitForPlaySteps(collect, walkStartSteps + stepsForSeconds(1.2));
    await collect.keyboard.up('KeyW');
    const afterWalk = await readPlayer(collect);
    const walked = Math.hypot(afterWalk.x - beforeWalk.x, afterWalk.z - beforeWalk.z);
    // Horizontal distance alone is not enough: a character that falls through the floor still
    // "moves". The player must stay on the floor while walking.
    const grounded = afterWalk.y > -0.25 && afterWalk.y < 0.6;
    record({
      id: 'collect-room-input',
      title: 'Keyboard input drives the character mover, and it stays on the floor',
      passed: walked > 1.5 && grounded,
      detail: `player moved ${walked.toFixed(2)} m from (${beforeWalk.x.toFixed(1)}, ${beforeWalk.z.toFixed(1)}) to (${afterWalk.x.toFixed(1)}, ${afterWalk.z.toFixed(1)}); y went ${beforeWalk.y.toFixed(2)} → ${afterWalk.y.toFixed(2)}`,
      observed: { beforeWalk, afterWalk, walked, grounded },
    });

    // Walk into the far wall (plan §16: "character-wall contact"). The room's south wall has its
    // inner face at z = 7.75 and the character capsule has a 0.35 m radius, so a mover that is not
    // blocked ends up beyond z = 8 and, if it is sinking, keeps creeping for the whole hold.
    await collect.keyboard.down('KeyW');
    const wallStartSteps = await playSteps(collect);
    await waitForPlaySteps(collect, wallStartSteps + stepsForSeconds(4)); // long enough to arrive
    const atWall = await readPlayer(collect);
    const atWallSteps = await playSteps(collect);
    await waitForPlaySteps(collect, atWallSteps + stepsForSeconds(1.5)); // pressed against it
    const stillAtWall = await readPlayer(collect);
    // Keep walking forward and add "right": the wall should pin the forward axis while the
    // character slides along it, which is what makes a room feel solid rather than sticky.
    await collect.keyboard.down('KeyD');
    const slideStartSteps = await playSteps(collect);
    await waitForPlaySteps(collect, slideStartSteps + stepsForSeconds(0.9));
    const slid = await readPlayer(collect);
    await collect.keyboard.up('KeyD');
    await collect.keyboard.up('KeyW');
    const approachGap = stillAtWall.z - atWall.z;
    const slideDistance = Math.abs(slid.x - stillAtWall.x);
    const pinned = Math.abs(slid.z - stillAtWall.z) < 0.05;
    record({
      id: 'collect-room-wall-contact',
      title: 'A wall stops the character, and a diagonal push slides along it',
      passed:
        atWall.z > 6.4 &&
        atWall.z < 7.8 &&
        stillAtWall.z < 7.8 &&
        Math.abs(approachGap) < 0.05 &&
        slideDistance > 0.5 &&
        pinned &&
        slid.y > -0.25 &&
        slid.y < 0.6,
      detail: `walked into the wall at z=7.75: stopped at (${atWall.x.toFixed(2)}, ${atWall.y.toFixed(2)}, ${atWall.z.toFixed(2)}); 1.5 s later z=${stillAtWall.z.toFixed(3)} (moved ${approachGap.toFixed(4)} m); walking forward and right slid ${slideDistance.toFixed(2)} m along the wall to x=${slid.x.toFixed(2)} at z=${slid.z.toFixed(3)}`,
      observed: { atWall, stillAtWall, slid, approachGap, slideDistance, pinned },
    });

    // Collect every gem by moving it onto the player (an ordinary authored transform change
    // through the physics adapter), then check the score.
    const gemTargets = await collect.evaluate(
      () =>
        window.__PLAYER__?.session?.current?.getEntityIds().filter((id) => id.startsWith('collectible-')) ?? [],
    );
    for (const gem of gemTargets) {
      await moveEntityOntoPlayer(collect, gem);
      await collect.waitForTimeout(450);
    }
    const afterCollect = await collect.evaluate(() => window.__PLAYER__?.gameState() ?? null);
    record({
      id: 'collect-room-triggers',
      title: 'Sensor triggers collect the gems and update the score',
      passed: Number(afterCollect?.score ?? 0) >= gemTargets.length,
      detail: `score ${afterCollect?.score} after visiting ${gemTargets.length} gems; remaining ${afterCollect?.collectiblesRemaining}`,
      observed: afterCollect,
    });

    // Reach the exit: the level must report a win through the shared rules behavior.
    await moveEntityOntoPlayer(collect, 'exit-zone');
    await collect.waitForTimeout(900);
    const afterExit = await collect.evaluate(() => window.__PLAYER__?.gameState() ?? null);
    const hudVisible = await collect
      .locator('.coilbox-hud .hud-overlay[data-hud-id="win-overlay"]')
      .isVisible()
      .catch(() => false);
    await collect.screenshot({ path: join(evidenceDir, 'collect-room-win.png') });
    record({
      id: 'collect-room-win',
      title: 'Reaching the exit with the gems collected wins the level and shows the HUD overlay',
      passed: afterExit?.won === true && hudVisible,
      detail: `won=${afterExit?.won}, objective="${afterExit?.objective}", overlay visible=${hudVisible}`,
      observed: { won: afterExit?.won, objective: afterExit?.objective, hudVisible },
    });

    // Restart from the HUD button: a fresh world with the initial state.
    await collect.click('.coilbox-hud .hud-overlay[data-hud-id="win-overlay"] button');
    await collect.waitForTimeout(900);
    const restartedPlayer = await readPlayer(collect);
    record({
      id: 'collect-room-restart-position',
      title: 'After a restart the player is standing in the rebuilt level, not falling',
      passed: restartedPlayer.y > -0.25 && restartedPlayer.y < 1.2,
      detail: `player at (${restartedPlayer.x.toFixed(1)}, ${restartedPlayer.y.toFixed(2)}, ${restartedPlayer.z.toFixed(1)}) after restart`,
      observed: restartedPlayer,
    });
    const afterRestart = await collect.evaluate(() => window.__PLAYER__?.gameState() ?? null);
    record({
      id: 'collect-room-restart',
      title: 'Restart from the win overlay rebuilds the scene from the start',
      passed: Number(afterRestart?.score ?? -1) === 0 && afterRestart?.won === false,
      detail: `after restart score=${afterRestart?.score}, won=${afterRestart?.won}`,
      observed: afterRestart,
    });

    // ---------------------------------------------------------------- physics-targets
    const targets = await context.newPage();
    targets.on('pageerror', (error) => consoleErrors.push(`physics-targets: ${String(error)}`));
    targets.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`physics-targets: ${message.text()}`);
    });
    await targets.goto(`${server.url}player.html?project=./games/physics-targets/`, { waitUntil: 'load' });
    await targets.waitForFunction(() => window.__PLAYER__ !== undefined, undefined, {
      timeout: 30_000,
    });
    await targets.evaluate(() => window.__PLAYER__?.ready);
    await targets.click('.coilbox-hud .hud-overlay[data-hud-id="start-overlay"] button');
    await targets.waitForTimeout(400);

    const targetBehaviors = await targets.evaluate(() => window.__PLAYER__?.behaviorList() ?? []);
    const targetCount = targetBehaviors.filter((entry) => entry.behaviorId === 'game.target').length;
    record({
      id: 'targets-behaviors',
      title: 'Physics Targets uses the same runtime with its own behaviors',
      passed: targetCount === 5 && targetBehaviors.some((entry) => entry.behaviorId === 'game.launcher'),
      detail: `${targetCount} knock-down targets and a launcher registered`,
      observed: targetBehaviors,
    });

    // Launch the ball repeatedly and count knock-downs.
    const knocked = await knockDownTargets(targets, 8);
    const boardState = await targets.evaluate(() => window.__PLAYER__?.gameState() ?? null);
    await targets.screenshot({ path: join(evidenceDir, 'physics-targets.png') });
    record({
      id: 'targets-physics',
      title: 'Clicking launches the ball and knocking targets down updates the score',
      passed: knocked > 0 && Number(boardState?.score ?? 0) === knocked,
      detail: `${knocked} targets knocked down, score ${boardState?.score}, launches ${boardState?.launches}`,
      observed: { knocked, boardState },
    });

    // ---------------------------------------------------------------- editor tuning
    const studio = await context.newPage();
    studio.on('pageerror', (error) => consoleErrors.push(`studio: ${String(error)}`));
    await studio.goto(server.url, { waitUntil: 'load' });
    await studio.waitForFunction(() => window.__STUDIO__ !== undefined, undefined, {
      timeout: 30_000,
    });
    await studio.click('.card:has-text("Collect Room") button:has-text("Open")');
    await studio.waitForSelector('.tree-row', { timeout: 20_000 });
    await studio.click('.tree-row:has-text("Player")');
    await studio.waitForSelector('.section-title:has-text("Character Mover")', { timeout: 15_000 });

    const fields = await studio.locator('.section:has(.section-title:text-is("Character Mover")) .field-label').allTextContents();
    const speedInput = studio
      .locator('.section:has(.section-title:text-is("Character Mover")) .field:has(.field-label:text-is("Move speed")) input')
      .first();
    await speedInput.fill('12');
    await speedInput.blur();
    await studio.waitForTimeout(200);

    const tuned = await studio.evaluate(() => {
      const session = window.__STUDIO__?.session;
      const player = session?.scene?.entities.find((entity) => entity.id === 'player');
      const behavior = player?.components.find((component) => component.type === 'behavior');
      return behavior?.properties ?? null;
    });
    record({
      id: 'editor-tuning',
      title: 'Key tuning values are editable in the inspector without touching code',
      passed: (tuned as { moveSpeed?: number } | null)?.moveSpeed === 12 && fields.includes('Move speed') && fields.includes('Jump strength'),
      detail: `Character Mover exposes ${fields.filter((label) => label.length > 0).join(', ')}; move speed is now ${(tuned as { moveSpeed?: number } | null)?.moveSpeed}`,
      observed: { fields, tuned },
    });

    // Save, play the edited game, and confirm the new speed changes the outcome.
    await studio.click('button[aria-label="Save"]');
    await studio.waitForFunction(
      () => document.querySelector('.save-indicator')?.getAttribute('data-save-state') === 'clean',
      undefined,
      { timeout: 20_000 },
    );
    await studio.click('button:has-text("Play")');
    await studio.waitForSelector('.viewport-badge', { timeout: 20_000 });
    await waitForPlaySteps(studio, 30, { source: 'editor' });
    await studio.click('.hud-host .hud-overlay[data-hud-id="start-overlay"] button');
    const studioBefore = await studioPlayerPosition(studio);
    const tunedStartSteps = await playSteps(studio, 'editor');
    await studio.keyboard.down('KeyW');
    // A fixed amount of simulated time, so the distance is the engine's business and not the
    // runner's: at 12 m/s over 1.2 s of simulation the player owes about 14 m, and acceleration
    // eats into that at the start.
    await waitForPlaySteps(studio, tunedStartSteps + stepsForSeconds(1.2), { source: 'editor' });
    await studio.keyboard.up('KeyW');
    const studioAfter = await studioPlayerPosition(studio);
    const studioWalked = Math.hypot(studioAfter.x - studioBefore.x, studioAfter.z - studioBefore.z);

    // Compare against what the *default* speed (5 m/s) could have covered in the same simulated
    // time: anything clearly above that is the tuning taking effect.
    const defaultSpeedDistance = 5 * (stepsForSeconds(1.2) / 60);
    record({
      id: 'editor-tuning-affects-play',
      title: 'The edited tuning value changes how the game plays',
      passed: studioWalked > defaultSpeedDistance,
      detail: `with move speed 12 the player covered ${studioWalked.toFixed(2)} m over ${stepsForSeconds(1.2)} simulated steps; at the default 5 m/s the same time allows ${defaultSpeedDistance.toFixed(2)} m`,
      observed: { studioWalked, defaultSpeedDistance, before: studioBefore, after: studioAfter },
    });

    await studio.screenshot({ path: join(evidenceDir, 'studio-play-collect-room.png') });
    await studio.click('button[aria-label="Stop and discard the simulation"]');
    await studio.waitForSelector('.viewport-badge', { state: 'detached', timeout: 15_000 });

    record({
      id: 'no-console-errors',
      title: 'No page errors while playing or editing either game',
      passed: consoleErrors.filter((text) => !/404|Failed to load resource/i.test(text)).length === 0,
      detail: consoleErrors.filter((text) => !/404|Failed to load resource/i.test(text)).slice(0, 3).join(' | ') || 'clean console',
      observed: consoleErrors.slice(0, 5),
    });
  } finally {
    await browser.close();
    await server.close();
    await api.close().catch(() => {});
  }

  const evidence = {
    stage: 3,
    generatedAt: new Date().toISOString(),
    node: process.version,
    workspaceRoot,
    steps,
    checks,
  };
  await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  const failed = checks.filter((check) => !check.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  process.stdout.write('Evidence written to docs/evidence/stage3/evidence.json\n');
  await rm(workspaceRoot, { recursive: true, force: true });
  if (failed.length > 0 || steps.some((step) => !step.ok)) {
    process.stdout.write('\nSTAGE 3 GATE FAILED\n');
    process.exit(1);
  }
  process.stdout.write('\nSTAGE 3 GATE PASSED\n');
}

// ------------------------------------------------------------------ helpers

async function readPlayer(page: Page): Promise<{ x: number; y: number; z: number }> {
  return page.evaluate(() => {
    const world = window.__PLAYER__?.session?.current;
    const out = new Float32Array(7);
    world?.readEntityTransform('player', out);
    return { x: out[0]!, y: out[1]!, z: out[2]! };
  });
}

/**
 * Move one entity onto the player through the physics adapter.
 *
 * The character mover owns the player's transform, so a check cannot drag the player around;
 * moving the target is the equivalent authored change and exercises exactly the same trigger
 * code path.
 */
async function moveEntityOntoPlayer(page: Page, entityId: string): Promise<void> {
  await page.evaluate((id: string) => {
    const runtime = window.__PLAYER__?.session?.current;
    if (!runtime) return;
    const player = new Float32Array(7);
    if (!runtime.readEntityTransform('player', player)) return;
    runtime.getPhysics().setTransform(id, [player[0], player[1] + 0.6, player[2]], [0, 0, 0, 1]);
  }, entityId);
}

/** Player position inside the editor's play world (not the editor projection). */
async function studioPlayerPosition(page: Page): Promise<{ x: number; y: number; z: number }> {
  return page.evaluate(() => {
    const position = window.__STUDIO__?.viewport?.()?.playEntityTransform('player') ?? [0, 0, 0];
    return { x: position[0], y: position[1], z: position[2] };
  });
}

/** Fire the launcher repeatedly, aiming at each target, and report how many went down. */
async function knockDownTargets(page: Page, attempts: number): Promise<number> {
  for (let index = 0; index < attempts; index += 1) {
    const aim = await page.evaluate((attempt: number) => {
      const runtime = window.__PLAYER__?.session?.current;
      if (!runtime) return null;
      const ids = runtime.getEntityIds().filter((id) => id.startsWith('target-'));
      const transform = new Float32Array(7);
      const candidates: Array<{ id: string; x: number; upright: number }> = [];
      for (const id of ids) {
        if (!runtime.readEntityTransform(id, transform)) continue;
        const [, , , qx, , qz] = transform;
        candidates.push({ id, x: transform[0]!, upright: 1 - 2 * (qx * qx + qz * qz) });
      }
      const standing = candidates.filter((candidate) => candidate.upright > 0.7);
      if (standing.length === 0) return null;
      return standing[attempt % standing.length] ?? null;
    }, index);
    if (!aim) break;
    // Click left/right of centre to bias the launch toward the chosen target.
    const offset = Math.max(-0.9, Math.min(0.9, aim.x / 6));
    const x = Math.round(640 + offset * 420);
    await page.mouse.click(x, 420);
    await page.waitForTimeout(1100);
  }
  const state = await page.evaluate(() => window.__PLAYER__?.gameState() ?? null);
  return Number(state?.targetsDown ?? 0);
}

await main();
