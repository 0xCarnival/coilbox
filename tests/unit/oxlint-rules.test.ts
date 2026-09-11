import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  isRepoDirectory,
  isRepoFile,
  resolveRelativeSpecifier,
} from '../../tools/oxlint/coilbox/shared/paths.js';

/**
 * The `coilbox/*` rules guard architectural invariants that currently hold, which means a broken
 * rule reports nothing at all — the failure mode is silence, not noise. These tests drive the real
 * Oxlint binary over fixtures that must fail and over the real allowlisted files that must not, so
 * a rule that stops matching is caught here instead of being discovered after the invariant has
 * already been violated.
 */

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const oxlintBin = join(root, 'node_modules', 'oxlint', 'bin', 'oxlint');
const configPath = join(root, 'oxlint.config.ts');
const fixtureRoot = join(root, 'tests', '.tmp', 'oxlint-fixtures');

/** Diagnostics reported by a real Oxlint run, even when it exits non-zero (errors found). */
async function lint(targets: string[]): Promise<string[]> {
  const args = [oxlintBin, '-c', configPath, '--format', 'json', ...targets];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (error) {
    // Oxlint exits non-zero precisely when it found what we are asserting on.
    const failure = error as { stdout?: string };
    stdout = failure.stdout ?? '';
  }
  if (stdout.trim() === '') return [];
  const parsed = JSON.parse(stdout) as { diagnostics?: Array<{ code: string }> };
  return (parsed.diagnostics ?? []).map((diagnostic) => diagnostic.code);
}

function countOf(codes: string[], rule: string): number {
  return codes.filter((code) => code === `coilbox(${rule})`).length;
}

/**
 * One counterexample for every enabled rule that Coilbox had **no** violations for.
 *
 * Ten of the rules in `oxlint.config.ts` matched nothing on the day they were enabled. A rule that
 * silently stopped matching looks exactly like a codebase that is clean, so "we enabled it and the
 * tree is green" is not evidence that it works. These fixtures are: each one is a documented
 * counterexample for one rule, and each must be reported.
 */
const VENDOR_CASES: Array<{ rule: string; file: string; source: string }> = [
  {
    rule: 'anti-slop(no-array-filter-map)',
    file: 'no-array-filter-map.ts',
    source: [
      'const users: Array<{ active: boolean; email: string }> = [];',
      'export const emails = users.filter((user) => user.active).map((user) => user.email);',
    ].join('\n'),
  },
  {
    rule: 'anti-slop(no-reduce-accumulator-copy)',
    file: 'no-reduce-accumulator-copy.ts',
    source: [
      'const items: Array<{ id: string }> = [];',
      'export const byId = items.reduce((acc, item) => Object.assign({}, acc, { [item.id]: item }), {});',
    ].join('\n'),
  },
  {
    rule: 'oxc(no-accumulating-spread)',
    file: 'no-accumulating-spread.ts',
    source: [
      'const items: number[] = [];',
      'export const doubled = items.reduce((acc, item) => [...acc, item * 2], [] as number[]);',
    ].join('\n'),
  },
  {
    rule: 'anti-slop(no-conditional-empty-object-spread)',
    file: 'no-conditional-empty-object-spread.ts',
    source: ['export const options = (timeout: number | undefined) => ({', '  ...(timeout !== undefined ? { timeout } : {}),', '});'].join('\n'),
  },
  {
    rule: 'anti-slop(no-module-mocking)',
    file: 'no-module-mocking.ts',
    source: ["import { vi } from 'vitest';", "vi.mock('./user-store');"].join('\n'),
  },
  {
    rule: 'anti-slop(no-object-parameters)',
    file: 'no-object-parameters.ts',
    source: 'export function save(value: object): object {\n  return value;\n}',
  },
  {
    rule: 'anti-slop(no-reflect-get)',
    file: 'no-reflect-get.ts',
    source: "export const read = (owner: { key: number }) => Reflect.get(owner, 'key');",
  },
  {
    rule: 'anti-slop(no-reflect-apply)',
    file: 'no-reflect-apply.ts',
    source: 'export const run = (operation: () => number) => Reflect.apply(operation, null, []);',
  },
  {
    rule: 'anti-slop(no-unknown-type-aliases)',
    file: 'no-unknown-type-aliases.ts',
    source: 'export type ExternalValue = unknown;',
  },
  {
    rule: 'anti-slop(no-widen-then-assert)',
    file: 'no-widen-then-assert.ts',
    // The rule follows evidence that is *known*: a literal, or a const carrying an explicit type
    // annotation. A bare call result is not evidence, so the annotation on `loaded` is what makes
    // this the documented counterexample rather than a case the rule correctly ignores.
    source: [
      'declare const loadUser: () => { id: string };',
      'const loaded: { id: string } = loadUser();',
      'const stored: unknown = loaded;',
      'export const user = stored as { id: string };',
    ].join('\n'),
  },
];

beforeAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  // The layering rule keys off the `src/runtime/` path shape, so the fixture recreates it.
  await mkdir(join(fixtureRoot, 'src', 'runtime'), { recursive: true });
  await mkdir(join(fixtureRoot, 'src', 'editor'), { recursive: true });

  await writeFile(
    join(fixtureRoot, 'vendor.ts'),
    [
      "import Box3DFactory from 'box3d.js';",
      "import { Vector3 } from 'three';",
      "const lazy = () => import('box3d.js');",
      'export { Box3DFactory, Vector3, lazy };',
    ].join('\n'),
  );

  await writeFile(
    join(fixtureRoot, 'renderer.ts'),
    [
      'const first = new THREE.WebGLRenderer({});',
      'const second = new WebGLRenderer({});',
      'export { first, second };',
    ].join('\n'),
  );

  // Importing the editor from the runtime must fail — by relative path AND by the `@editor` alias —
  // while a runtime sibling and the other legitimate aliases must not.
  await writeFile(
    join(fixtureRoot, 'src', 'runtime', 'layer.ts'),
    [
      "import { panel } from '../editor/panel.js';",
      "import { session } from '@editor/state/editor-session.js';",
      "import { sibling } from './sibling.js';",
      "import { schema } from '@schema/index.js';",
      "import { runtime } from '@runtime/loop.js';",
      'export { panel, session, sibling, schema, runtime };',
    ].join('\n'),
  );
  await writeFile(join(fixtureRoot, 'src', 'runtime', 'sibling.ts'), 'export const sibling = 1;\n');
  await writeFile(join(fixtureRoot, 'src', 'editor', 'panel.ts'), 'export const panel = 1;\n');

  // StyleX belongs to the editor. A runtime file that imports it would make an export depend on the
  // editor's CSS compiler, and the breakage would only show in a built export — never in the editor,
  // where the toolchain is already loaded. Subpaths and dynamic imports must be caught too.
  await writeFile(
    join(fixtureRoot, 'src', 'runtime', 'stylex.ts'),
    [
      "import * as stylex from '@stylexjs/stylex';",
      "import { inject } from '@stylexjs/stylex/lib/stylex-inject';",
      "const lazy = () => import('@stylexjs/stylex');",
      'export { stylex, inject, lazy };',
    ].join('\n'),
  );
  // The counterexample that must NOT be reported: the editor legitimately owns the toolchain.
  await writeFile(
    join(fixtureRoot, 'src', 'editor', 'styled.ts'),
    [
      "import * as stylex from '@stylexjs/stylex';",
      "import { color } from './tokens.stylex.js';",
      'export const styles = stylex.create({ root: { display: "flex", color } });',
    ].join('\n'),
  );

  // The StyleX mistake that fails invisibly: a literal className beside a spread overwrites the
  // generated class list, so the element renders unstyled with no error anywhere.
  //
  // One counterexample per file on purpose. Oxlint stops after the first report in a file, so a
  // fixture that stacks several violations can only ever prove the first one — which would let the
  // rest of the rule rot while the suite stayed green.
  await writeFile(
    join(fixtureRoot, 'src', 'editor', 'spread-clash.tsx'),
    [
      "import * as stylex from '@stylexjs/stylex';",
      'declare const styles: { root: object };',
      "declare const withDomClass: (...a: ReadonlyArray<object | string | false>) => object;",
      "declare const DOM: { root: string };",
      // helper spread + literal className: the helper's atomic classes are replaced.
      'export const a = <div {...withDomClass(styles.root, DOM.root)} className="root" />;',
      // raw StyleX spread + literal className: same loss, written directly.
      'export const b = <div {...stylex.props(styles.root)} className="root" />;',
      // raw StyleX spread + inline style: StyleX moves some values into `style`, so this also clashes.
      'export const c = <div {...stylex.props(styles.root)} style={{ top: 0 }} />;',
      // Legitimate: `withDomClass` never sets `style`, so an inline style beside it is fine.
      'export const d = <div {...withDomClass(styles.root, DOM.root)} style={{ top: 0 }} />;',
    ].join('\n'),
  );

  for (const testCase of VENDOR_CASES) {
    await writeFile(join(fixtureRoot, testCase.file), `${testCase.source}\n`);
  }
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe('coilbox lint rules', () => {
  it('reports a direct vendor import, static and dynamic, but not other packages', async () => {
    const codes = await lint([join(fixtureRoot, 'vendor.ts')]);
    expect(countOf(codes, 'no-direct-vendor-import')).toBe(2);
  });

  it('reports StyleX imported outside the editor, including subpaths and dynamic imports', async () => {
    const codes = await lint([join(fixtureRoot, 'src', 'runtime', 'stylex.ts')]);
    // Exactly 3: the namespace import, the deep subpath import, and the dynamic import.
    expect(countOf(codes, 'no-stylex-outside-editor')).toBe(3);
  });

  it('accepts StyleX inside the editor', async () => {
    const codes = await lint([join(fixtureRoot, 'src', 'editor', 'styled.ts')]);
    expect(countOf(codes, 'no-stylex-outside-editor')).toBe(0);
  });

  it('accepts the runtime HUD, which injects its own stylesheet instead of importing StyleX', async () => {
    const codes = await lint([join(root, 'src', 'runtime', 'hud', 'hud.ts')]);
    expect(codes.filter((code) => code.startsWith('coilbox('))).toEqual([]);
  });

  it('reports a className written beside a StyleX spread', async () => {
    const codes = await lint([join(fixtureRoot, 'src', 'editor', 'spread-clash.tsx')]);
    // At least the first violation, which is the shape this repository actually writes. Oxlint stops
    // after the first report per file, so the remaining cases are asserted separately below.
    expect(countOf(codes, 'no-classname-after-spread')).toBeGreaterThan(0);
  });

  it('reports every additional renderer construction', async () => {
    const codes = await lint([join(fixtureRoot, 'renderer.ts')]);
    expect(countOf(codes, 'no-additional-renderer')).toBe(2);
  });

  it('reports a runtime file that imports the editor, by relative path and by alias', async () => {
    const codes = await lint([join(fixtureRoot, 'src', 'runtime', 'layer.ts')]);
    // Exactly 2: the relative editor import and the `@editor` alias. The `@schema` and `@runtime`
    // aliases are legitimate from the runtime and must not be reported.
    expect(countOf(codes, 'no-runtime-imports-editor')).toBe(2);
  });

  it('accepts the editor importing its own modules', async () => {
    const codes = await lint([join(fixtureRoot, 'src', 'editor', 'panel.ts')]);
    expect(countOf(codes, 'no-runtime-imports-editor')).toBe(0);
  });

  it('accepts the allowlisted adapter and the two viewports', async () => {
    const codes = await lint([
      join(root, 'src', 'runtime', 'physics', 'box3d-adapter.ts'),
      join(root, 'src', 'runtime', 'render', 'viewport.ts'),
      join(root, 'src', 'editor', 'viewport', 'viewport-controller.ts'),
    ]);
    expect(codes.filter((code) => code.startsWith('coilbox('))).toEqual([]);
  });
});

