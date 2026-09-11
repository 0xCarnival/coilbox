import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The DOM contract is the seam that lets `stylex.create` own the pixels while the browser gates keep
 * stable selectors. It only works if the two sides stay in step, and the dangerous direction of
 * drift is one-way:
 *
 * A gate selector that no longer exists does not fail at build time, at typecheck, or at lint. It
 * fails minutes into a browser run as a Playwright locator timeout, which reads like a flaky test
 * rather than a missing class — exactly the kind of failure this repository's gates exist to avoid.
 *
 * So these tests read the real source of both sides and check that every class a gate can select is
 * a class the editor actually renders.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const contractPath = join(root, 'src', 'editor', 'dom-contract.ts');
const panelsDir = join(root, 'src', 'editor', 'panels');

/** The gate files. `verify-stage*.ts` are the per-stage browser gates from `AGENTS.md`. */
async function gateFileNames(): Promise<string[]> {
  const entries = await readdir(join(root, 'tools'));
  return entries.filter((entry) => /^verify-stage\d+\.ts$/u.test(entry));
}

/**
 * Class names any gate could select.
 *
 * Scans only the strings that are *arguments to DOM lookups*, not the whole file: matching every
 * dotted token in the source would drag in `page.click`, `1.5`, and `hud.ts`, and the resulting noise
 * would make the check useless.
 */
async function gateClassNames(): Promise<string[]> {
  const found = new Set<string>();
  const lookupFns = 'querySelector|querySelectorAll|locator|waitForSelector|waitForFunction|click|fill|setInputFiles';
  const callPattern = new RegExp(`(?:${lookupFns})\\(\\s*'([^']*)'`, 'gu');
  const templatePattern = new RegExp(`(?:${lookupFns})\\(\\s*\`([^\`]*)\``, 'gu');

  for (const name of await gateFileNames()) {
    const source = await readFile(join(root, 'tools', name), 'utf8');
    const selectorStrings: string[] = [];
    for (const match of source.matchAll(callPattern)) if (match[1]) selectorStrings.push(match[1]);
    // Template selectors are interpolated, so only their static parts are meaningful.
    for (const match of source.matchAll(templatePattern)) if (match[1]) selectorStrings.push(match[1]);

    for (const selector of selectorStrings) {
      // `.name`, or the chained form `.menu button`. Anchored to the start of a compound selector so
      // a property path like `element.style.color` cannot masquerade as a class.
      for (const match of selector.matchAll(/(?:^|[\s>,+~])\.(-?[_a-zA-Z][\w-]*)/gu)) {
        const className = match[1];
        if (className !== undefined) found.add(className);
      }
    }
  }
  return [...found].sort();
}

/** Class name values declared in the `DOM` and `DOM_STATE` contract objects. */
async function contractValues(): Promise<string[]> {
  const source = await readFile(contractPath, 'utf8');
  const values: string[] = [];
  for (const match of source.matchAll(/^\s{2}[a-zA-Z]+: '([^']+)',$/gmu)) {
    const value = match[1];
    if (value !== undefined) values.push(value);
  }
  return values;
}

/**
 * Class names the editor can render.
 *
 * Two sources, because the gates drive both halves of the product:
 * - the editor's panels, through the `DOM` contract and inline `className` text;
 * - the runtime HUD, which builds its own elements (`coilbox-hud`, `hud-element`, `hud-overlay`) from
 *   `hud.ts` and is what stage 5 asserts against inside an exported game.
 */
async function renderedClassNames(): Promise<Set<string>> {
  const names = new Set(await contractValues());
  const entries = await readdir(panelsDir);
  for (const entry of entries) {
    if (!entry.endsWith('.tsx')) continue;
    const source = await readFile(join(panelsDir, entry), 'utf8');
    for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/gu)) {
      const text = `${match[1] ?? ''} ${match[2] ?? ''}`;
      for (const word of text.split(/[^\w-]+/u)) {
        if (word.length > 0) names.add(word);
      }
    }
  }

  // The HUD builds its elements in code (`created.className = 'coilbox-hud'`) and interpolates the
  // modifier names, so its class list is not one literal to grep. Its injected stylesheet is: every
  // class it can render appears there as a selector, which is also what has to be true for the HUD to
  // look like anything at all.
  const hud = await readFile(join(root, 'src', 'runtime', 'hud', 'hud.ts'), 'utf8');
  for (const match of hud.matchAll(/(?:^|[\s>,+~])\.(-?[_a-zA-Z][\w-]*)/gmu)) {
    const className = match[1];
    if (className !== undefined) names.add(className);
  }
  return names;
}

describe('editor DOM contract', () => {
  it('covers every class the browser gates select', async () => {
    const rendered = await renderedClassNames();
    const missing = (await gateClassNames()).filter((className) => !rendered.has(className));
    expect(
      missing,
      `gate selectors with no matching class in src/editor/panels: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('declares the structural hooks the gates depend on', async () => {
    const values = await contractValues();
    expect(values.length).toBeGreaterThan(20);
    for (const required of [
      'studio',
      'home',
      'card',
      'save-indicator',
      'statusbar',
      'asset-table',
      'toolbar-group',
      'snap-toggle',
      'conflict',
      'tree-row',
      'tree-name',
      'inspector',
      'inspector-title',
      'name-field',
      'section',
      'section-title',
      'field',
      'field-label',
      'vector-field',
      'add-component',
      'add-menu',
      'asset-toolbar',
      'viewport-badge',
      'hud-host',
    ]) {
      expect(values, `contract is missing the '${required}' hook`).toContain(required);
    }
  });

  it('applies every structural hook through withDomClass rather than inline', async () => {
    // A hook spelled inline as `className="tree-row"` would still render, but it would put the value
    // in two places and make the contract a lie about where hook names live.
    const entries = await readdir(panelsDir);
    const sources: string[] = [];
    for (const entry of entries) {
      if (entry.endsWith('.tsx')) sources.push(await readFile(join(panelsDir, entry), 'utf8'));
    }
    const joined = sources.join('\n');

    const spelledInline = (await contractValues()).filter((hook) =>
      new RegExp(`className=(?:"[^"]*\\b${hook}\\b|\\{\`[^\`]*\\b${hook}\\b)`, 'u').test(joined),
    );
    expect(
      spelledInline,
      `hook written inline instead of through withDomClass: ${spelledInline.join(', ')}`,
    ).toEqual([]);
  });
});
