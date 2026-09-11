import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Runs every stage gate in order and reports one summary.
 *
 * Each gate is independent, bounded, and writes its own evidence, so this exists to answer one
 * question — "does the whole plan still hold?" — with a single exit status.
 *
 * Lint runs first because it is fast and catches architectural drift (the `coilbox/*` rules) before
 * the browser gates spend minutes building and launching Chromium.
 *
 * Usage: pnpm verify [--from stage3] [--skip-build] [--skip-lint]
 */

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const fromIndex = args.indexOf('--from');
const from = fromIndex >= 0 ? Number(String(args[fromIndex + 1] ?? '').replace('stage', '')) : 0;
const extra = args.includes('--skip-build') ? ['--skip-build'] : [];

const stages = [0, 1, 2, 3, 4, 5].filter((stage) => stage >= (Number.isFinite(from) ? from : 0));
const results: Array<{ label: string; ok: boolean; summary: string }> = [];

/**
 * The gate's own tally is the last line that is exactly "N/M checks passed". A check *detail* may
 * quote a smaller tally (a bounded project test running inside the gate), and reporting that as
 * the gate result would understate it.
 */
function tally(output: string): string {
  const matches = [...output.matchAll(/^(\d+)\/(\d+) checks passed$/gm)];
  const last = matches[matches.length - 1];
  return last ? `${last[1]}/${last[2]} checks passed` : 'passed';
}

if (!args.includes('--skip-lint')) {
  process.stdout.write(`\n${'='.repeat(72)}\nLINT\n${'='.repeat(72)}\n`);
  try {
    const { stdout, stderr } = await execFileAsync('pnpm', ['run', 'lint'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    process.stdout.write(`${`${stdout}${stderr}`.split('\n').slice(-6).join('\n')}\n`);
    results.push({ label: 'lint', ok: true, summary: 'clean' });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    process.stdout.write(`${output.split('\n').slice(-40).join('\n')}\n`);
    results.push({ label: 'lint', ok: false, summary: 'violations found' });
  }
}

for (const stage of stages) {
  process.stdout.write(`\n${'='.repeat(72)}\nSTAGE ${stage}\n${'='.repeat(72)}\n`);
  try {
    const { stdout, stderr } = await execFileAsync('pnpm', ['exec', 'tsx', `tools/verify-stage${stage}.ts`, ...extra], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const output = `${stdout}${stderr}`;
    process.stdout.write(`${output.split('\n').slice(-6).join('\n')}\n`);
    results.push({ label: `stage ${stage}`, ok: true, summary: tally(output) });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    process.stdout.write(`${output.split('\n').slice(-25).join('\n')}\n`);
    results.push({ label: `stage ${stage}`, ok: false, summary: tally(output) });
  }
}

process.stdout.write(`\n${'='.repeat(72)}\nSUMMARY\n${'='.repeat(72)}\n`);
for (const result of results) {
  process.stdout.write(`${result.label}: ${result.ok ? 'PASS' : 'FAIL'} (${result.summary})\n`);
}
const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} gates passed\n`);
if (failed.length > 0) process.exit(1);
