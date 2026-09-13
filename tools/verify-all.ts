import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
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

const ALL_STAGES = [0, 1, 2, 3, 4, 5];
const stages = ALL_STAGES.filter((stage) => stage >= (Number.isFinite(from) ? from : 0));
const results: Array<{ label: string; ok: boolean; summary: string; failures: string[] }> = [];

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

/**
 * The titles of the checks that failed, in gate order. A CI log is long enough that the middle of
 * it is not always readable afterwards, so the names are repeated in the summary at the end —
 * "17/18 checks passed" is not something anyone can act on.
 */
function failingChecks(output: string): string[] {
  return [...output.matchAll(/^FAIL\s+(.+)$/gm)].map((match) => match[1]!.trim());
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
    results.push({ label: 'lint', ok: true, summary: 'clean', failures: [] });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    process.stdout.write(`${output.split('\n').slice(-40).join('\n')}\n`);
    results.push({ label: 'lint', ok: false, summary: 'violations found', failures: failingChecks(output) });
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
    results.push({ label: `stage ${stage}`, ok: true, summary: tally(output), failures: failingChecks(output) });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    process.stdout.write(`${output.split('\n').slice(-25).join('\n')}\n`);
    results.push({ label: `stage ${stage}`, ok: false, summary: tally(output), failures: failingChecks(output) });
  }
}

const GATE_TOTAL = 'the gate total';

/**
 * Every check count a document states, and what that count is a count of.
 *
 * A count is written three ways: beside the command in the summary table or README list, in a
 * stage's `**Status:**` line, and as the total on the `pnpm verify` line. All three have been stale
 * at once, so all three are read. Attribution comes from the text itself — the stage number in the
 * command, or the enclosing `## Stage N` heading — rather than from a list here: a hardcoded
 * expectation would drift in exactly the way this exists to catch.
 */
function documentedClaims(text: string): Array<{ what: string; count: string }> {
  const claims: Array<{ what: string; count: string }> = [];
  let section: string | undefined;
  for (const line of text.split('\n')) {
    const heading = /^##\s+Stage\s+(\d)\b/.exec(line);
    if (heading) {
      section = `stage ${heading[1]}`;
      continue;
    }
    // "`pnpm verify:stage3` — 14/14 checks", and "`tools/verify-stage5.ts` passes 23/23 checks".
    const beside = /verify[:-]stage(\d).*?(\d+)\/(\d+) checks/.exec(line);
    if (beside) claims.push({ what: `stage ${beside[1]}`, count: `${beside[2]}/${beside[3]}` });
    // "**Status:** all five demonstrated, 12/12 automated checks passing." — belongs to its section.
    const status = /^\*\*Status:\*\*.*?(\d+)\/(\d+) automated checks/.exec(line);
    if (status && section !== undefined) claims.push({ what: section, count: `${status[1]}/${status[2]}` });
    // "reports 7/7 passing" and "7/7 gates pass".
    const total = /verify\b.*?(\d+)\/(\d+) (?:gates|passing)/.exec(line);
    if (total) claims.push({ what: GATE_TOTAL, count: `${total[1]}/${total[2]}` });
  }
  return claims;
}

/**
 * Do the documents agree with the gates that just ran?
 *
 * `docs/status.md` is what `README.md` points at as the record of what each stage demonstrated, and
 * a stale count there makes every other number in it worth doubting. The counts only exist in the
 * gates' output, which this script already captured, so the comparison is free — it would be a poor
 * trade to re-run eight minutes of gates to check seven integers.
 *
 * A partial run checks the counts it measured and nothing else: `--from 3` neither reports stages
 * 0-2 as missing nor holds their documents to a total they were not run against.
 *
 * Only gates that *passed* are compared, and the total only when all of them did. A gate that fails
 * early — a failed typecheck, a flaky watcher test — reports no tally at all, and reading that as "0
 * of 14" told the reader their documentation was out of date when the actual news was that a gate had
 * failed. The documents describe a passing tree; there is nothing to compare them against until there
 * is one.
 */
function documentationDrift(results: ReadonlyArray<{ label: string; ok: boolean; summary: string }>): string[] {
  /** Only the gates that reported a tally: a failure early enough to skip its checks reports none. */
  const actual = new Map(
    results.flatMap((result) =>
      result.ok ? [[result.label, result.summary.replace(' checks passed', '')] as const] : [],
    ),
  );
  /** The documented total counts lint as well, so it only applies to a complete, wholly passing run. */
  const whole =
    results.every((result) => result.ok) &&
    results.length === stages.length + 1 &&
    stages.length === ALL_STAGES.length;
  const total = `${results.filter((result) => result.ok).length}/${results.length}`;
  const problems: string[] = [];
  for (const file of ['README.md', 'docs/status.md']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const { what, count } of documentedClaims(readFileSync(path, 'utf8'))) {
      if (what === GATE_TOTAL) {
        if (whole && total !== count) problems.push(`${file} documents the gate total as ${count}; this run was ${total}`);
        continue;
      }
      const measured = actual.get(what);
      if (measured === undefined || measured === count) continue;
      problems.push(`${file} documents ${what} as ${count} checks; the gate reported ${measured}`);
    }
  }
  return problems;
}

process.stdout.write(`\n${'='.repeat(72)}\nSUMMARY\n${'='.repeat(72)}\n`);
for (const result of results) {
  process.stdout.write(`${result.label}: ${result.ok ? 'PASS' : 'FAIL'} (${result.summary})\n`);
  for (const title of result.failures) process.stdout.write(`    - ${title}\n`);
}
/**
 * The documented counts are checked here rather than as another gate, because they describe *these*
 * results. A separate gate would have to re-run everything to learn what this already knows.
 */
const drift = documentationDrift(results);
if (drift.length > 0) {
  process.stdout.write(`\nDOCUMENTATION\n`);
  for (const problem of drift) process.stdout.write(`  ${problem}\n`);
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(
  `\n${results.length - failed.length}/${results.length} gates passed${drift.length > 0 ? '; documentation is out of date' : ''}\n`,
);
if (failed.length > 0 || drift.length > 0) process.exit(1);
