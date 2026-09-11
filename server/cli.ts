import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startApiServer, type ApiServerHandle } from './api.js';
import { Workspace } from './workspace.js';
import { buildGame } from './build.js';

/**
 * One command starts the studio (plan §13: "Run the editor and workspace service from one
 * development command after initial setup").
 *
 *   pnpm dev                  api + editor dev server
 *   pnpm studio api           api only
 *   pnpm studio create <id>   create a project from a template
 *   pnpm studio validate <id> validate a project on disk
 *   pnpm studio list          list projects in the workspace
 */

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export function defaultWorkspaceRoot(): string {
  return process.env.COILBOX_WORKSPACE ?? join(repositoryRoot, 'games');
}

export function defaultTemplatesRoot(): string {
  return process.env.COILBOX_TEMPLATES ?? join(repositoryRoot, 'templates');
}

export function createWorkspace(overrides: { root?: string; templatesRoot?: string } = {}): Workspace {
  return new Workspace({
    root: overrides.root ?? defaultWorkspaceRoot(),
    templatesRoot: overrides.templatesRoot ?? defaultTemplatesRoot(),
  });
}

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=');
      if (inline !== undefined) {
        flags.set(name ?? '', inline);
        continue;
      }
      const next = rest[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(name ?? '', next);
        index += 1;
      } else {
        flags.set(name ?? '', true);
      }
    } else {
      positionals.push(token);
    }
  }
  return { command, positionals, flags };
}

async function startDev(): Promise<void> {
  const args = parseArgs(['dev', ...process.argv.slice(3)]);
  const workspaceRoot = typeof args.flags.get('workspace') === 'string' ? (args.flags.get('workspace') as string) : defaultWorkspaceRoot();
  const workspace = createWorkspace({ root: workspaceRoot });
  await workspace.ensureRoot();

  let api: ApiServerHandle | null = null;
  let vite: { close(): Promise<void>; printUrls?(): void; resolvedUrls?: { local: string[] } } | null = null;

  try {
    api = await startApiServer({
      workspace,
      port: typeof args.flags.get('api-port') === 'string' ? Number(args.flags.get('api-port')) : undefined,
      logger: (message) => process.stdout.write(`${message}\n`),
    });

    const { createServer } = await import('vite');
    const server = await createServer({
      configFile: join(repositoryRoot, 'vite.config.ts'),
      server: {
        port: typeof args.flags.get('port') === 'string' ? Number(args.flags.get('port')) : undefined,
        proxy: {
          '/api': { target: api.url, changeOrigin: false },
        },
      },
    });
    await server.listen();
    vite = server as unknown as { close(): Promise<void>; resolvedUrls?: { local: string[] } };
    const urls = vite.resolvedUrls?.local ?? [];
    process.stdout.write(`\nCoilbox ready\n  editor:    ${urls[0] ?? 'see vite output'}index.html\n  probe:     ${urls[0] ?? ''}probe.html\n  workspace: ${workspaceRoot}\n\n`);
  } catch (error) {
    await api?.close();
    throw error;
  }

  const shutdown = async () => {
    await vite?.close();
    await api?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'dev':
      await startDev();
      return;
    case 'api': {
      const workspace = createWorkspace({
        root: typeof args.flags.get('workspace') === 'string' ? (args.flags.get('workspace') as string) : undefined,
      });
      const api = await startApiServer({
        workspace,
        port: typeof args.flags.get('port') === 'string' ? Number(args.flags.get('port')) : undefined,
        logger: (message) => process.stdout.write(`${message}\n`),
      });
      process.stdout.write(`session token: ${api.token}\n`);
      return;
    }
    case 'list': {
      const workspace = createWorkspace();
      const projects = await workspace.listProjects();
      if (projects.length === 0) {
        process.stdout.write('no projects yet\n');
        return;
      }
      for (const project of projects) {
        process.stdout.write(`${project.id}\t${project.name}\t${project.sceneCount} scene(s)\t${project.modifiedAt}\n`);
      }
      return;
    }
    case 'create': {
      const id = args.positionals[0];
      if (!id) throw new Error('usage: studio create <game-id> [--template blank] [--name "Display Name"]');
      const workspace = createWorkspace();
      const project = await workspace.createProject({
        id,
        name: typeof args.flags.get('name') === 'string' ? (args.flags.get('name') as string) : id,
        template: typeof args.flags.get('template') === 'string' ? (args.flags.get('template') as string) : 'blank',
      });
      process.stdout.write(`created "${project.name}" (${project.id}) in ${project.directory}\n`);
      return;
    }
    case 'build': {
      const id = args.positionals[0];
      if (!id) throw new Error('usage: studio build <game-id> [--out <relative-dir>]');
      const workspace = createWorkspace();
      const result = await buildGame({
        workspace,
        projectId: id,
        outSubdirectory: typeof args.flags.get('out') === 'string' ? (args.flags.get('out') as string) : undefined,
        log: (message) => process.stdout.write(`${message}\n`),
      });
      process.stdout.write(`\nexported to ${result.outDir}\n`);
      return;
    }
    case 'validate': {
      const id = args.positionals[0];
      if (!id) throw new Error('usage: studio validate <game-id>');
      const workspace = createWorkspace();
      const result = await workspace.validateProject(id);
      if (result.ok) {
        process.stdout.write(`${id}: valid\n`);
        return;
      }
      for (const issue of result.issues) {
        process.stdout.write(`${issue.severity.toUpperCase()} ${issue.path}: ${issue.message} (${issue.code})\n`);
      }
      process.exitCode = 1;
      return;
    }
    case 'help':
    default:
      process.stdout.write(
        [
          'Coilbox workspace service',
          '',
          'Usage: studio <command> [options]',
          '',
          'Commands:',
          '  dev                 start the workspace api and the editor dev server',
          '  api                 start the workspace api only',
          '  list                list projects in the workspace',
          '  create <id>         create a project from a template (--template, --name)',
          '  validate <id>       validate a project on disk',
          '  build <id>          export a standalone playable web build',
          '',
          `Workspace: ${defaultWorkspaceRoot()} (override with --workspace or COILBOX_WORKSPACE)`,
          `Templates: ${defaultTemplatesRoot()} (override with COILBOX_TEMPLATES)`,
          '',
        ].join('\n'),
      );
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun || process.env.COILBOX_CLI_FORCE === '1') {
  await main();
}
