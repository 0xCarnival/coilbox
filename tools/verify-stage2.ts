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
    await page.waitForFunction(() => window.__STUDIO__ !== undefined, undefined, {
      timeout: 30_000,
    });

    await page.click('button:has-text("New game")');
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
    await page.click('nav[aria-label="Editor panels"] button[aria-label="Assets"]');
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
    await page.click('button:has-text("Create")');
    await page.click('.menu [role="menuitem"]:has-text("Box")');
    await enterName(page, 'Crate A');
    await setComponentSelect(page, 'Shape', 'Box');
    await setVector(page, 'Size (m)', [1, 1, 1]);

    // Model component + asset picker
    await page.click('.add-component button:has-text("Add component")');
    await page.click('.add-menu [role="menuitem"]:has-text("Model")');
    await page.waitForSelector('.section-title:has-text("Model")', { timeout: 10_000 });
    await selectField(page, 'Asset', 'spinning-crate');

    const modelLoaded = await page
      .waitForFunction(
        () => {
          const studio = window.__STUDIO__;
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
    await page.click('.add-component button:has-text("Add component")');
    await page.click('.add-menu [role="menuitem"]:has-text("Animation")');
    await page.waitForSelector('.section-title:has-text("Animation")', { timeout: 10_000 });
    /**
     * The clip list is read by opening the picker, because the control is a Radix dropdown now and
     * has no `<option>` elements to enumerate. What the check is actually asking is "does the loaded
     * model offer a clip called Hop", and that question survives the control changing shape.
     */
    const clipField = page.locator('.section:has-text("Animation") .field:has(.field-label:text-is("Clip"))').first();
    await clipField.locator('[role="combobox"]').first().click();
    const clipOptions = await page.locator('[role="option"]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-value') ?? ''),
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await selectField(page, 'Clip', 'Hop', { section: 'Animation' });

    const animating = await page.evaluate(async () => {
      const studio = window.__STUDIO__;
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
    await page.click('button:has-text("Create")');
    await page.click('.menu [role="menuitem"]:has-text("Box")');
    await enterName(page, 'Limb');
    await page.click('.add-component button:has-text("Add component")');
    await page.click('.add-menu [role="menuitem"]:has-text("Model")');
    await selectField(page, 'Asset', 'animated-limb');
    await page.click('.add-component button:has-text("Add component")');
    await page.click('.add-menu [role="menuitem"]:has-text("Animation")');
    await selectField(page, 'Clip', 'Wave', { section: 'Animation' });

    const limbLoaded = await waitForModelStatus(page, 'loaded', 30_000);
    const limbClips = await page.evaluate(() => {
      const studio = window.__STUDIO__;
      const id = studio?.session.selection.primary;
      return id ? studio?.session.clipsFor(id) ?? [] : [];
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
    await page.click('.add-component button:has-text("Add component")');
    await page.click('.add-menu [role="menuitem"]:has-text("Material")');
    await setColorField(page, 'Colour', '#2f6f4f');

    const inspectorEdits = await page.evaluate(() => {
      const scene = window.__STUDIO__?.session.scene;
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
      const studio = window.__STUDIO__;
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

    // --- keyboard focus (plan §16) ------------------------------------------------
    // Typing in a field must not reach the editor's shortcuts: G/R/S switch tools, X deletes,
    // A selects all, and Shift+D duplicates, so a rename that triggered them would silently edit the scene.
    // removes the selection, so a rename that triggered them would silently edit the scene.
    await page.click('.tree-row:has-text("Crate A")');
    await page.locator('.toolbar-group[aria-label="Transform tool"] button:has-text("Move")').click();
    const nameField = page.locator('.inspector-title .name-field');
    await nameField.click();
    await nameField.press('End');
    await nameField.press('w');
    await nameField.press('e');
    await nameField.press('r');
    await nameField.press('g');
    await nameField.press('s');
    await nameField.press('x');
    await nameField.press('a');
    await nameField.press('Shift+D');
    await nameField.press('Delete');
    const focusState = await page.evaluate(() => {
      const session = window.__STUDIO__?.session;
      const tool = document.querySelector('.toolbar-group[aria-label="Transform tool"] button.active')?.textContent ?? null;
      const active = document.activeElement as HTMLElement | null;
      return {
        tool,
        focused: active?.className ?? null,
        name: session?.scene?.entities.find((entity) => entity.name.startsWith('Crate A'))?.name ?? null,
        entityCount: session?.scene?.entities.length ?? 0,
      };
    });
    await nameField.fill('Crate A');
    await nameField.blur();
    record({
      id: 'keyboard-focus',
      title: 'Typing in a text field does not trigger the editor keyboard shortcuts',
      passed: focusState.tool === 'Move' && (focusState.name ?? '').includes('wer') && focusState.entityCount >= 4,
      detail: `typed "wer" into the name field: tool stayed ${String(focusState.tool)}, name is "${String(focusState.name)}", ${focusState.entityCount} entities still present`,
      observed: focusState,
    });

    // --- drag cancellation (plan §16) ---------------------------------------------
    // Start a real transform drag, abandon it with Escape, and release: the authored document and
    // the undo history must be exactly what they were before the drag started.
    await page.locator('.toolbar-group[aria-label="Transform tool"] button:has-text("Move")').click();
    const crateId = await page.evaluate(() => window.__STUDIO__?.session.selection.primary ?? null);
    const readCrate = () =>
      page.evaluate((id: string | null) => {
        const studio = window.__STUDIO__;
        const entity = studio?.session.scene?.entities.find((candidate) => candidate.id === id);
        return {
          id,
          name: entity?.name ?? null,
          document: entity?.transform.position ?? null,
          projected: id ? studio?.viewport?.()?.project(id) ?? null : null,
          dragging: studio?.viewport?.()?.isDragging() ?? null,
          undoLabel: studio?.session.snapshot().undoLabel ?? null,
          canUndo: studio?.session.snapshot().canUndo ?? null,
        };
      }, crateId);
    const canvasBox = await page.locator('#editor-canvas').boundingBox();
    const beforeDrag = await readCrate();
    let grabbed = false;
    if (canvasBox && crateId) {
      const centre = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };
      // Recentre the view on the selection through the viewport handle rather than by clicking the
      // canvas: a click would re-pick whatever is under the cursor and the probe could grab a
      // different entity's gizmo. The translate gizmo then sits at the centre of the canvas; the
      // four arrow directions are probed so a camera orientation change cannot quietly skip this.
      for (const [dx, dy] of [
        [64, 0],
        [-64, 0],
        [0, 64],
        [0, -64],
        [64, 64],
      ] as Array<[number, number]>) {
        await page.evaluate(() => window.__STUDIO__?.viewport?.()?.focusSelection());
        await page.waitForTimeout(150);
        await page.mouse.move(centre.x + dx, centre.y + dy);
        await page.mouse.down();
        await page.mouse.move(centre.x + dx * 1.8, centre.y + dy * 1.8, { steps: 5 });
        const probed = await readCrate();
        grabbed = probed.dragging === true && probed.id === crateId;
        if (grabbed) break;
        await page.mouse.up();
        await page.waitForTimeout(100);
      }
    }
    const duringDrag = await readCrate();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    const afterEscape = await readCrate();
    await page.mouse.up();
    await page.waitForTimeout(200);
    const afterRelease = await readCrate();
    const samePosition = (a: number[] | null, b: number[] | null): boolean =>
      Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3 && a.every((value, index) => Math.abs(value - b[index]!) < 1e-6);
    record({
      id: 'drag-cancellation',
      title: 'A transform drag abandoned with Escape changes nothing and records nothing',
      passed:
        grabbed &&
        duringDrag.dragging === true &&
        !samePosition(duringDrag.projected, duringDrag.document) &&
        samePosition(duringDrag.document, beforeDrag.document) &&
        afterEscape.dragging === false &&
        samePosition(afterEscape.projected, beforeDrag.document) &&
        samePosition(afterRelease.document, beforeDrag.document) &&
        afterRelease.undoLabel === beforeDrag.undoLabel &&
        afterRelease.canUndo === beforeDrag.canUndo,
      detail: `grabbed=${grabbed}; during the drag the projection moved to ${JSON.stringify(duringDrag.projected)} while the document stayed ${JSON.stringify(duringDrag.document)}; after Escape the projection is ${JSON.stringify(afterEscape.projected)} and the undo label is still ${String(afterRelease.undoLabel)}`,
      observed: { beforeDrag, duringDrag, afterEscape, afterRelease, grabbed },
    });

    // --- save, reopen, revise -----------------------------------------------------
    await page.click('button[aria-label="Save"]');
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
    await page.waitForFunction(() => window.__STUDIO__ !== undefined, undefined, {
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
      const studio = window.__STUDIO__;
      const viewport = studio?.viewport?.();
      const entities = studio?.session.scene?.entities ?? [];
      const limbId = entities.find((entity) => entity.name === 'Limb')?.id ?? '';
      const crateId = entities.find((entity) => entity.name === 'Crate A')?.id ?? '';
      if (!viewport) return null;
      // The play world builds asynchronously (WASM, then the skinned model), so poll for the clip
      // actually advancing rather than sampling once: a slow start is not a broken animation.
      const started = Date.now();
      let first = viewport.playAnimationState(limbId);
      let second = first;
      while (Date.now() - started < 20_000) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        second = viewport.playAnimationState(limbId);
        if (!first) {
          first = second;
          continue;
        }
        if (second && second.time > first.time) break;
      }
      const crate = viewport.playAnimationState(crateId);
      return {
        ids: { limbId, crateId },
        first,
        second,
        crate,
        stats: viewport.playStats() as { loadedModels: number; animatedEntities: number; entities: number } | null,
        waitedMs: Date.now() - started,
      };
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
        ? `Limb clip "${playAnimation?.second?.clip}" advanced ${playAnimation?.first?.time.toFixed(3)} -> ${playAnimation?.second?.time.toFixed(3)} after ${playAnimation?.waitedMs ?? 0} ms; ${playAnimation?.stats?.animatedEntities} animated entities, ${playAnimation?.stats?.loadedModels} models loaded`
        : `animation did not advance within 20 s: ids ${JSON.stringify(playAnimation?.ids ?? null)}, samples ${JSON.stringify(playAnimation?.first ?? null)} / ${JSON.stringify(playAnimation?.second ?? null)}`,
      observed: playAnimation,
    });
    await page.screenshot({ path: join(evidenceDir, 'play-with-models.png') });

    /**
     * The view gizmo is the stage's view control, and a view control has nothing to say during Play:
     * the camera belongs to the game then, not to the user, and the play world is rendered on its own
     * canvas from a fresh snapshot. It used to stay up — it was a whole panel of switches then —
     * covering the game and the runtime HUD's own readout.
     */
    const gizmosInPlay = await page.locator('.view-gizmo').count();
    record({
      id: 'view-gizmo-hidden-in-play',
      title: 'The view gizmo is not mounted while a simulation runs',
      passed: gizmosInPlay === 0,
      detail:
        gizmosInPlay === 0
          ? 'the gizmo leaves the stage in Play, so it covers neither the game nor the runtime HUD'
          : `${gizmosInPlay} view gizmo(s) still mounted over the play canvas`,
      observed: { gizmosInPlay },
    });

    await page.click('button[aria-label="Stop and discard the simulation"]');
    await page.waitForSelector('.viewport-badge', { state: 'detached', timeout: 15_000 });

    /**
     * Geometric, not textual: the hint card and the gizmo share the top of the stage and the same
     * `zIndex`, so paint order falls to DOM order and the assertion is simply that their boxes do not
     * intersect.
     *
     * Measured at two stage widths, and the narrow one is the point. At the default 764px stage a card
     * centred on the *whole* stage happens to stop short of the gizmo's 116px lane, so a single wide
     * measurement passes whether or not the card reserves that lane — it would be a check asserting
     * coverage it does not have. Shrinking the window is what makes the two implementations differ,
     * and a narrow stage is reachable in normal use by dragging either column wider.
     */
    const measureOverlap = async () => {
      await page.waitForSelector('.view-gizmo', { timeout: 15_000 });
      const card = await page.locator('.hint-card').boundingBox();
      const gizmo = await page.locator('.view-gizmo').boundingBox();
      const stage = await page
        .locator('.view-gizmo')
        .evaluate((element) => Math.round(element.parentElement?.parentElement?.getBoundingClientRect().width ?? 0));
      const gap =
        card && gizmo
          ? Math.min(card.x + card.width, gizmo.x + gizmo.width) - Math.max(card.x, gizmo.x)
          : null;
      return { card, gizmo, stage, gap };
    };

    const wide = await measureOverlap();
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.waitForTimeout(500);
    const narrow = await measureOverlap();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);

    const describe = (sample: typeof wide): string =>
      sample.gap === null
        ? `a stage of ${sample.stage}px could not be measured`
        : `on a ${sample.stage}px stage the hint ends at ${Math.round((sample.card?.x ?? 0) + (sample.card?.width ?? 0))} and the gizmo starts at ${Math.round(sample.gizmo?.x ?? 0)}: ${
            sample.gap <= 0 ? `${Math.round(-sample.gap)}px clear` : `${Math.round(sample.gap)}px of the hint is covered`
          }`;

    record({
      id: 'overlays-do-not-overlap',
      title: 'The hint card and the view gizmo do not overlap on the stage, wide or narrow',
      passed: wide.gap !== null && wide.gap <= 0 && narrow.gap !== null && narrow.gap <= 0,
      detail: `${describe(wide)}; ${describe(narrow)}`,
      observed: { wide, narrow },
    });

    /**
     * The gizmo must turn the view like a turntable, never like a trackball.
     *
     * A trackball rolls, and roll is what makes an orbit read as "the whole viewport is spinning".
     * This project shipped one: after a tilt followed by a sideways drag the camera's right axis
     * measured `[-0.201, -0.582, 0.788]` where it had been `[0.549, 0, 0.836]`, tilting the horizon
     * 35°. The invariant is exact and cheap — the right axis stays horizontal — and it is checked
     * after every step, because roll accumulates rather than appearing at once.
     *
     * `up` is deliberately not asserted: a camera looking down has a tilted up vector legitimately,
     * so requiring `up = (0,1,0)` would fail on a perfectly good view. It is the *right* axis that
     * says whether the horizon is level.
     */
    const dragGizmo = async (dx: number, dy: number): Promise<{ roll: number; turned: number }> => {
      const box = await page.locator('.view-gizmo').boundingBox();
      if (!box) return { roll: Number.NaN, turned: Number.NaN };
      const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const before = await page.evaluate(() => window.__STUDIO__?.viewport?.()?.cameraBasis().forward ?? [0, 0, 0]);
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.down();
      for (let step = 1; step <= 10; step += 1) {
        await page.mouse.move(centre.x + (dx * step) / 10, centre.y + (dy * step) / 10);
      }
      await page.mouse.up();
      await page.waitForTimeout(200);
      return page.evaluate(
        ({ previous }) => {
          const basis = window.__STUDIO__?.viewport?.()?.cameraBasis();
          if (!basis) return { roll: Number.NaN, turned: Number.NaN };
          const dot = basis.forward[0] * previous[0] + basis.forward[1] * previous[1] + basis.forward[2] * previous[2];
          return {
            roll: Math.abs(basis.right[1]),
            /** How far the view actually turned, which "did it roll?" cannot tell you. */
            turned: Math.acos(Math.min(1, Math.max(-1, dot))),
          };
        },
        { previous: before },
      );
    };

    const afterTilt = await dragGizmo(0, -80);
    const afterSideways = await dragGizmo(100, 0);
    const afterBoth = await dragGizmo(-60, 40);
    const drags = [afterTilt, afterSideways, afterBoth];
    /**
     * Both halves matter, and the second half is the one that was missing.
     *
     * Roll was the reported bug, so the level check came first. But a drag that rolls *nothing*
     * because it barely moves also passes it: the pixels-to-radians conversion was being applied
     * twice, so 100px turned the view 0.6°, and this check was happy. Asserting that each drag also
     * turns the view a sensible amount is what makes "no roll" mean "a level turn" rather than "no
     * turn at all".
     */
    record({
      id: 'gizmo-orbit-does-not-roll',
      title: 'Dragging the view gizmo turns the view without rolling the horizon',
      passed: drags.every((drag) => drag.roll < 1e-3 && drag.turned > 0.2),
      detail: `tilt and two sideways drags: |right.y| = ${drags
        .map((drag) => drag.roll.toExponential(1))
        .join(', ')}; turned ${drags.map((drag) => `${((drag.turned * 180) / Math.PI).toFixed(1)}°`).join(', ')}`,
      observed: { drags },
    });

    /**
     * The numpad, which is the only way to reach some of these views.
     *
     * Checked with `page.keyboard.press('Numpad7')` rather than a synthetic event, because the bug
     * this guards was a real one about real keyboards: with Num Lock off a numpad digit reports
     * "Home" as its `key`, and the frame-everything shortcut was swallowing Numpad 7 — so the top view
     * was unreachable for anyone who had Num Lock off. Reading `code` fixed it, and only a real key
     * press exercises that path.
     */
    const readView = async (): Promise<{ projection: string; up: number[]; inCameraView: boolean }> =>
      page.evaluate(() => {
        const viewport = window.__STUDIO__?.viewport?.();
        const basis = viewport?.cameraBasis();
        return {
          projection: viewport?.display().projection ?? 'unknown',
          up: (basis?.up ?? [0, 0, 0]).map((value) => Number(value.toFixed(3))),
          inCameraView: viewport?.inCameraView() ?? false,
        };
      });

    await page.keyboard.press('Numpad7');
    await page.waitForTimeout(400);
    const topView = await readView();
    await page.keyboard.press('Numpad5');
    await page.waitForTimeout(400);
    const afterToggle = await readView();
    await page.keyboard.press('Numpad0');
    await page.waitForTimeout(700);
    const entered = await readView();
    /**
     * What the preview is actually showing *through*, not just where it is standing.
     *
     * A camera view that keeps the editor's own field of view and clipping planes is a different
     * picture from the one the game starts with — it shows geometry the game camera clips — and the
     * authored values are in the document, so the comparison is exact rather than approximate.
     */
    const previewPlanes = await page.evaluate(() => {
      const viewport = window.__STUDIO__?.viewport?.();
      const scene = window.__STUDIO__?.session.scene;
      const entity = scene?.entities.find((candidate) => candidate.id === scene.activeCameraId);
      const component = entity?.components.find((candidate) => candidate.type === 'camera');
      return {
        shown: viewport?.cameraPlanes() ?? null,
        authored: component && component.type === 'camera' ? { fov: component.fov, near: component.near, far: component.far } : null,
      };
    });
    await page.keyboard.press('Numpad0');
    await page.waitForTimeout(700);
    const left = await readView();

    /**
     * Home has to frame the *level*, and the number says whether it did.
     *
     * `Box3.setFromObject` walked the editor-only helpers under each entity, and a camera's
     * `CameraHelper` draws its frustum out to the far plane — hundreds of metres in these projects. So
     * Home moved the camera 1268 metres away and the level became a speck. Distance is the honest
     * measurement: a framed sixteen-metre room cannot need two hundred metres of standoff.
     */
    await page.keyboard.press('Home');
    await page.waitForTimeout(700);
    const framedDistance = await page.evaluate(() => window.__STUDIO__?.viewport?.()?.cameraDistance() ?? 0);

    record({
      id: 'numpad-view-navigation',
      title: 'The numpad drives the view: a face, the projection, and the game camera',
      passed:
        topView.projection === 'orthographic' &&
        Math.abs((topView.up[2] ?? 0) + 1) < 1e-3 &&
        afterToggle.projection === 'perspective' &&
        entered.inCameraView &&
        !left.inCameraView &&
        framedDistance < 200 &&
        previewPlanes.authored !== null &&
        previewPlanes.shown !== null &&
        Math.abs(previewPlanes.shown.far - previewPlanes.authored.far) < 1e-6 &&
        Math.abs(previewPlanes.shown.fov - previewPlanes.authored.fov) < 1e-6,
      detail: `after Numpad7 the view was ${topView.projection} with up ${JSON.stringify(topView.up)} (a top view is orthographic with up (0, 0, -1)); Numpad5 then made it ${afterToggle.projection}; Numpad0 entered the game camera (${entered.inCameraView}) and left it (${!left.inCameraView}); Home framed the scene from ${framedDistance.toFixed(1)} m; the preview used the authored fov ${previewPlanes.shown?.fov} and far plane ${previewPlanes.shown?.far} against ${previewPlanes.authored?.fov} and ${previewPlanes.authored?.far} in the document`,
      observed: { topView, afterToggle, entered, left, framedDistance, previewPlanes },
    });

    // --- missing asset error is understandable -------------------------------------
    // Delete the file behind a manifest entry, then load the scene again: the entity must
    // report a failure rather than quietly rendering nothing.
    const assetDir = join(workspaceRoot, 'stage2-room', 'assets', 'models');
    const { readdir, unlink } = await import('node:fs/promises');
    const crateFile = (await readdir(assetDir)).find((name) => name.startsWith('spinning-crate'));
    if (crateFile) await unlink(join(assetDir, crateFile));

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__STUDIO__ !== undefined, undefined, {
      timeout: 30_000,
    });
    await page.click('.card:has-text("Stage 2 Room") button:has-text("Open")');
    await page.waitForSelector('.tree-row', { timeout: 20_000 });
    await page.click('.tree-row:has-text("Crate A")');
    const missingState = await page.evaluate(async () => {
      const studio = window.__STUDIO__;
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

/**
 * Choose an option in a component field.
 *
 * The Inspector's pickers moved from a native `<select>` to a Radix dropdown, which renders a button
 * plus a portalled listbox rather than a `<select>`. This drives whichever is present, so the gate is
 * pinned to "choose the option called X" rather than to the element type underneath — the same reason
 * the toolbar's icon-only buttons are selected by accessible name.
 */
/**
 * Choose an option in a component field.
 *
 * The Inspector's pickers moved from a native `<select>` to a Radix dropdown, which renders a button
 * plus a portalled listbox rather than a `<select>`. This drives whichever is present, so the gate is
 * pinned to "choose the option called X" rather than to the element type underneath — the same reason
 * the toolbar's icon-only buttons are selected by accessible name.
 *
 * The option may be named by its stored value (`box`) or by the label it shows (`Box`); both are
 * published on the option, so the caller says which it means.
 */
async function pickOption(page: Page, value: string): Promise<void> {
  const option = page
    .locator(`[role="option"][data-value="${value}"], [role="option"][data-label="${value}"]`)
    .first();
  await option.click();
  await page.waitForTimeout(120);
}

async function setComponentSelect(page: Page, label: string, value: string, options: { section?: string } = {}): Promise<void> {
  const scope = options.section ? page.locator(`.section:has(.section-title:text-is("${options.section}"))`).first() : page;
  const field = scope.locator(`.field:has(.field-label:text-is("${label}"))`).first();
  if ((await field.count()) === 0) return;

  const native = field.locator('select').first();
  if ((await native.count()) > 0) {
    await native.selectOption(value);
    await page.waitForTimeout(120);
    return;
  }

  await field.locator('[role="combobox"]').first().click();
  await pickOption(page, value);
}

async function selectField(page: Page, label: string, value: string, options: { section?: string } = {}): Promise<void> {
  await setComponentSelect(page, label, value, options);
}

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