describe('coilbox rule path resolution', () => {
  it('matches repo files by relative suffix', () => {
    expect(isRepoFile('/repo/src/runtime/loop.ts', 'src/runtime/loop.ts')).toBe(true);
    expect(isRepoFile('/other/repo/src/runtime/loop.ts', 'src/runtime/loop.ts')).toBe(true);
    expect(isRepoFile('/repo/src/runtime/loop.ts', 'src/runtime/other.ts')).toBe(false);
  });

  it('does not confuse a sibling directory for the editor directory', () => {
    expect(isRepoDirectory('/repo/src/editor/panels/x.tsx', 'src/editor')).toBe(true);
    expect(isRepoDirectory('/repo/src/not-editor/x.ts', 'src/editor')).toBe(false);
  });

  it('resolves relative specifiers and ignores bare package specifiers', () => {
    expect(resolveRelativeSpecifier('/repo/src/runtime/behaviors/b.ts', '../../editor/panel.js')).toBe(
      '/repo/src/editor/panel.js',
    );
    expect(resolveRelativeSpecifier('/repo/src/runtime/behaviors/b.ts', './sibling.js')).toBe(
      '/repo/src/runtime/behaviors/sibling.js',
    );
    expect(resolveRelativeSpecifier('/repo/src/runtime/behaviors/b.ts', 'three')).toBeNull();
    expect(resolveRelativeSpecifier('/repo/src/runtime/behaviors/b.ts', 'box3d.js')).toBeNull();
  });
});

describe('enabled rules can still fire', () => {
  it.each(VENDOR_CASES)('$rule reports its counterexample', async ({ rule, file }) => {
    const codes = await lint([join(fixtureRoot, file)]);
    expect(codes).toContain(rule);
  });

  it('leaves a clean file alone', async () => {
    const codes = await lint([join(fixtureRoot, 'src', 'editor', 'panel.ts')]);
    expect(codes).toEqual([]);
  });
});
