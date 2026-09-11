import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startApiServer, type ApiServerHandle } from './api.js';
import { Workspace } from './workspace.js';
import { buildGame } from './build.js';
import { ProjectManager } from './management.js';
import { testGame } from './test-runner.js';
import { writeFile } from 'node:fs/promises';

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
  /** Every project command accepts --workspace, so an agent can work in another folder. */
  const workspaceFor = (): Workspace =>
    createWorkspace({
      root: typeof args.flags.get('workspace') === 'string' ? (args.flags.get('workspace') as string) : undefined,
      templatesRoot: typeof args.flags.get('templates') === 'string' ? (args.flags.get('templates') as string) : undefined,
    });
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
      const workspace = workspaceFor();
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
      const workspace = workspaceFor();
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
      const workspace = workspaceFor();
      const result = await buildGame({
        workspace,
        projectId: id,
        outSubdirectory: typeof args.flags.get('out') === 'string' ? (args.flags.get('out') as string) : undefined,
        log: (message) => process.stdout.write(`${message}\n`),
      });
      process.stdout.write(`\nexported to ${result.outDir}\n`);
      return;
    }
    case 'test': {
      const id = args.positionals[0];
      if (!id) throw new Error('usage: studio test <game-id> [--seconds 3] [--keep-build]');
      const workspace = workspaceFor();
      process.stdout.write(`testing "${id}"\n`);
      const result = await testGame({
        workspace,
        projectId: id,
        seconds: typeof args.flags.get('seconds') === 'string' ? Number(args.flags.get('seconds')) : undefined,
        keepBuild: args.flags.has('keep-build'),
        log: (message) => process.stdout.write(`${message}\n`),
      });
      const failed = result.checks.filter((check) => !check.passed);
      process.stdout.write(
        `\n${result.checks.length - failed.length}/${result.checks.length} checks passed in ${(result.durationMs / 1000).toFixed(1)}s\n`,
      );
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case 'duplicate': {
      const id = args.positionals[0];
      if (!id) throw new Error('usage: studio duplicate <game-id> --as <new-id> [--name "New Name"]');
      const newId = typeof args.flags.get('as') === 'string' ? (args.flags.get('as') as string) : `${id}-copy`;
      const result = await new ProjectManager(workspaceFor()).duplicate(id, {
        newId,
        newName: typeof args.flags.get('name') === 'string' ? (args.flags.get('name') as string) : undefined,
      });
      process.stdout.write(`${result.detail}\n`);
      return;
    }
    case 'archive': {
      const id = args.positionals[0];
      if (!id) throw new Error('usage: studio archive <game-id> [--reason "why"]');
      const result = await new ProjectManager(workspaceFor()).archive(id, {
        reason: typeof args.flags.get('reason') === 'string' ? (args.flags.get('reason') as string) : undefined,
      });
      process.stdout.write(`${result.detail}\n`);
      return;
    }
    case 'archives': {
      const archives = await new ProjectManager(workspaceFor()).listArchived();
      if (archives.length === 0) {
        process.stdout.write('no archived projects\n');
        return;
      }
      for (const entry of archives) {
        process.stdout.write(`${entry.directory}\t${entry.projectId}\t${entry.archivedAt}\t${entry.reason}\n`);
      }
      return;
    }
    case 'restore': {
      const directory = args.positionals[0];
      if (!directory) throw new Error('usage: studio restore <archive-name>');
      const result = await new ProjectManager(workspaceFor()).restore(directory);
      process.stdout.write(`${result.detail}\n`);
      return;
    }
    case 'export-source': {
      const id = args.positionals[0];
      if (!id) throw new Error('usage: studio export-source <game-id> [--out file.tar.gz]');
      const manager = new ProjectManager(workspaceFor());
      const exported = await manager.exportSource(id);
      const out = typeof args.flags.get('out') === 'string' ? (args.flags.get('out') as string) : `${id}-source.tar.gz`;
      await writeFile(out, exported.bytes);
      process.stdout.write(`${exported.detail} -> ${out}\n`);
      return;
    }
    case 'import': {
      const file = args.positionals[0];
      if (!file) throw new Error('usage: studio import <archive.tar.gz> [--as <game-id>] [--name "Name"]');
      const { readFile } = await import('node:fs/promises');
      const bytes = new Uint8Array(await readFile(file));
      const result = await new ProjectManager(workspaceFor()).importSource(bytes, {
        projectId: typeof args.flags.get('as') === 'string' ? (args.flags.get('as') as string) : undefined,
        name: typeof args.flags.get('name') === 'string' ? (args.flags.get('name') as string) : undefined,
      });
      process.stdout.write(`${result.detail}\n`);
      for (const warning of result.warnings) process.stdout.write(`warning: ${warning}\n`);
      return;
    }
    case 'validate': {
      const id = args.positionals[0];
      if (!id) throw new Error('usage: studio validate <game-id>');
      const workspace = workspaceFor();
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
          '  test <id>           validate, export, and play the game headlessly',
          '  duplicate <id>      copy a project (--as <new-id>, --name "New Name")',
          '  archive <id>        move a project into the recoverable archive',
          '  archives            list archived projects',
          '  restore <name>      restore an archived project',
          '  export-source <id>  write a source archive (--out file.tar.gz)',
          '  import <file>       import a source archive (--as <id>, --name "Name")',
          '',
          'Every project command accepts --workspace <dir> (or COILBOX_WORKSPACE).',
          `Workspace: ${defaultWorkspaceRoot()}`,
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
