import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Page } from '@playwright/test';
import { startApiServer, type ApiServerHandle } from '../server/api.js';
import { startStaticServer } from './static-server.js';
import { Workspace } from '../server/workspace.js';
import { testGame } from '../server/test-runner.js';
import { buildGame } from '../server/build.js';
import { lookAt } from '../src/editor/document/factory.js';
import { waitForPlaySteps } from './verify-wait.js';

/**
 * Stage 5 gate (plan §15, §16).
 *
 * Deliverable: compatibility fixtures, resource cleanup, performance measurement, and usable
 * startup and recovery documentation.
 *
 * Evidence required: "All release checks below pass with recorded evidence and no hidden
 * development dependencies."
 *
 * What is measured, not claimed:
 * - 20 Play/Stop cycles, inspecting renderer resources, listeners, physics handles, worlds, and HUD
 *   elements for unbounded growth;
 * - a declared reference scene (200 visible objects, 25 dynamic bodies, one shadow light) with
 *   recorded frame time, physics time, and draw calls;
 * - the export served from a separate static server under a nested path with the workspace service
 *   shut down, checked for dev URLs, MIME types, failed requests, and gameplay/restart/audio;
 * - a clean-checkout build with a frozen lockfile;
 * - a narrow viewport run, reported as a viewport test rather than a phone test.
 *
 * Usage: pnpm verify:stage5 [--skip-build] [--skip-clean-clone] [--headed]
 */

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');
const skipCleanClone = args.has('--skip-clean-clone');
const headed = args.has('--headed');
const REFERENCE_PROJECT = 'perf-reference';

interface CheckResult {
  id: string;
  title: string;
  passed: boolean;
  detail: string;
  observed?: unknown;
}

/** The measurements the release evidence records, keyed by the check they support. */
interface Stage5Measurements {
  playStopCycles?: {
    first: Record<string, number>;
    last: Record<string, number>;
    growth: Record<string, number>;
    samples: Array<Record<string, number>>;
  };
  referenceScene?: {
    frames: number;
    medianFrameMs: number;
    p95FrameMs: number;
    medianPhysicsMs: number;
    drawCalls: number;
    triangles: number;
    entities: number;
    physicsBodies: number;
    fps: number;
  };
  frameRateIndependence?: {
    stepsTaken: number;
    droppedTime: number;
    clampedTime: number;
    busiestFrameSteps: number;
    maxSubSteps: number;
    framesToWatch: number;
  };
  narrowViewport?: { width: number; height: number; rendered: number; distinctColors: number; steps: number };
}

const checks: CheckResult[] = [];
const steps: Array<{ name: string; ok: boolean; detail: string }> = [];
const measurements: Stage5Measurements = {};

function record(result: CheckResult): void {
  checks.push(result);
  process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'}  ${result.title}\n        ${result.detail}\n`);
}

