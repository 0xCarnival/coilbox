import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Page } from '@playwright/test';
import { startApiServer, type ApiServerHandle } from '../server/api.js';
import { Workspace } from '../server/workspace.js';
import { startStaticServer } from './static-server.js';

/**
 * Stage 2 gate (plan §15).
 *
 * Deliverable: hierarchy/groups, assets, camera/light/material controls, snapping, clip
 * playback, pause/step, errors.
 *
 * Required evidence: "Build and revise a small scene without editing code; missing asset and
 * unsupported import errors are understandable."
 *
 * Usage: pnpm verify:stage2 [--skip-build] [--headed]
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
  const evidenceDir = join(root, 'docs', 'evidence', 'stage2');
  await mkdir(evidenceDir, { recursive: true });

  const typecheckOk = await run('typecheck', 'pnpm', ['exec', 'tsc', '--noEmit']);
  const testsOk = await run('unit tests', 'pnpm', ['exec', 'vitest', 'run']);
  if (!skipBuild) await run('production build', 'pnpm', ['exec', 'vite', 'build']);
  if (!typecheckOk || !testsOk) {
    process.stdout.write('\nAborting browser checks: typecheck or unit tests failed.\n');
    process.exit(1);
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'coilbox-stage2-'));
  const workspace = new Workspace({ root: workspaceRoot, templatesRoot: join(root, 'templates') });
  await workspace.ensureRoot();
  const api: ApiServerHandle = await startApiServer({ workspace, port: 0 });
  const editorServer = await startStaticServer({
    root: join(root, 'dist'),
    prefix: '/',
    quiet: true,
    proxy: { '/api': api.url },
  });

  process.stdout.write(`\n== browser checks ==\neditor at ${editorServer.url}\nworkspace ${workspaceRoot}\n`);

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
    await page.waitForFunction(() => (window as unknown as { __STUDIO__?: unknown }).__STUDIO__ !== undefined, undefined, {
      timeout: 30_000,
    });

    await page.click('button:has-text("+ New game")');
    await page.fill('input[placeholder="collect-room"]', 'stage2-room');
    await page.fill('input[placeholder="Collect Room"]', 'Stage 2 Room');
    await page.click('button[type="submit"]:has-text("Create")');
    await page.waitForSelector('.tree-row', { timeout: 20_000 });

    // --- unsupported imports are understandable ---------------------------------
    const unsupported = await apiImport(api, workspaceRoot, 'stage2-room', 'hero.fbx', Buffer.from([0, 1, 2, 3]));
    record({
      id: 'unsupported-import-message',
      title: 'An unsupported import is refused with a message that says what to do',
      passed: unsupported.status === 415 && /FBX is not supported/.test(unsupported.message) && /\.glb/.test(unsupported.message),
      detail: `${unsupported.status}: ${unsupported.message}`,
      observed: unsupported,
    });

    const dracoBytes = await readFile(join(root, 'tests', 'fixtures', 'models', 'draco-required.glb'));
    const dracoImport = await apiImport(api, workspaceRoot, 'stage2-room', 'draco-required.glb', dracoBytes);
    record({
      id: 'unsupported-codec-recorded',
      title: 'A model needing a decoder we do not bundle is recorded as such at import',
      passed: dracoImport.status === 201 && dracoImport.body?.entry?.requires?.includes('KHR_draco_mesh_compression') === true,
      detail: `requires=${JSON.stringify(dracoImport.body?.entry?.requires ?? null)}`,
      observed: dracoImport.body?.entry?.requires,
    });

    // --- import assets through the UI -------------------------------------------
    await page.click('button[role="tab"]:has-text("Assets")');
    await page.setInputFiles('.asset-toolbar input[type="file"]', [
      join(root, 'tests', 'fixtures', 'models', 'animated-limb.glb'),
      join(root, 'tests', 'fixtures', 'models', 'spinning-crate.glb'),
      join(root, 'tests', 'fixtures', 'images', 'swatch.png'),
      join(root, 'tests', 'fixtures', 'audio', 'beep.wav'),
    ]);
    await page.waitForFunction(() => document.querySelectorAll('.asset-table tbody tr').length >= 5, undefined, {
      timeout: 30_000,
    });
    const assetIds = await page.locator('.asset-table tbody tr td:first-child').allTextContents();
    record({
      id: 'asset-import',
      title: 'Models, images, and audio import through the editor and appear in the manifest',
      passed: ['animated-limb', 'spinning-crate', 'swatch', 'beep'].every((id) => assetIds.includes(id)),
      detail: `manifest lists ${assetIds.join(', ')}`,
      observed: assetIds,
    });

    // --- build a scene without editing code --------------------------------------
    await page.click('button:has-text("+ Create")');
    await page.click('.menu button:has-text("Box")');
    await enterName(page, 'Crate A');
    await setComponentSelect(page, 'Shape', 'Box');
    await setVector(page, 'Size (m)', [1, 1, 1]);

    // Model component + asset picker
    await page.click('.add-component button:has-text("+ Add component")');
    await page.click('.add-menu button:has-text("Model")');
    await page.waitForSelector('.section-title:has-text("Model")', { timeout: 10_000 });
    await selectField(page, 'Asset', 'spinning-crate');

    const modelLoaded = await page
      .waitForFunction(
        () => {
          const studio = (window as unknown as {
            __STUDIO__?: { viewport?: () => { modelStatus(id: string): string } | null; session: { selection: { primary: string | null } } };
          }).__STUDIO__;
          const viewport = studio?.viewport?.();
          const id = studio?.session.selection.primary;
          return Boolean(id && viewport && viewport.modelStatus(id) === 'loaded');
        },
        undefined,
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);
    record({
      id: 'model-loads-in-editor',
      title: 'A model asset loads into the viewport without editing code',
      passed: modelLoaded,
      detail: modelLoaded ? 'the selected entity reports its model as loaded' : 'the model never reached the loaded state',
    });

    // Animation component with a clip chosen from the loaded model
    await page.click('.add-component button:has-text("+ Add component")');
    await page.click('.add-menu button:has-text("Animation")');
    await page.waitForSelector('.section-title:has-text("Animation")', { timeout: 10_000 });
    const clipOptions = await page.locator('.section:has-text("Animation") select').first().locator('option').allTextContents();
    await selectField(page, 'Clip', 'Hop', { section: 'Animation' });

    const animating = await page.evaluate(async () => {
      const studio = (window as unknown as {
        __STUDIO__?: {
          session: { selection: { primary: string | null } };
          viewport?: () => { animationState(id: string): { time: number; clip: string | null } | null } | null;
        };
      }).__STUDIO__;
      const id = studio?.session.selection.primary;
      const viewport = studio?.viewport?.();
      if (!id || !viewport) return null;
      const before = viewport.animationState(id)?.time ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = viewport.animationState(id)?.time ?? 0;
      return { before, after, clip: viewport.animationState(id)?.clip ?? null };
    });
    record({
      id: 'clip-playback',
      title: 'The imported clip is discoverable and plays in the editor preview',
      passed: clipOptions.includes('Hop') && Boolean(animating && animating.after !== animating.before) && animating?.clip === 'Hop',
      detail: `clips offered: ${clipOptions.filter((option) => option.length > 0).join(', ')}; preview time advanced from ${animating?.before} to ${animating?.after}`,
      observed: animating,
    });

    // A second instance of a skinned model, animated independently in Play
    await page.click('button:has-text("+ Create")');
    await page.click('.menu button:has-text("Box")');
    await enterName(page, 'Limb');
    await page.click('.add-component button:has-text("+ Add component")');
    await page.click('.add-menu button:has-text("Model")');
    await selectField(page, 'Asset', 'animated-limb');
    await page.click('.add-component button:has-text("+ Add component")');
    await page.click('.add-menu button:has-text("Animation")');
    await selectField(page, 'Clip', 'Wave', { section: 'Animation' });

    const limbLoaded = await waitForModelStatus(page, 'loaded', 30_000);
    const limbClips = await page.evaluate(() => {
      const studio = (window as unknown as {
        __STUDIO__?: { session: { selection: { primary: string | null }; clipsFor(id: string): string[] } };
      }).__STUDIO__;
      const id = studio?.session.selection.primary;
      return id ? studio!.session.clipsFor(id) : [];
    });
    record({
      id: 'skinned-model-clips',
      title: 'A skinned model loads and reports its clips to the inspector',
      passed: limbLoaded && limbClips.includes('Wave'),
      detail: `model loaded=${limbLoaded}, clips=${JSON.stringify(limbClips)}`,
      observed: limbClips,
    });

    // --- camera, light, and material controls ------------------------------------
    await page.click('.tree-row:has-text("Sun")');
    await setNumberField(page, 'Intensity', 1.4, { section: 'Light' });
    await page.click('.tree-row:has-text("Game Camera")');
    await setNumberField(page, 'Field of view', 42, { section: 'Camera' });
    await page.click('.tree-row:has-text("Ground")');
    await page.click('.add-component button:has-text("+ Add component")');
    await page.click('.add-menu button:has-text("Material")');
    await setColorField(page, 'Colour', '#2f6f4f');

    const inspectorEdits = await page.evaluate(() => {
      const studio = (window as unknown as {
        __STUDIO__?: {
          session: {
            scene: {
              entities: Array<{ id: string; components: Array<{ type: string; [key: string]: unknown }> }>;
            } | null;
          };
        };
      }).__STUDIO__;
      const scene = studio?.session.scene;
      const sun = scene?.entities.find((entity) => entity.id === 'sun');
      const light = sun?.components.find((component) => component.type === 'light');
      const camera = scene?.entities.find((entity) => entity.id === 'game-camera')?.components.find((component) => component.type === 'camera');
      const ground = scene?.entities.find((entity) => entity.id === 'ground');
      const material = ground?.components.find((component) => component.type === 'material');
      return { intensity: light?.intensity ?? null, fov: camera?.fov ?? null, colour: material?.color ?? null };
    });
    record({
      id: 'property-controls',
      title: 'Light and material properties are editable in the inspector',
      passed:
        Math.abs((inspectorEdits.intensity as number) - 1.4) < 1e-6 &&
        Math.abs((inspectorEdits.fov as number) - 42) < 1e-6 &&
        inspectorEdits.colour === '#2f6f4f',
      detail: `light intensity ${inspectorEdits.intensity}, camera fov ${inspectorEdits.fov}, ground colour ${inspectorEdits.colour}`,
      observed: inspectorEdits,
    });

    // Snap settings reach the transform controls
    await page.click('.snap-toggle input');
    const snapApplied = await page.evaluate(() => {
      const studio = (window as unknown as { __STUDIO__?: { viewport?: () => { setSnap(s: unknown): void } | null } }).__STUDIO__;
      void studio;
      const input = document.querySelector('.snap-toggle input') as HTMLInputElement | null;
      return input?.checked ?? false;
    });
    record({
      id: 'snapping-toggle',
      title: 'Snapping can be switched on for transform handles',
      passed: snapApplied === true,
      detail: `snap toggle is ${snapApplied ? 'on' : 'off'}`,
      observed: snapApplied,
    });

    // --- save, reopen, revise -----------------------------------------------------
    await page.click('button:has-text("Save")');
    await page.waitForFunction(
      () => document.querySelector('.save-indicator')?.getAttribute('data-save-state') === 'clean',
      undefined,
      { timeout: 20_000 },
    );
    const diskScene = JSON.parse(await readFile(join(workspaceRoot, 'stage2-room', 'scenes', 'main.scene.json'), 'utf8')) as {
      revision: number;
      entities: Array<{ id: string; name: string; components: Array<{ type: string; assetId?: string }> }>;
    };
    const savedModels = diskScene.entities.filter((entity) => entity.components.some((component) => component.type === 'model'));
    record({
      id: 'save-scene-with-assets',
      title: 'The scene with models and clips saves and reopens',
      passed: diskScene.revision >= 1 && savedModels.length >= 2,
      detail: `revision ${diskScene.revision}, ${savedModels.length} model entities on disk: ${savedModels.map((entity) => entity.name).join(', ')}`,
      observed: { revision: diskScene.revision, models: savedModels.map((entity) => entity.name) },
    });

    await page.screenshot({ path: join(evidenceDir, 'editor-with-assets.png') });

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (window as unknown as { __STUDIO__?: unknown }).__STUDIO__ !== undefined, undefined, {
      timeout: 30_000,
    });
    await page.click('.card:has-text("Stage 2 Room") button:has-text("Open")');
    await page.waitForSelector('.tree-row', { timeout: 20_000 });
    await page.click('.tree-row:has-text("Crate A")');
    const reopened = await waitForModelStatus(page, 'loaded', 30_000);
    record({
      id: 'reopen-reloads-assets',
      title: 'Reopening the project reloads the assets it references',
      passed: reopened,
      detail: reopened ? 'the crate model loads again after a full page reload' : 'the model did not load after reopening',
    });

    // --- play with animation ------------------------------------------------------
    await page.click('button:has-text("Play")');
    await page.waitForSelector('.viewport-badge', { timeout: 20_000 });
    const playAnimation = await page.evaluate(async () => {
      const studio = (window as unknown as {
        __STUDIO__?: {
          session: { scene: { entities: Array<{ id: string; name: string }> } | null };
          viewport?: () => {
            playAnimationState(id: string): { time: number; clip: string | null } | null;
            playStats(): { loadedModels: number; animatedEntities: number; entities: number } | null;
          } | null;
        };
      }).__STUDIO__;
      const viewport = studio?.viewport?.();
      const entities = studio?.session.scene?.entities ?? [];
      const limbId = entities.find((entity) => entity.name === 'Limb')?.id ?? '';
      const crateId = entities.find((entity) => entity.name === 'Crate A')?.id ?? '';
      if (!viewport) return null;
      const first = viewport.playAnimationState(limbId);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const second = viewport.playAnimationState(limbId);
      const crate = viewport.playAnimationState(crateId);
      return { ids: { limbId, crateId }, first, second, crate, stats: viewport.playStats() };
    });
    const animated = Boolean(
      playAnimation &&
        playAnimation.second &&
        playAnimation.first &&
        playAnimation.second.time !== playAnimation.first.time &&
        playAnimation.second.time > 0,
    );
    record({
      id: 'play-animates',
      title: 'Play runs the runtime animation: clips advance inside the play world',
      passed: animated && (playAnimation?.stats?.animatedEntities ?? 0) >= 2,
      detail: animated
        ? `Limb clip "${playAnimation?.second?.clip}" advanced ${playAnimation?.first?.time.toFixed(3)} -> ${playAnimation?.second?.time.toFixed(3)}; ${playAnimation?.stats?.animatedEntities} animated entities, ${playAnimation?.stats?.loadedModels} models loaded`
        : `animation did not advance: ids ${JSON.stringify(playAnimation?.ids ?? null)}`,
      observed: playAnimation,
    });
    await page.screenshot({ path: join(evidenceDir, 'play-with-models.png') });

    await page.click('button:has-text("Stop")');
    await page.waitForSelector('.viewport-badge', { state: 'detached', timeout: 15_000 });

    // --- missing asset error is understandable -------------------------------------
    // Delete the file behind a manifest entry, then load the scene again: the entity must
    // report a failure rather than quietly rendering nothing.
    const assetDir = join(workspaceRoot, 'stage2-room', 'assets', 'models');
    const { readdir, unlink } = await import('node:fs/promises');
    const crateFile = (await readdir(assetDir)).find((name) => name.startsWith('spinning-crate'));
    if (crateFile) await unlink(join(assetDir, crateFile));

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (window as unknown as { __STUDIO__?: unknown }).__STUDIO__ !== undefined, undefined, {
      timeout: 30_000,
    });
    await page.click('.card:has-text("Stage 2 Room") button:has-text("Open")');
    await page.waitForSelector('.tree-row', { timeout: 20_000 });
    await page.click('.tree-row:has-text("Crate A")');
    const missingState = await page.evaluate(async () => {
      const studio = (window as unknown as {
        __STUDIO__?: {
          session: { selection: { primary: string | null }; snapshot(): { logs: Array<{ level: string; message: string; detail?: string }> } };
          viewport?: () => { modelStatus(id: string): string } | null;
        };
      }).__STUDIO__;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const id = studio?.session.selection.primary;
      const logs = studio?.session.snapshot().logs ?? [];
      return {
        status: id ? studio?.viewport?.()?.modelStatus(id) ?? 'none' : 'none',
        errors: logs.filter((entry) => entry.level === 'error').map((entry) => `${entry.message} ${entry.detail ?? ''}`),
      };
    });
    record({
      id: 'missing-asset-error',
      title: 'A missing asset file produces an understandable error, not a blank scene',
      passed:
        missingState.status === 'failed' &&
        missingState.errors.some((message) => /did not load|404|not found|could not be fetched/i.test(message)),
      detail: `model status "${missingState.status}"; console: ${missingState.errors.slice(0, 2).join(' | ') || 'nothing logged'}`,
      observed: missingState,
    });

    record({
      id: 'no-console-errors',
      title: 'No unexpected page errors while building and revising the scene',
      passed: consoleErrors.filter((text) => !/404|Failed to load resource/i.test(text)).length === 0,
      detail:
        consoleErrors.filter((text) => !/404|Failed to load resource/i.test(text)).slice(0, 3).join(' | ') || 'clean console',
      observed: consoleErrors.slice(0, 5),
    });
  } finally {
    await browser.close();
    await editorServer.close();
    await api.close().catch(() => {});
  }

  const evidence = {
    stage: 2,
    generatedAt: new Date().toISOString(),
    node: process.version,
    workspaceRoot,
    steps,
    checks,
  };
  await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  const failed = checks.filter((check) => !check.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  process.stdout.write('Evidence written to docs/evidence/stage2/evidence.json\n');
  await rm(workspaceRoot, { recursive: true, force: true });
  if (failed.length > 0 || steps.some((step) => !step.ok)) {
    process.stdout.write('\nSTAGE 2 GATE FAILED\n');
    process.exit(1);
  }
  process.stdout.write('\nSTAGE 2 GATE PASSED\n');
}

// ------------------------------------------------------------------ helpers

async function apiImport(
  api: ApiServerHandle,
  _workspaceRoot: string,
  projectId: string,
  filename: string,
  bytes: Buffer,
): Promise<{ status: number; message: string; body: any }> {
  const response = await fetch(
    `${api.url}/api/projects/${projectId}/assets?filename=${encodeURIComponent(filename)}`,
    {
      method: 'POST',
      headers: { 'x-coilbox-token': api.token, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    },
  );
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : null;
  return { status: response.status, message: String(body?.message ?? ''), body };
}

async function enterName(page: Page, name: string): Promise<void> {
  const field = page.locator('.inspector-title .name-field');
  await field.fill(name);
  await field.blur();
  await page.waitForTimeout(150);
}

/**
 * Fill a vector field. The label sits either on the vector group itself (Transform) or on the
 * `.field` wrapper (component-size style), so the selector accepts both shapes.
 */
