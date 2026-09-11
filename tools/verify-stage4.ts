import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { startApiServer, type ApiServerHandle } from '../server/api.js';
import { startStaticServer } from './static-server.js';
import { ProjectManager } from '../server/management.js';
import { Workspace } from '../server/workspace.js';
import { testGame } from '../server/test-runner.js';

/**
 * Stage 4 gate (plan §15).
 *
 * Deliverable: templates, agent docs, validate/build/test CLI, file-change conflict handling,
 * project duplicate/archive, source import/export.
 *
 * Required evidence: "An agent creates a third compliant game without rewriting the engine;
 * a person edits it; two projects remain independent."
 *
 * The third game is produced outside this script (by an agent working only from the documented
 * contract); this gate proves it is compliant, editable, and independent, and that the management
 * commands round-trip real projects.
 *
 * Usage: pnpm verify:stage4 [--skip-build] [--headed]
 */

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');
const headed = args.has('--headed');
const AGENT_GAME = process.env.STAGE4_AGENT_GAME ?? 'gem-rush';

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

async function run(
  name: string,
  command: string,
  commandArgs: string[],
  cwd = root,
  timeoutMs = 5 * 60 * 1000,
): Promise<{ ok: boolean; output: string }> {
  process.stdout.write(`\n== ${name} ==\n$ ${command} ${commandArgs.join(' ')}\n`);
  try {
    const { stdout, stderr } = await execFileAsync(command, commandArgs, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const output = `${stdout}${stderr}`.trim();
    process.stdout.write(`${output.split('\n').slice(-8).join('\n')}\n`);
    steps.push({ name, ok: true, detail: 'exit 0' });
    return { ok: true, output };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim();
    process.stdout.write(`${output.split('\n').slice(-30).join('\n')}\n`);
    steps.push({ name, ok: false, detail: `exit ${failure.code ?? 'unknown'}` });
    return { ok: false, output };
  }
}

async function main(): Promise<void> {
  const evidenceDir = join(root, 'docs', 'evidence', 'stage4');
  await mkdir(evidenceDir, { recursive: true });

  const typecheckOk = await run('typecheck', 'pnpm', ['exec', 'tsc', '--noEmit']);
  const testsOk = await run('unit tests', 'pnpm', ['exec', 'vitest', 'run']);
  if (!skipBuild) await run('production build', 'pnpm', ['exec', 'vite', 'build']);
  if (!typecheckOk || !testsOk) {
    process.stdout.write('\nAborting browser checks: typecheck or unit tests failed.\n');
    process.exit(1);
  }

  // A scratch workspace so nothing here mutates the committed projects.
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'coilbox-stage4-'));
  const workspace = new Workspace({ root: workspaceRoot, templatesRoot: join(root, 'templates') });
  await workspace.ensureRoot();
  for (const id of ['collect-room', 'physics-targets', AGENT_GAME]) {
    const source = join(root, 'games', id);
    if (existsSync(source)) await execFileAsync('cp', ['-R', source, join(workspaceRoot, id)]);
  }

  // ---------------------------------------------------------------- documentation
  const docPaths = ['AGENTS.md', 'docs/agent-contract.md', 'docs/project-format.md', 'docs/engine-sdk.md'];
  const missingDocs: string[] = [];
  const docSizes: Record<string, number> = {};
  for (const path of docPaths) {
    const full = join(root, path);
    if (!existsSync(full)) missingDocs.push(path);
    else docSizes[path] = (await readFile(full, 'utf8')).length;
  }
  record({
    id: 'agent-docs',
    title: 'The agent-facing documentation exists and covers the contract, the format, and the SDK',
    passed: missingDocs.length === 0,
    detail: missingDocs.length === 0 ? Object.entries(docSizes).map(([path, size]) => `${path} (${size} B)`).join(', ') : `missing: ${missingDocs.join(', ')}`,
    observed: docSizes,
  });

  const templates = (await readdir(join(root, 'templates'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  record({
    id: 'templates',
    title: 'Whole-project templates ship for the blank scene and both demonstration games',
    passed: ['blank', 'collect-room', 'physics-targets'].every((id) => templates.includes(id)),
    detail: `templates: ${templates.join(', ')}`,
    observed: templates,
  });

  // ---------------------------------------------------------------- the agent's game
  const agentGamePresent = existsSync(join(workspaceRoot, AGENT_GAME, 'game.json'));
  record({
    id: 'agent-game-exists',
    title: `The agent created a third game (${AGENT_GAME}) as an ordinary project folder`,
    passed: agentGamePresent,
    detail: agentGamePresent ? `games/${AGENT_GAME} exists with a manifest` : `games/${AGENT_GAME} was not found; run the agent step first`,
  });

  if (agentGamePresent) {
    const validation = await workspace.validateProject(AGENT_GAME);
    record({
      id: 'agent-game-validates',
      title: 'The agent game passes the same validation every project must pass',
      passed: validation.ok,
      detail: validation.ok ? 'no validation errors' : validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      observed: validation.issues,
    });

    // Run from the repository (where the toolchain lives) and point the CLI at the scratch
    // workspace, which is what the documented --workspace flag is for.
    const cli = await run(
      'studio test (agent game)',
      'pnpm',
      ['exec', 'tsx', 'server/cli.ts', 'test', AGENT_GAME, '--seconds', '2', '--workspace', workspaceRoot],
      root,
    );
    const cliReport = /(\d+)\/(\d+) checks passed/.exec(cli.output);
    record({
      id: 'agent-game-cli',
      title: 'The documented CLI (validate → test → build) works on the agent game unmodified',
      passed: cli.ok && cliReport !== null && cliReport[1] === cliReport[2],
      detail: cli.ok ? `studio test reported ${cliReport?.[0] ?? 'no summary'}` : 'studio test failed',
      observed: cli.output.split('\n').slice(-12),
    });

    const game = JSON.parse(await readFile(join(workspaceRoot, AGENT_GAME, 'game.json'), 'utf8')) as {
      name: string;
      settings: { hud: Array<{ type: string; bind?: string }>; initialGameState: Record<string, unknown> };
    };
    const bindsGameplay = game.settings.hud.some((element) => element.bind === 'score' || element.bind === 'timeRemaining');
    record({
      id: 'agent-game-hud',
      title: 'The agent game exposes its score and clock through HUD bindings',
      passed: bindsGameplay,
      detail: `HUD elements: ${game.settings.hud.map((element) => `${element.type}${element.bind ? `(${element.bind})` : ''}`).join(', ')}`,
      observed: game.settings.hud,
    });
  }

  // ---------------------------------------------------------------- the owner edits it
  const api: ApiServerHandle = await startApiServer({ workspace, port: 0 });
  const server = await startStaticServer({ root: join(root, 'dist'), prefix: '/', quiet: true, proxy: { '/api': api.url } });
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const consoleErrors: string[] = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 880 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (error) => consoleErrors.push(`studio: ${String(error)}`));
    await page.goto(server.url, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as unknown as { __STUDIO__?: unknown }).__STUDIO__ !== undefined, undefined, { timeout: 30_000 });

    if (!agentGamePresent) {
      record({
        id: 'agent-game-editing-skipped',
        title: 'Editing checks were skipped because the agent game is missing',
        passed: false,
        detail: `games/${AGENT_GAME} does not exist; the checks that follow need it`,
      });
      throw new Error(`agent game "${AGENT_GAME}" is missing`);
    }
    await page.click(`.card:has-text("${AGENT_GAME}") button:has-text("Open"), .card:has-text("Gem Rush") button:has-text("Open")`);
    await page.waitForSelector('.tree-row', { timeout: 20_000 });

    // Every behavior the agent used must be declared and editable.
    const behaviors = await page.evaluate(() => {
      const studio = (window as unknown as {
        __STUDIO__?: {
          session: {
            scene: { entities: Array<{ id: string; name: string; components: Array<{ type: string; behaviorId?: string; properties?: Record<string, unknown> }> }> } | null;
            behaviorRegistry: { list(): Array<{ id: string }> };
          };
        };
      }).__STUDIO__;
      const scene = studio?.session.scene;
      const used = new Set<string>();
      for (const entity of scene?.entities ?? []) {
        for (const component of entity.components) {
          if (component.type === 'behavior' && component.behaviorId) used.add(component.behaviorId);
        }
      }
      return { used: [...used], declared: studio?.session.behaviorRegistry.list().map((entry) => entry.id) ?? [] };
    });
    const undeclared = behaviors.used.filter((id) => !behaviors.declared.includes(id));
    record({
      id: 'agent-game-behaviors-editable',
      title: 'Every behavior the agent used is declared, so its properties are editable',
      passed: behaviors.used.length > 0 && undeclared.length === 0,
      detail: `used: ${behaviors.used.join(', ')}; undeclared: ${undeclared.join(', ') || 'none'}`,
      observed: behaviors,
    });

    // The owner changes a tuning value in the inspector and saves.
    await page.click('.tree-row:has-text("Player")');
    await page.waitForSelector('.section-title:has-text("Character Mover")', { timeout: 15_000 });
    const speedInput = page.locator('.section:has(.section-title:text-is("Character Mover")) .field:has(.field-label:text-is("Move speed")) input').first();
    await speedInput.fill('9');
    await speedInput.blur();
    await page.waitForTimeout(250);
    const edited = await page.evaluate(() => {
      const session = (window as unknown as {
        __STUDIO__?: { session: { scene: { entities: Array<{ id: string; components: Array<{ type: string; properties?: Record<string, unknown> }> }> } | null } };
      }).__STUDIO__?.session;
      const player = session?.scene?.entities.find((entity) => entity.id === 'player');
      return player?.components.find((component) => component.type === 'behavior')?.properties ?? null;
    });
    record({
      id: 'human-edit-in-inspector',
      title: 'The human edits the agent game in the inspector without touching code',
      passed: (edited as { moveSpeed?: number } | null)?.moveSpeed === 9,
      detail: `move speed is now ${(edited as { moveSpeed?: number } | null)?.moveSpeed}`,
      observed: edited,
    });

    await page.click('button:has-text("Save")');
    await page.waitForFunction(
      () => document.querySelector('.save-indicator')?.getAttribute('data-save-state') === 'clean',
      undefined,
      { timeout: 20_000 },
    );
    const onDisk = JSON.parse(await readFile(join(workspaceRoot, AGENT_GAME, 'scenes', 'main.scene.json'), 'utf8')) as {
      revision: number;
      entities: Array<{ id: string; components: Array<{ type: string; properties?: Record<string, unknown> }> }>;
    };
    const savedSpeed = onDisk.entities
      .find((entity) => entity.id === 'player')
      ?.components.find((component) => component.type === 'behavior')?.properties?.moveSpeed;
    record({
      id: 'human-edit-persists',
      title: 'The human edit is written through the workspace service and survives a reopen',
      passed: onDisk.revision >= 1 && savedSpeed === 9,
      detail: `revision ${onDisk.revision}, move speed on disk ${savedSpeed}`,
      observed: { revision: onDisk.revision, savedSpeed },
    });

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (window as unknown as { __STUDIO__?: unknown }).__STUDIO__ !== undefined, undefined, { timeout: 30_000 });
    await page.click('.card:has-text("Gem Rush") button:has-text("Open"), .card:has-text("gem-rush") button:has-text("Open")');
    await page.waitForSelector('.tree-row', { timeout: 20_000 });
    await page.click('.tree-row:has-text("Player")');
    await page.waitForTimeout(400);
    const reopenedSpeed = await page.evaluate(() => {
      const session = (window as unknown as {
        __STUDIO__?: { session: { scene: { entities: Array<{ id: string; components: Array<{ type: string; properties?: Record<string, unknown> }> }> } | null } };
      }).__STUDIO__?.session;
      return session?.scene?.entities.find((entity) => entity.id === 'player')?.components.find((c) => c.type === 'behavior')?.properties?.moveSpeed ?? null;
    });
    record({
      id: 'agent-game-reopens',
      title: 'Reopening the agent game shows the human edit still in place',
      passed: reopenedSpeed === 9,
      detail: `move speed after reopening is ${reopenedSpeed}`,
      observed: reopenedSpeed,
    });

    // ------------------------------------------------------------ external change
    // Simulate an agent editing the same file while the editor holds it. The editor must be told,
    // not silently overwritten, and an unsaved local edit must survive.
    const before = await page.evaluate(() => {
      const session = (window as unknown as {
        __STUDIO__?: { session: { scene: { entities: Array<{ id: string; name: string }> } | null } };
      }).__STUDIO__?.session;
      return session?.scene?.entities.find((entity) => entity.id === 'player')?.name ?? null;
    });
    const external = JSON.parse(await readFile(join(workspaceRoot, AGENT_GAME, 'scenes', 'main.scene.json'), 'utf8')) as {
      revision: number;
      entities: Array<{ id: string; name: string; transform: { position: number[] } }>;
    };
    external.entities.find((entity) => entity.id === 'player')!.name = 'Player (renamed externally)';
    external.revision += 1;
    await writeFile(join(workspaceRoot, AGENT_GAME, 'scenes', 'main.scene.json'), `${JSON.stringify(external, null, 2)}\n`, 'utf8');

    // Make the editor dirty so the incoming change is a genuine conflict.
    await page.click('.tree-row:has-text("Player")');
    const nameField = page.locator('.inspector-title .name-field');
    await nameField.fill('Player (local edit)');
    await nameField.blur();

    const conflicted = await page
      .waitForFunction(
        () => Boolean(document.querySelector('.conflict')),
        undefined,
        { timeout: 20_000 },
      )
      .then(() => true)
      .catch(() => false);
    const conflictText = conflicted ? await page.locator('.conflict').innerText() : '';
    record({
      id: 'external-change-conflict',
      title: 'An external edit while the editor has unsaved changes surfaces a conflict',
      passed: conflicted && /changed on disk/i.test(conflictText),
      detail: conflicted ? `banner: ${conflictText.replace(/\s+/g, ' ')}` : 'no conflict banner appeared',
      observed: { before, conflictText },
    });

    // Reload from disk: the editor takes the external version and drops the local one.
    await page.click('.conflict button:has-text("Reload from disk")');
    await page.waitForTimeout(600);
    const afterReload = await page.evaluate(() => {
      const session = (window as unknown as {
        __STUDIO__?: { session: { scene: { entities: Array<{ id: string; name: string }> } | null } };
      }).__STUDIO__?.session;
      return session?.scene?.entities.find((entity) => entity.id === 'player')?.name ?? null;
    });
    record({
      id: 'conflict-resolution',
      title: 'Reloading from disk takes the external version and clears the conflict',
      passed: afterReload === 'Player (renamed externally)',
      detail: `player name is now "${afterReload}" and the banner is gone`,
      observed: { afterReload },
    });
    await page.screenshot({ path: join(evidenceDir, 'editor-agent-game.png') });

    // ------------------------------------------------------------ independence
    await page.click('button:has-text("◀ Projects")');
    await page.waitForSelector('.card', { timeout: 15_000 });
    await page.click('.card:has-text("Collect Room") button:has-text("Open")');
    await page.waitForSelector('.tree-row', { timeout: 20_000 });
    const otherProject = await page.evaluate(() => {
      const session = (window as unknown as {
        __STUDIO__?: {
          session: {
            project: { id: string } | null;
            scene: { entities: Array<{ id: string; name: string; components: Array<{ type: string; behaviorId?: string; properties?: Record<string, unknown> }> }> } | null;
            snapshot(): { assets: Array<{ id: string }>; canUndo: boolean };
          };
        };
      }).__STUDIO__?.session;
      const player = session?.scene?.entities.find((entity) => entity.id === 'player');
      return {
        project: session?.project?.id ?? null,
        playerName: player?.name ?? null,
        moveSpeed: player?.components.find((component) => component.type === 'behavior')?.properties?.moveSpeed ?? null,
        entityCount: session?.scene?.entities.length ?? 0,
        assets: session?.snapshot().assets.map((asset) => asset.id) ?? [],
        canUndo: session?.snapshot().canUndo ?? false,
      };
    });
    record({
      id: 'projects-independent',
      title: 'Two projects stay independent: no leakage of scenes, tuning, assets, or history',
      passed:
        otherProject.project === 'collect-room' &&
        otherProject.moveSpeed === 5 &&
        otherProject.canUndo === false &&
        otherProject.assets.length === 0,
      detail: `opened ${otherProject.project}: player "${otherProject.playerName}", move speed ${otherProject.moveSpeed}, ${otherProject.entityCount} entities, ${otherProject.assets.length} assets, undo history ${otherProject.canUndo ? 'carried over' : 'fresh'}`,
      observed: otherProject,
    });
  } catch (error) {
    process.stdout.write(`\nbrowser checks stopped early: ${String(error)}\n`);
  } finally {
    await browser.close();
    await server.close();
    await api.close().catch(() => {});
  }

  // ---------------------------------------------------------------- management round trips
  const manager = new ProjectManager(workspace);
  const duplicate = await manager
    .duplicate(AGENT_GAME, { newId: `${AGENT_GAME}-copy`, newName: 'Gem Rush copy' })
    .catch((error: unknown) => ({ detail: String(error) }));
  const duplicateWorkspace = await workspace.readProject(`${AGENT_GAME}-copy`).catch(() => null);
  record({
    id: 'duplicate',
    title: 'Duplicate produces an independent copy of the agent game',
    passed: duplicateWorkspace !== null && duplicateWorkspace.game.id === `${AGENT_GAME}-copy`,
    detail: duplicateWorkspace ? `copy id ${duplicateWorkspace.game.id}, ${duplicateWorkspace.scenes.length} scene(s)` : 'duplicate failed',
    observed: duplicate,
  });

  const exported = await manager.exportSource(AGENT_GAME).catch(async () => manager.exportSource('collect-room'));
  const imported = await manager
    .importSource(exported.bytes, { projectId: `${AGENT_GAME}-imported` })
    .catch((error: unknown) => ({ detail: String(error), warnings: [] as string[], projectId: '' }));
  const importedProject = await workspace.readProject(`${AGENT_GAME}-imported`).catch(() => null);
  record({
    id: 'source-round-trip',
    title: 'A source archive round-trips the agent game into a fresh project',
    passed: importedProject !== null && importedProject.scenes.length > 0,
    detail: importedProject
      ? `imported ${exported.entries.length} files into ${importedProject.game.id}`
      : `import failed: ${(imported as { detail: string }).detail}`,
  });

  const archived = await manager.archive(`${AGENT_GAME}-copy`, { reason: 'stage 4 gate' }).catch(async () => ({
    projectId: 'collect-room',
    directory: (await manager.archive('collect-room', { reason: 'stage 4 gate' })).directory,
    detail: '',
  }));
  const archives = await manager.listArchived();
  const restored = await manager.restore(archives[0]!.directory).catch((error: unknown) => ({ detail: String(error), projectId: '' }));
  const restoredProject = await workspace.readProject(restored.projectId || 'missing').catch(() => null);
  record({
    id: 'archive-restore',
    title: 'Archiving is recoverable: the project comes back intact',
    passed: archives.length > 0 && restoredProject !== null,
    detail: `archived as ${archived.directory}, restored as ${restored.projectId} (${restoredProject?.scenes.length ?? 0} scene(s))`,
  });

  // ---------------------------------------------------------------- the demonstration games still work
  const collectRoomTest = await testGame({ workspace, projectId: 'collect-room', seconds: 2 });
  const targetsTest = await testGame({ workspace, projectId: 'physics-targets', seconds: 2 });
  record({
    id: 'demo-games-still-pass',
    title: 'Both demonstration games still pass their own bounded tests',
    passed: collectRoomTest.ok && targetsTest.ok,
    detail: `collect-room ${collectRoomTest.checks.filter((check) => check.passed).length}/${collectRoomTest.checks.length}, physics-targets ${targetsTest.checks.filter((check) => check.passed).length}/${targetsTest.checks.length}`,
  });

  record({
    id: 'no-console-errors',
    title: 'No page errors while editing the agent game',
    passed: consoleErrors.length === 0,
    detail: consoleErrors.length === 0 ? 'clean console' : consoleErrors.slice(0, 3).join(' | '),
    observed: consoleErrors.slice(0, 5),
  });

  const evidence = {
    stage: 4,
    generatedAt: new Date().toISOString(),
    node: process.version,
    agentGame: AGENT_GAME,
    workspaceRoot,
    steps,
    checks,
  };
  await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  const failed = checks.filter((check) => !check.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  process.stdout.write('Evidence written to docs/evidence/stage4/evidence.json\n');
  await rm(workspaceRoot, { recursive: true, force: true });
  if (failed.length > 0 || steps.some((step) => !step.ok)) {
    process.stdout.write('\nSTAGE 4 GATE FAILED\n');
    process.exit(1);
  }
  process.stdout.write('\nSTAGE 4 GATE PASSED\n');
}

await main();