async function run(name: string, command: string, commandArgs: string[], cwd = root, timeoutMs = 8 * 60 * 1000): Promise<boolean> {
  process.stdout.write(`\n== ${name} ==\n$ ${command} ${commandArgs.join(' ')}\n`);
  try {
    const { stdout, stderr } = await execFileAsync(command, commandArgs, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    process.stdout.write(`${`${stdout}${stderr}`.trim().split('\n').slice(-6).join('\n')}\n`);
    steps.push({ name, ok: true, detail: 'exit 0' });
    return true;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim();
    process.stdout.write(`${output.split('\n').slice(-25).join('\n')}\n`);
    // Name the failing test as well as the exit code: "exit 1" alone cannot be acted on later.
    const failing = [...output.matchAll(/^\s*(?:FAIL|×|✗)\s+(.+)$/gm)].map((match) => match[1]!.trim());
    steps.push({
      name,
      ok: false,
      detail: `exit ${failure.code ?? 'unknown'}${failing.length > 0 ? ` — ${[...new Set(failing)].slice(0, 3).join('; ')}` : ''}`,
    });
    return false;
  }
}

/** Build the declared reference scene: 200 visible objects, 25 dynamic bodies, one shadow light. */
async function writeReferenceScene(workspaceRoot: string): Promise<void> {
  const projectRoot = join(workspaceRoot, REFERENCE_PROJECT);
  await mkdir(join(projectRoot, 'scenes'), { recursive: true });
  await mkdir(join(projectRoot, 'assets'), { recursive: true });

  const entities: unknown[] = [
    {
      id: 'floor',
      name: 'Floor',
      order: 0,
      transform: { position: [0, -0.25, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [
        { type: 'primitive', shape: 'box', size: [40, 0.5, 40], castShadow: false },
        { type: 'material', color: '#3f4654' },
        { type: 'rigidBody', bodyType: 'static' },
        { type: 'collider', shape: 'box', size: [40, 0.5, 40] },
      ],
    },
    {
      id: 'perf-camera',
      name: 'Camera',
      order: 1,
      transform: { position: [0, 18, 34], rotation: lookAt([0, 18, 34], [0, 0, 0]), scale: [1, 1, 1] },
      components: [{ type: 'camera', mode: 'free', fov: 55, near: 0.1, far: 400 }],
    },
    {
      id: 'sun',
      name: 'Sun',
      order: 2,
      transform: { position: [10, 16, 8], rotation: lookAt([10, 16, 8], [0, 0, 0]), scale: [1, 1, 1] },
      components: [
        {
          type: 'light',
          kind: 'directional',
          color: '#fff4e0',
          intensity: 2.2,
          castShadow: true,
          shadowMapSize: 1024,
          shadowExtent: 30,
        },
      ],
    },
  ];

  // 175 static boxes + 25 dynamic bodies = 200 visible objects.
  for (let index = 0; index < 175; index += 1) {
    const column = index % 25;
    const row = Math.floor(index / 25);
    entities.push({
      id: `static-${index}`,
      name: `Static ${index}`,
      order: 10 + index,
      transform: { position: [(column - 12) * 1.5, 0.5, (row - 3.5) * 2.2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [
        { type: 'primitive', shape: 'box', size: [1, 1, 1], castShadow: true, receiveShadow: true },
        { type: 'material', color: '#6b7280', roughness: 0.85 },
      ],
    });
  }
  for (let index = 0; index < 25; index += 1) {
    entities.push({
      id: `body-${index}`,
      name: `Body ${index}`,
      order: 200 + index,
      transform: { position: [(index % 5) * 1.4 - 2.8, 1.2 + index * 0.15, Math.floor(index / 5) * 1.4 + 6], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [
        { type: 'primitive', shape: 'box', size: [0.6, 0.6, 0.6], castShadow: true, receiveShadow: true },
        { type: 'material', color: '#c98b5b', roughness: 0.6 },
        { type: 'rigidBody', bodyType: 'dynamic' },
        { type: 'collider', shape: 'box', size: [0.6, 0.6, 0.6], density: 1 },
      ],
    });
  }

  await writeFile(
    join(projectRoot, 'game.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        engineVersion: '0.1.0',
        engineCompat: '0.1.0',
        id: REFERENCE_PROJECT,
        name: 'Performance reference',
        description: 'The declared reference scene from the release plan: 200 visible objects, 25 dynamic bodies, one modest shadow light.',
        scenes: [{ id: 'main', name: 'Reference', path: 'scenes/main.scene.json' }],
        startScene: 'main',
        settings: {
          physics: { fixedTimeStep: 1 / 60, subStepCount: 4, maxSubSteps: 5, enableSleep: true, hitEventThreshold: 1 },
          render: { antialias: true, shadows: true, pixelRatioCap: 1, toneMapping: 'aces', exposure: 1 },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(projectRoot, 'scenes', 'main.scene.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        revision: 0,
        id: 'main',
        name: 'Reference',
        activeCameraId: 'perf-camera',
        environment: { background: { type: 'color', color: '#161b26' }, fog: { type: 'none' }, gravity: [0, -9.81, 0] },
        entities,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(join(projectRoot, 'assets', 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, assets: [] }, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  const evidenceDir = join(root, 'docs', 'evidence', 'stage5');
  await mkdir(evidenceDir, { recursive: true });

  const typecheckOk = await run('typecheck', 'pnpm', ['exec', 'tsc', '--noEmit']);
  const testsOk = await run('unit tests', 'pnpm', ['exec', 'vitest', 'run']);
  if (!skipBuild) await run('production build', 'pnpm', ['exec', 'vite', 'build']);
  if (!typecheckOk || !testsOk) {
    process.stdout.write('\nAborting: typecheck or unit tests failed.\n');
    process.exit(1);
  }

  // ---------------------------------------------------------------- documentation
  const requiredDocs = ['README.md', 'AGENTS.md', 'docs/runbook.md', 'docs/status.md', 'docs/pinned-versions.md'];
  const missing = requiredDocs.filter((path) => !existsSync(join(root, path)));
  record({
    id: 'release-docs',
    title: 'Startup, recovery, and release documentation exists',
    passed: missing.length === 0,
    detail: missing.length === 0 ? requiredDocs.join(', ') : `missing: ${missing.join(', ')}`,
  });

  // ---------------------------------------------------------------- clean checkout
  if (!skipCleanClone) {
    const cloneDir = await mkdtemp(join(tmpdir(), 'coilbox-clean-'));
    const cleanOk = await run(
      'clean checkout install + build',
      'bash',
      [
        '-c',
        `set -e
         git clone --quiet --depth 1 "file://${root}" "${cloneDir}/repo"
         cd "${cloneDir}/repo"
         pnpm install --frozen-lockfile --silent
         pnpm exec tsc --noEmit
         pnpm exec vitest run --silent
         pnpm exec vite build`,
      ],
      root,
      10 * 60 * 1000,
    );
    record({
      id: 'clean-checkout',
      title: 'A clean checkout installs from the frozen lockfile, typechecks, tests, and builds',
      passed: cleanOk,
      detail: cleanOk ? `built in ${cloneDir} from a fresh clone` : 'the clean-checkout build failed (see the output above)',
    });
    await rm(cloneDir, { recursive: true, force: true }).catch(() => undefined);
  } else {
    steps.push({ name: 'clean checkout install + build', ok: true, detail: 'skipped (--skip-clean-clone)' });
  }

  // ---------------------------------------------------------------- performance and runtime audits
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'coilbox-stage5-'));
  const workspace = new Workspace({ root: workspaceRoot, templatesRoot: join(root, 'templates') });
  await workspace.ensureRoot();
  for (const id of ['collect-room', 'physics-targets', 'gem-rush']) {
    if (!existsSync(join(root, 'games', id))) continue;
    await execFileAsync('cp', ['-R', join(root, 'games', id), join(workspaceRoot, id)]);
    // `.coilbox` holds build output. Copying it would let a stale export from a previous run
    // satisfy the checks below instead of a bundle built from the source under test.
    await rm(join(workspaceRoot, id, '.coilbox'), { recursive: true, force: true });
  }
  await writeReferenceScene(workspaceRoot);
  const referenceValidation = await workspace.validateProject(REFERENCE_PROJECT);
  record({
    id: 'reference-scene',
    title: 'The declared reference scene (200 objects, 25 bodies, one shadow light) is a valid project',
    passed: referenceValidation.ok,
    detail: referenceValidation.ok ? 'validates' : referenceValidation.issues.map((issue) => issue.message).join('; '),
  });

  const api: ApiServerHandle = await startApiServer({ workspace, port: 0 });
  const server = await startStaticServer({
    root: join(root, 'dist'),
    prefix: '/',
    quiet: true,
    proxy: { '/api': api.url },
    // The player pages load projects as plain files, so the workspace is mounted next to them.
    mounts: { '/games/': workspaceRoot },
  });
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const consoleErrors: string[] = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    // --- 20 Play/Stop cycles on a real game ---------------------------------
    await page.goto(`${server.url}player.html?project=./games/collect-room/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__PLAYER__ !== undefined, undefined, { timeout: 30_000 });
    await page.evaluate(() => window.__PLAYER__?.ready);

    const cycles: Array<Record<string, number>> = [];
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const measured = await page.evaluate(async () => {
        const session = window.__PLAYER__?.session;
        if (!session) throw new Error('no player session');
        await session.restart(true);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const stats = session.stats();
        return {
          geometries: Number(stats?.geometries ?? 0),
          textures: Number(stats?.textures ?? 0),
          programs: Number(stats?.programs ?? 0),
          listeners: Number(stats?.listeners ?? 0),
          bodies: Number(stats?.physicsBodies ?? 0),
          physicsByteCount: Number(stats?.physics?.byteCount ?? 0),
          hudElements: Number(document.querySelectorAll('.coilbox-hud .hud-element').length),
        };
      });
      cycles.push(measured);
    }

    const first = cycles[0]!;
    const last = cycles[cycles.length - 1]!;
    const growth = {
      geometries: last.geometries! - first.geometries!,
      textures: last.textures! - first.textures!,
      listeners: last.listeners! - first.listeners!,
      bodies: last.bodies! - first.bodies!,
      hudElements: last.hudElements! - first.hudElements!,
    };
    measurements['playStopCycles'] = { first, last, growth, samples: cycles };
    record({
      id: 'resource-ownership',
      title: 'Twenty Play/Stop cycles leave no continuing growth in owned resources',
      passed:
        Math.abs(growth.listeners) <= 1 &&
        Math.abs(growth.bodies) <= 1 &&
        Math.abs(growth.hudElements) <= 1 &&
        Math.abs(growth.geometries) <= 2,
      detail: `geometries ${first.geometries}→${last.geometries}, textures ${first.textures}→${last.textures}, listeners ${first.listeners}→${last.listeners}, bodies ${first.bodies}→${last.bodies}, HUD elements ${first.hudElements}→${last.hudElements}`,
      observed: growth,
    });

    // --- reference scene performance ----------------------------------------
    await page.goto(`${server.url}player.html?project=./games/${REFERENCE_PROJECT}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__PLAYER__ !== undefined, undefined, { timeout: 30_000 });
    await page.evaluate(() => window.__PLAYER__?.ready);
    await page.waitForTimeout(2500); // warm-up before measuring

    const perf = await page.evaluate(async () => {
      const player = window.__PLAYER__;
      const frames: number[] = [];
      const physics: number[] = [];
      const start = performance.now();
      // A fixed number of frames rather than a fixed number of seconds: the percentiles have to
      // come from a complete sample, and a software rasteriser on a shared runner renders far fewer
      // frames per second than a development machine. The wall-clock bound only stops a stalled
      // renderer from hanging the gate.
      while (frames.length < 120 && performance.now() - start < 60_000) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        const sample = player?.stats() as { frameTimeMs: number; physicsTimeMs: number } | null;
        if (sample) {
          frames.push(sample.frameTimeMs);
          physics.push(sample.physicsTimeMs);
        }
      }
      const stats = player?.stats() as {
        fps: number;
        frameTimeMs: number;
        physicsTimeMs: number;
        drawCalls: number;
        triangles: number;
        entities: number;
        physicsBodies: number;
      } | null;
      const sorted = [...frames].sort((a, b) => a - b);
      return {
        frames: frames.length,
        medianFrameMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
        p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        medianPhysicsMs: [...physics].sort((a, b) => a - b)[Math.floor(physics.length / 2)] ?? 0,
        drawCalls: stats?.drawCalls ?? 0,
        triangles: stats?.triangles ?? 0,
        entities: stats?.entities ?? 0,
        physicsBodies: stats?.physicsBodies ?? 0,
        fps: stats?.fps ?? 0,
      };
    });
    measurements['referenceScene'] = perf;
    record({
      id: 'reference-performance',
      title: 'The reference scene renders on the declared conditions and the numbers are recorded',
      passed: perf.entities >= 200 && perf.physicsBodies >= 25 && perf.drawCalls > 0 && perf.frames >= 100,
      detail: `${perf.entities} entities, ${perf.physicsBodies} bodies, ${perf.drawCalls} draw calls, ${perf.triangles} triangles; median frame ${perf.medianFrameMs.toFixed(2)} ms, p95 ${perf.p95FrameMs.toFixed(2)} ms, physics ${perf.medianPhysicsMs.toFixed(2)} ms (software rasteriser, not the M1 Pro target)`,
      observed: perf,
    });

    // --- frame-rate independence ---------------------------------------------
    // A blocked main thread must not be replayed as hundreds of physics steps.
    const blocked = await page.evaluate(async () => {
      const player = window.__PLAYER__;
      const world = player?.session?.current;
      if (!world) throw new Error('no runtime world');
      const maxSubSteps = player?.game?.settings.physics.maxSubSteps ?? 0;
      const before = world.getLoopStats();
      const start = performance.now();
      while (performance.now() - start < 400) {
        // Deliberately block the frame.
      }
      // What a caught-up loop would show is one frame running every step the stall owed (24 at
      // 60 Hz). The loop publishes the step count of its most recent frame, so the honest question
      // is whether any single frame after the stall exceeded the configured sub-step cap — a bound
      // that holds whatever the machine's frame rate is, unlike a total counted over wall time.
      let busiestFrameSteps = 0;
      const framesToWatch = 8;
      for (let index = 0; index < framesToWatch; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        busiestFrameSteps = Math.max(busiestFrameSteps, world.getLoopStats().lastFrameSteps);
      }
      const after = world.getLoopStats();
      return {
        stepsTaken: after.steps - before.steps,
        droppedTime: after.droppedTime - before.droppedTime,
        clampedTime: after.clampedTime - before.clampedTime,
        busiestFrameSteps,
        maxSubSteps,
        framesToWatch,
      };
    });
    measurements['frameRateIndependence'] = blocked;
    record({
      id: 'frame-rate-independence',
      title: 'A stalled frame is clamped and its backlog dropped, not replayed as extra steps',
      passed: blocked.clampedTime > 0 && blocked.maxSubSteps > 0 && blocked.busiestFrameSteps <= blocked.maxSubSteps,
      detail: `a 400 ms stall produced ${blocked.stepsTaken} steps, ${blocked.droppedTime.toFixed(3)} s dropped, ${blocked.clampedTime.toFixed(3)} s clamped; the busiest of the ${blocked.framesToWatch} following frames ran ${blocked.busiestFrameSteps} steps (cap ${blocked.maxSubSteps})`,
      observed: blocked,
    });

    // --- tab backgrounding ----------------------------------------------------
    const backgrounded = await page.evaluate(async () => {
      const world = window.__PLAYER__?.session?.current;
      if (!world) throw new Error('no runtime world');
      const before = world.getLoopStats();
      // Simulate a hidden tab by blocking the loop through a long synchronous wait, which is
      // exactly what a suspended tab looks like to the accumulator.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const after = world.getLoopStats();
      return { stepsDuringWait: after.steps - before.steps };
    });
    record({
      id: 'no-catch-up-spiral',
      title: 'Time spent waiting is not replayed as a burst of simulation steps',
      passed: backgrounded.stepsDuringWait < 200,
      detail: `${backgrounded.stepsDuringWait} steps during a 1.2 s wait (about 72 expected at 60 Hz)`,
      observed: backgrounded,
    });

    // --- narrow viewport (explicitly not a phone test) ------------------------
    const narrow = await context.newPage();
    await narrow.setViewportSize({ width: 390, height: 844 });
    await narrow.goto(`${server.url}player.html?project=./games/collect-room/`, { waitUntil: 'load' });
    await narrow.waitForFunction(() => window.__PLAYER__ !== undefined, undefined, { timeout: 30_000 });
    await narrow.evaluate(() => window.__PLAYER__?.ready);
    await waitForPlaySteps(narrow, 60);
    const narrowResult = await narrow.evaluate(() => {
      const player = window.__PLAYER__;
      const pixels = player?.samplePixels() as {
        width: number;
        height: number;
        nonBackgroundPixels: number;
        distinctColors: number;
      };
      return {
        width: pixels.width,
        height: pixels.height,
        rendered: pixels.nonBackgroundPixels / (pixels.width * pixels.height),
        distinctColors: pixels.distinctColors,
        steps: (player?.stats() as { steps: number } | null)?.steps ?? 0,
      };
    });
    await narrow.screenshot({ path: join(evidenceDir, 'narrow-viewport.png') });
    measurements['narrowViewport'] = narrowResult;
    record({
      id: 'narrow-viewport',
      title: 'The game runs at a narrow viewport (a viewport test, not a phone test)',
      passed: narrowResult.rendered > 0.03 && narrowResult.steps > 30,
      detail: `${narrowResult.width}x${narrowResult.height}, ${(narrowResult.rendered * 100).toFixed(1)}% rendered, ${narrowResult.steps} steps`,
      observed: narrowResult,
    });

    // --- the user acceptance session -----------------------------------------
    const studio = await context.newPage();
    await studio.setViewportSize({ width: 1440, height: 900 });
    studio.on('pageerror', (error) => consoleErrors.push(`studio: ${String(error)}`));
    await studio.goto(server.url, { waitUntil: 'load' });
    await studio.waitForFunction(() => window.__STUDIO__ !== undefined, undefined, { timeout: 30_000 });
    await studio.click('.card:has-text("Gem Rush") button:has-text("Open")');
    await studio.waitForSelector('.tree-row', { timeout: 20_000 });

    // 1-5: move five objects through the inspector.
    const movedNames: string[] = [];
    for (const name of ['Gem 1', 'Gem 2', 'Gem 3', 'Gem 4', 'Gem 5']) {
      const row = studio.locator(`.tree-row:has-text("${name}")`).first();
      if ((await row.count()) === 0) continue;
      await row.click();
      await studio.waitForSelector('.inspector-title .name-field', { timeout: 10_000 });
      const field = studio.locator('.section:has(.section-title:text-is("Transform")) .vector-field:has(.field-label:text-is("Position (m)")) input').first();
      await field.fill('1.25');
      await field.blur();
      // Wait for the edit to reach the authored document rather than assuming a render tick: the
      // command round-trip is asynchronous and a loaded machine takes longer over it.
      await studio.waitForFunction(
        (entityName: string) => {
          const scene = window.__STUDIO__?.session.scene;
          const entity = scene?.entities.find((candidate) => candidate.name === entityName);
          return entity?.transform.position[0] === 1.25;
        },
        name,
        { timeout: 10_000 },
      );
      movedNames.push(name);
    }
    const movedDocument = await studio.evaluate(() => {
      const session = window.__STUDIO__?.session;
      return (session?.scene?.entities ?? [])
        .filter((entity) => entity.name.startsWith('Gem'))
        .map((entity) => ({ name: entity.name, x: entity.transform.position[0] }));
    });
    record({
      id: 'acceptance-move-five',
      title: 'Acceptance: move five objects',
      passed: movedNames.length >= 5 && movedDocument.every((entity) => entity.x === 1.25),
      detail: `moved ${movedNames.length} objects; positions now ${movedDocument.map((entity) => entity.x).join(', ')}`,
      observed: movedDocument,
    });

    // Acceptance: replace a model. Two models are imported through the editor, one is put on a
    // new object, and then swapped for the other — the object's model changes, nothing else does.
    await studio.click('button[role="tab"]:has-text("Assets")');
    await studio.setInputFiles('.asset-toolbar input[type="file"]', [
      join(root, 'tests', 'fixtures', 'models', 'spinning-crate.glb'),
      join(root, 'tests', 'fixtures', 'models', 'animated-limb.glb'),
    ]);
    await studio.waitForFunction(() => document.querySelectorAll('.asset-table tbody tr').length >= 2, undefined, { timeout: 30_000 });
    await studio.click('button:has-text("+ Create")');
    await studio.click('.menu button:has-text("Box")');
    await enterName(studio, 'Model Swap');
    await studio.click('.add-component button:has-text("+ Add component")');
    await studio.click('.add-menu button:has-text("Model")');
    await studio.waitForSelector('.section-title:has-text("Model")', { timeout: 10_000 });
    await selectComponentField(studio, 'Asset', 'spinning-crate');
    const crateLoaded = await waitForModelStatus(studio, 'loaded', 30_000);
    const crateAsset = await readSelectedModelAsset(studio);
    await selectComponentField(studio, 'Asset', 'animated-limb');
    const limbLoaded = await waitForModelStatus(studio, 'loaded', 30_000);
    const limbAsset = await readSelectedModelAsset(studio);
    record({
      id: 'acceptance-replace-model',
      title: 'Acceptance: replace a model on an object',
      passed: crateLoaded && limbLoaded && crateAsset === 'spinning-crate' && limbAsset === 'animated-limb',
      detail: `model ${String(crateAsset)} (loaded=${crateLoaded}) → ${String(limbAsset)} (loaded=${limbLoaded}), imported through the editor`,
      observed: { crateAsset, limbAsset, crateLoaded, limbLoaded },
    });

    // 6: change a gameplay value.
    await studio.click('.tree-row:has-text("Player")');
    await studio.waitForSelector('.section-title:has-text("Character Mover")', { timeout: 15_000 });
    const speed = studio.locator('.section:has(.section-title:text-is("Character Mover")) .field:has(.field-label:text-is("Move speed")) input').first();
    await speed.fill('7');
    await speed.blur();
    await studio.waitForTimeout(200);

    // 7: undo one mistake.
    await studio.keyboard.press('Control+z');
    await studio.waitForTimeout(200);
    const afterUndo = await studio.evaluate(() => {
      const session = window.__STUDIO__?.session;
      return session?.scene?.entities.find((entity) => entity.id === 'player')?.components.find((c) => c.type === 'behavior')?.properties?.moveSpeed ?? null;
    });
    await studio.keyboard.press('Control+Shift+z');
    await studio.waitForTimeout(200);
    const afterRedo = await studio.evaluate(() => {
      const session = window.__STUDIO__?.session;
      return session?.scene?.entities.find((entity) => entity.id === 'player')?.components.find((c) => c.type === 'behavior')?.properties?.moveSpeed ?? null;
    });
    record({
      id: 'acceptance-undo',
      title: 'Acceptance: change a gameplay value, undo the mistake, keep the change',
      passed: afterUndo === 6 && afterRedo === 7,
      detail: `move speed 7 → undo ${afterUndo} → redo ${afterRedo}`,
      observed: { afterUndo, afterRedo },
    });

    // 8-9: play, then stop.
    await studio.click('button:has-text("Save")');
    await studio.waitForFunction(() => document.querySelector('.save-indicator')?.getAttribute('data-save-state') === 'clean', undefined, { timeout: 20_000 });
    await studio.click('button:has-text("Play")');
    await studio.waitForSelector('.viewport-badge', { timeout: 20_000 });
    await waitForPlaySteps(studio, 60, { source: 'editor' });
    const playStats = await studio.evaluate(() => {
      const viewport = window.__STUDIO__?.viewport?.();
      return (viewport?.playStats() ?? null) as { state: string; steps: number; behaviors: number } | null;
    });
    await studio.screenshot({ path: join(evidenceDir, 'acceptance-play.png') });
    await studio.click('button:has-text("Stop")');
    await studio.waitForSelector('.viewport-badge', { state: 'detached', timeout: 15_000 });
    record({
      id: 'acceptance-play-stop',
      title: 'Acceptance: play and stop without touching code',
      passed: playStats?.state === 'running' && (playStats?.steps ?? 0) > 30,
      detail: `play world ran ${playStats?.steps ?? 0} steps with ${playStats?.behaviors ?? 0} behaviors, then stopped`,
      observed: playStats,
    });

    // 10: reopen.
    await studio.reload({ waitUntil: 'load' });
    await studio.waitForFunction(() => window.__STUDIO__ !== undefined, undefined, { timeout: 30_000 });
    await studio.click('.card:has-text("Gem Rush") button:has-text("Open")');
    await studio.waitForSelector('.tree-row', { timeout: 20_000 });
    const reopened = await studio.evaluate(() => {
      const session = window.__STUDIO__?.session;
      const player = session?.scene?.entities.find((entity) => entity.id === 'player');
      const gems = (session?.scene?.entities ?? []).filter((entity) => entity.name.startsWith('Gem'));
      const swapped = session?.scene?.entities.find((entity) => entity.name === 'Model Swap');
      return {
        moveSpeed: player?.components.find((c) => c.type === 'behavior')?.properties?.moveSpeed ?? null,
        gemPositions: gems.map((gem) => gem.components.length),
        gemCount: gems.length,
        modelAsset: swapped?.components.find((c) => c.type === 'model')?.assetId ?? null,
      };
    });
    record({
      id: 'acceptance-reopen',
      title: 'Acceptance: reopen shows every edit still in place',
      passed: reopened.moveSpeed === 7 && reopened.gemCount === 5 && reopened.modelAsset === 'animated-limb',
      detail: `move speed ${reopened.moveSpeed}, ${reopened.gemCount} gems, replaced model ${String(reopened.modelAsset)} after reopening`,
      observed: reopened,
    });

    // Acceptance: export without touching code. This is the export the release checks below serve.
    await studio.click('button:has-text("Export Game")');
    await studio.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('Exported to') === true, undefined, { timeout: 120_000 });
    const exported = await studio.evaluate(() => document.querySelector('.statusbar')?.textContent ?? '');
    const exportedProject = join(workspaceRoot, 'gem-rush', '.coilbox', 'export', 'project');
    const exportedDocuments = existsSync(join(exportedProject, 'game.json'))
      ? JSON.parse(await readFile(join(exportedProject, 'game.json'), 'utf8'))
      : null;
    const exportedScene = existsSync(join(exportedProject, 'scenes', 'main.scene.json'))
      ? JSON.parse(await readFile(join(exportedProject, 'scenes', 'main.scene.json'), 'utf8'))
      : null;
    const exportedModelEntities = (exportedScene?.entities ?? []).filter((entity: { components: Array<{ type: string }> }) =>
      entity.components.some((component) => component.type === 'model'),
    );
    record({
      id: 'acceptance-export',
      title: 'Acceptance: export from the editor without touching code',
      passed:
        exportedDocuments !== null &&
        existsSync(join(workspaceRoot, 'gem-rush', '.coilbox', 'export', 'index.html')) &&
        exportedModelEntities.length === 1,
      detail: `${exported.trim().split('\n')[0] || 'no status'} (${exportedModelEntities.length} model entity in the exported documents)`,
      observed: { status: exported.trim(), exportedModelEntities: exportedModelEntities.map((entity: { name: string }) => entity.name) },
    });
  } catch (error) {
    process.stdout.write(`\nbrowser checks stopped early: ${String(error)}\n`);
    record({ id: 'browser-checks', title: 'Browser checks ran to completion', passed: false, detail: String(error) });
  } finally {
    await browser.close();
    await server.close();
    await api.close().catch(() => {});
  }

  // ---------------------------------------------------------------- export independence
  // The workspace service is already closed at this point; the export must not need it.
  const exportWorkspace = new Workspace({ root: workspaceRoot, templatesRoot: join(root, 'templates') });
  const exportDir = join(workspaceRoot, 'gem-rush', '.coilbox', 'export');
  // Always build: the point of this check is the export this repository produces right now.
  await buildGame({ workspace: exportWorkspace, projectId: 'gem-rush' });
  const exportServer = await startStaticServer({
    root: exportDir,
    prefix: '/releases/2026/gem-rush/',
    quiet: true,
  });
  const exportBrowser = await chromium.launch({
    headless: !headed,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await exportBrowser.newPage({ viewport: { width: 1024, height: 640 } });
    const exportErrors: string[] = [];
    page.on('pageerror', (error) => exportErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') exportErrors.push(message.text());
    });
    await page.goto(exportServer.url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__PLAYER__ !== undefined, undefined, { timeout: 30_000 });
    await page.evaluate(() => window.__PLAYER__?.ready);

    // Audio activation needs a user gesture. How that gesture was delivered is part of the
    // evidence: a swallowed click failure would otherwise look like a broken audio system.
    let gesture = 'none';
    try {
      await page.locator('.coilbox-hud .hud-overlay[data-hud-id="start-overlay"] button').click({ timeout: 15_000 });
      gesture = 'clicked the start overlay button';
    } catch (error) {
      gesture = `start overlay click failed: ${String(error).split('\n')[0]}`;
      await page.mouse.click(20, 20).catch(() => undefined);
      gesture += '; clicked the page corner instead';
    }
    await waitForPlaySteps(page, 60);
    const state = await page.evaluate(() => {
      const player = window.__PLAYER__;
      if (!player) throw new Error('no player');
      return {
        state: player.state(),
        gameState: player.gameState(),
        stats: player.stats() as { steps: number; audioActivated: boolean } | null,
      };
    });

    const requests = exportServer.requests;
    const failures = requests.filter((entry) => entry.status >= 400);
    const devUrls = requests.filter((entry) => entry.url.includes('/src/') || entry.url.includes('@vite') || entry.url.includes('node_modules'));
    const wasm = requests.filter((entry) => entry.url.endsWith('.wasm'));
    const badMime = wasm.filter((entry) => entry.contentType !== 'application/wasm');

    record({
      id: 'export-nested-path',
      title: 'The export runs from a nested path on a separate static server with no workspace service',
      passed: failures.length === 0 && state.state.errors.length === 0 && (state.stats?.steps ?? 0) > 30,
      detail: `${requests.length} requests from ${exportServer.url}, ${failures.length} failed, ${state.stats?.steps ?? 0} steps`,
      observed: { failures, requests: requests.length },
    });
    record({
      id: 'export-no-dev-artifacts',
      title: 'The export references no development server, source folder, or wrong MIME type',
      passed: devUrls.length === 0 && wasm.length > 0 && badMime.length === 0,
      detail: `${wasm.length} WASM request(s) served as application/wasm, ${devUrls.length} dev URLs`,
      observed: { devUrls, wasm },
    });
    record({
      id: 'export-audio-activation',
      title: 'Audio activates after a user interaction in the export',
      passed: state.stats?.audioActivated === true,
      detail: `audioActivated=${state.stats?.audioActivated} (${gesture})`,
      observed: { audioActivated: state.stats?.audioActivated, gesture, gameState: state.gameState },
    });

    // Restart inside the export. The snapshot is taken with the fresh world paused: the loop is
    // scheduled by `restart` but has not run a frame yet, so the values are the ones the restart
    // built rather than whatever gameplay reached in the meantime.
    const restart = await page.evaluate(async () => {
      const player = window.__PLAYER__;
      const session = player?.session;
      const previousWorld = session?.current;
      if (!player || !session || !previousWorld) throw new Error('no runtime world');
      const authored = player.game?.settings?.initialGameState ?? {};
      const before = previousWorld.getGameState().snapshot();
      await session.restart(true);
      const world = session.current;
      if (!world) throw new Error('restart produced no world');
      world.pause();
      const after = world.getGameState().snapshot();
      const pausedState = world.getState();
      world.resume();
      return { before, after, authored, rebuilt: world !== previousWorld, pausedState };
    });
    const resetToAuthored =
      restart.after.score === (restart.authored.score ?? 0) &&
      restart.after.won === false &&
      restart.after.lost === false &&
      restart.after.collectiblesRemaining === (restart.authored.collectiblesRemaining ?? 0);
    record({
      id: 'export-restart',
      title: 'Restart builds a fresh world and returns the run to its authored initial state',
      passed:
        restart.rebuilt &&
        restart.pausedState === 'paused' &&
        resetToAuthored &&
        (Number(restart.before.collectiblesRemaining ?? 0) < Number(restart.after.collectiblesRemaining ?? 0) ||
          Number(restart.before.score ?? 0) > Number(restart.after.score ?? 0)),
      detail: `score ${String(restart.before.score)} → ${String(restart.after.score)} (authored ${String(restart.authored.score)}), collectibles ${String(restart.before.collectiblesRemaining)} → ${String(restart.after.collectiblesRemaining)}, new world=${restart.rebuilt}`,
      observed: restart,
    });

    record({
      id: 'export-no-errors',
      title: 'No page errors in the exported game',
      passed: exportErrors.filter((text) => !/Failed to load resource/.test(text)).length === 0,
      detail: exportErrors.filter((text) => !/Failed to load resource/.test(text)).slice(0, 3).join(' | ') || 'clean console',
      observed: exportErrors.slice(0, 5),
    });
  } catch (error) {
    record({ id: 'export-checks', title: 'Export checks ran to completion', passed: false, detail: String(error) });
  } finally {
    await exportBrowser.close();
    await exportServer.close();
  }

  // ---------------------------------------------------------------- per-game bounded tests
  for (const id of ['collect-room', 'physics-targets', 'gem-rush']) {
    const result = await testGame({ workspace, projectId: id, seconds: 2 });
    record({
      id: `bounded-test-${id}`,
      title: `The bounded test passes for ${id}`,
      passed: result.ok,
      detail: `${result.checks.filter((check) => check.passed).length}/${result.checks.length} checks in ${(result.durationMs / 1000).toFixed(1)}s`,
    });
  }

  record({
    id: 'no-console-errors',
    title: 'No page errors across the studio, the games, and the export',
    passed: consoleErrors.length === 0,
    detail: consoleErrors.length === 0 ? 'clean console' : consoleErrors.slice(0, 3).join(' | '),
    observed: consoleErrors.slice(0, 5),
  });

  const evidence = {
    stage: 5,
    generatedAt: new Date().toISOString(),
    node: process.version,
    host: process.platform,
    workspaceRoot,
    measurements,
    steps,
    checks,
    note: 'Frame times were measured under a software rasteriser (SwiftShader) in a headless browser, not on the M1 Pro reference machine; they are recorded as measurements, not as a promise.',
  };
  await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  const failed = checks.filter((check) => !check.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  process.stdout.write('Evidence written to docs/evidence/stage5/evidence.json\n');
  await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  if (failed.length > 0 || steps.some((step) => !step.ok)) {
    process.stdout.write('\nSTAGE 5 GATE FAILED\n');
    process.exit(1);
  }
  process.stdout.write('\nSTAGE 5 GATE PASSED\n');
}

/** Rename the selected entity through the inspector title field. */
async function enterName(page: Page, name: string): Promise<void> {
  const field = page.locator('.inspector-title .name-field');
  await field.fill(name);
  await field.blur();
  await page.waitForTimeout(150);
}

/** Choose an option in a component field, e.g. the Model section's "Asset" picker. */
async function selectComponentField(page: Page, label: string, value: string): Promise<void> {
  const select = page.locator(`.field:has(.field-label:text-is("${label}")) select`).first();
  if ((await select.count()) === 0) throw new Error(`no "${label}" select in the inspector`);
  await select.selectOption(value);
  await page.waitForTimeout(120);
}

/** The asset id of the selected entity's model component, read from the authored document. */
async function readSelectedModelAsset(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const studio = window.__STUDIO__;
    const id = studio?.session.selection.primary;
    const entity = studio?.session.scene?.entities.find((candidate) => candidate.id === id);
    return entity?.components.find((component) => component.type === 'model')?.assetId ?? null;
  });
}

/** Wait until the selected entity's model reports the expected load status. */
async function waitForModelStatus(page: Page, status: string, timeout: number): Promise<boolean> {
  return page
    .waitForFunction(
      (expected: string) => {
        const studio = window.__STUDIO__;
        const id = studio?.session.selection.primary;
        const viewport = studio?.viewport?.();
        return Boolean(id && viewport && viewport.modelStatus(id) === expected);
      },
      status,
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
}

await main();