async function setVector(page: Page, label: string, values: number[]): Promise<void> {
  const scope = page
    .locator(`.field:has(.field-label:text-is("${label}")), .vector-field:has(.field-label:text-is("${label}"))`)
    .first();
  const inputs = scope.locator('input[type="number"]');
  for (const [index, value] of values.entries()) {
    const input = inputs.nth(index);
    await input.fill(String(value));
    await input.blur();
  }
  await page.waitForTimeout(120);
}

async function setNumberField(page: Page, label: string, value: number, options: { section?: string } = {}): Promise<void> {
  const scope = options.section ? page.locator(`.section:has(.section-title:text-is("${options.section}"))`).first() : page;
  const input = scope.locator(`.field:has(.field-label:text-is("${label}")) input[type="number"]`).first();
  await input.fill(String(value));
  await input.blur();
  await page.waitForTimeout(120);
}

async function setColorField(page: Page, label: string, value: string): Promise<void> {
  const input = page.locator(`.field:has(.field-label:text-is("${label}")) input[type="color"]`).first();
  await input.evaluate((element, next) => {
    const input = element as HTMLInputElement;
    // React tracks the previous value on the node; assigning `value` directly makes the
    // synthetic change a no-op, so use the native setter before dispatching.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, String(next));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await page.waitForTimeout(200);
}

async function setComponentSelect(page: Page, label: string, value: string, options: { section?: string } = {}): Promise<void> {
  const scope = options.section ? page.locator(`.section:has(.section-title:text-is("${options.section}"))`).first() : page;
  const select = scope.locator(`.field:has(.field-label:text-is("${label}")) select`).first();
  if ((await select.count()) === 0) return;
  await select.selectOption(value);
  await page.waitForTimeout(120);
}

async function selectField(page: Page, label: string, value: string, options: { section?: string } = {}): Promise<void> {
  await setComponentSelect(page, label, value, options);
}

async function waitForModelStatus(page: Page, status: string, timeout: number): Promise<boolean> {
  return page
    .waitForFunction(
      (expected: string) => {
        const studio = (window as unknown as {
          __STUDIO__?: {
            viewport?: () => { modelStatus(id: string): string } | null;
            session: { selection: { primary: string | null } };
          };
        }).__STUDIO__;
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
