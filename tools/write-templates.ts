import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION, PROJECT_SCHEMA_VERSION, SCENE_SCHEMA_VERSION } from '../src/schema/index.js';
import { createStarterScene } from '../src/editor/document/factory.js';

/**
 * Materialises `templates/` from code so the starter content and the editor's creation
 * menu cannot drift. Templates are whole-project copies (plan §6), not linked prefabs.
 *
 * Run with: pnpm tsx tools/write-templates.ts
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const templatesRoot = join(root, 'templates');

async function writeTemplate(templateId: string, files: Record<string, string>): Promise<void> {
  const target = join(templatesRoot, templateId);
  await rm(target, { recursive: true, force: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(target, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
    process.stdout.write(`wrote ${path}\n`);
  }
}

const game = {
  schemaVersion: PROJECT_SCHEMA_VERSION,
  engineVersion: ENGINE_VERSION,
  engineCompat: ENGINE_VERSION,
  id: 'blank',
  name: 'Blank Game',
  description: 'A ground plane, a player capsule, a camera, and a sun. Start here.',
  scenes: [{ id: 'main', name: 'Main', path: 'scenes/main.scene.json' }],
  startScene: 'main',
  assetManifest: 'assets/manifest.json',
  behaviorRegistry: 'scripts/registry.json',
  settings: {
    physics: { fixedTimeStep: 1 / 60, subStepCount: 4, maxSubSteps: 5, enableSleep: true, hitEventThreshold: 1 },
    render: { antialias: true, shadows: true, pixelRatioCap: 2, toneMapping: 'aces', exposure: 1 },
    initialGameState: {},
    hud: [],
    inputBindings: {},
  },
};

const scene = { ...createStarterScene('main', 'Main'), schemaVersion: SCENE_SCHEMA_VERSION };

await writeTemplate('blank', {
  'game.json': `${JSON.stringify(game, null, 2)}\n`,
  'scenes/main.scene.json': `${JSON.stringify(scene, null, 2)}\n`,
  'assets/manifest.json': `${JSON.stringify({ schemaVersion: 1, assets: [] }, null, 2)}\n`,
  'scripts/registry.json': `${JSON.stringify({ schemaVersion: 1, behaviors: [] }, null, 2)}\n`,
  'README.md': [
    '# Blank Game',
    '',
    'Created from the `blank` template of the Coilbox.',
    '',
    '- `game.json` — project manifest: scenes, start scene, and game settings.',
    '- `scenes/main.scene.json` — the authored level: entities, transforms, components.',
    '- `assets/manifest.json` — asset identity and content hashes.',
    '- `scripts/registry.json` — declarative behavior metadata.',
    '',
    'Open the project in the studio, or validate it with `pnpm studio validate <project-id>`.',
    '',
  ].join('\n'),
});
