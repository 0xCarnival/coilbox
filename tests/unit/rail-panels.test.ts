import { describe, expect, it } from 'vitest';
import { declaredPanels, railPanelsFor } from '../../src/editor/ui/rail-registry.js';

/**
 * The rail's panel declaration.
 *
 * Both functions take unread JSON — a project's `scripts/registry.json` is a file people and tools
 * edit — so the cases that matter are the malformed ones. A declaration that cannot be satisfied has
 * to degrade to something usable rather than to an editor with no way back.
 */

describe('declaredPanels', () => {
  it('reads ids, with and without a label', () => {
    expect(declaredPanels([{ id: 'objects' }, { id: 'assets', label: 'Files' }])).toEqual([
      { id: 'objects' },
      { id: 'assets', label: 'Files' },
    ]);
  });

  /** No declaration is not the same as an empty one: the rail shows everything unless asked not to. */
  it('returns null when the project declares nothing', () => {
    expect(declaredPanels(undefined)).toBeNull();
    expect(declaredPanels(null)).toBeNull();
    expect(declaredPanels('nonsense')).toBeNull();
    expect(declaredPanels({ id: 'objects' })).toBeNull();
  });

  it('skips entries that are not objects, or carry no usable id', () => {
    expect(declaredPanels([null, 42, 'objects', {}, { id: '' }, { id: 7 }, { id: 'console' }])).toEqual([
      { id: 'console' },
    ]);
  });

  it('ignores a label that is not a string rather than dropping the panel', () => {
    expect(declaredPanels([{ id: 'assets', label: 7 }])).toEqual([{ id: 'assets' }]);
  });
});

describe('railPanelsFor', () => {
  it('shows every built-in when the project declares none', () => {
    const all = railPanelsFor(null).map((panel) => panel.id);
    expect(all).toEqual(['objects', 'assets', 'scenes', 'console']);
  });

  it('shows exactly what was declared, in the declared order', () => {
    const chosen = railPanelsFor([{ id: 'console' }, { id: 'objects' }]).map((panel) => panel.id);
    expect(chosen).toEqual(['console', 'objects']);
  });

  it('applies a declared label over the built-in one', () => {
    const [first] = railPanelsFor([{ id: 'assets', label: 'Files' }]);
    expect(first?.label).toBe('Files');
  });

  /**
   * A project naming only panels this build does not have would otherwise get an empty rail — no
   * button, no way to open anything. Falling through to the full set keeps the editor usable, which
   * matters more than honouring a declaration that cannot be satisfied.
   */
  it('falls through to every panel when no declared id exists in this build', () => {
    const fallback = railPanelsFor([{ id: 'not-a-panel' }]).map((panel) => panel.id);
    expect(fallback).toEqual(['objects', 'assets', 'scenes', 'console']);
  });

  it('drops unknown ids but keeps the known ones around them', () => {
    const mixed = railPanelsFor([{ id: 'console' }, { id: 'not-a-panel' }]).map((panel) => panel.id);
    expect(mixed).toEqual(['console']);
  });
});