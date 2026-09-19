import { Boxes, FolderTree, History, ListTree, ScrollText } from 'lucide-react';
import type { JsonValue } from '@schema/index.js';
import { isJsonObject, isJsonString, jsonField } from '../json-values.js';

/**
 * The left rail's panel registry.
 *
 * The rail's list was a frozen array in the component. It is a registry now, which is the narrow
 * architectural seam the reference's plugin panels actually need: a panel can be contributed rather
 * than the component being edited to add one, and the rail renders whatever has been registered.
 *
 * ## What this is, and what it is not
 *
 * It is a registry, not a plugin sandbox. There is no discovery, no manifest, no capability boundary,
 * and no isolation — a contributor runs in the editor's own realm with the editor's own imports, the
 * same as any other module here. Calling it a plugin system would be claiming a security property
 * this does not have, and the reference's real plugin host is a considerably larger thing than a
 * list.
 *
 * What it buys today is honest: adding a panel is a registration rather than an edit to the rail, and
 * the set can differ between builds without the component knowing. If a real plugin host arrives, this
 * is the interface it would call.
 */

/**
 * A panel as a project declares it in `scripts/registry.json`.
 *
 * The declaration says *which* built-in panel to show and in what order. It cannot introduce a new
 * surface, because a declared panel has nothing to render — a contribution format richer than this
 * would mean third-party code, which is a much larger decision and is written up in
 * `docs/extension-points.md`. What this buys is the thing people actually mean by "plugins" in a
 * single-user tool: a project configures its editor without a change to editor internals.
 */
export interface DeclaredPanel {
  id: string;
  /** Optional replacement for the built-in label. */
  label?: string;
}

export interface RailPanel {
  /** Stable id, used as the active-panel key. */
  id: string;
  /** The tooltip and the accessible name. A rail button has no visible text. */
  label: string;
  /** The glyph. */
  Icon: typeof ListTree;
}

/**
 * The panels this build ships, in rail order.
 *
 * `objects` is the hierarchy column; the rest are tabs in the bottom panel. That split is the shell's
 * knowledge, not the registry's — a contributor registers a panel and the shell decides where it
 * belongs, which is what lets the same list drive both without the registry importing either.
 */
const BUILT_IN: readonly RailPanel[] = [
  { id: 'objects', label: 'Scene objects', Icon: ListTree },
  { id: 'assets', label: 'Assets', Icon: Boxes },
  { id: 'scenes', label: 'Scenes', Icon: FolderTree },
  { id: 'history', label: 'History', Icon: History },
  { id: 'console', label: 'Console', Icon: ScrollText },
];

const contributed = new Map<string, RailPanel>();

/**
 * Add a panel to the rail.
 *
 * Registering an id that already exists replaces it, which makes a contribution a *replacement*
 * point as well as an addition — a build that wants its own console panel can take that slot rather
 * than being refused the name.
 */
export function registerRailPanel(panel: RailPanel): void {
  contributed.set(panel.id, panel);
}

/** The panels to show: the built-ins, with any contributed panel replacing its slot or appending. */
export function railPanels(): readonly RailPanel[] {
  const merged = BUILT_IN.map((panel) => contributed.get(panel.id) ?? panel);
  const extra = [...contributed.values()].filter((panel) => !BUILT_IN.some((built) => built.id === panel.id));
  return [...merged, ...extra];
}

/**
 * The rail, as a project would have it.
 *
 * A project that declares no panels gets everything — the default is unchanged, so an existing
 * project and a new one behave the same until someone asks otherwise. A project that *does* declare
 * them gets exactly those, in the order given.
 *
 * An unknown id is dropped rather than rendered as a button that does nothing. That is the same
 * choice the rest of this editor makes about unrecognised input: a panel that cannot open is worse
 * than a panel that is absent, because the first looks like a bug and the second looks like a
 * decision.
 */
export function railPanelsFor(declared: readonly DeclaredPanel[] | null): readonly RailPanel[] {
  const available = railPanels();
  if (declared === null || declared.length === 0) return available;

  const byId = new Map(available.map((panel) => [panel.id, panel]));
  const chosen: RailPanel[] = [];
  for (const entry of declared) {
    const panel = byId.get(entry.id);
    if (!panel) continue;
    chosen.push(entry.label === undefined ? panel : { ...panel, label: entry.label });
  }
  /**
   * A project that declares only unknown ids would otherwise get an empty rail and no way back to any
   * panel. Falling through to the full set keeps the editor usable, which matters more than honouring
   * a declaration that cannot be satisfied.
   */
  return chosen.length > 0 ? chosen : available;
}

/**
 * Parse a project's `panels` array out of its registry document.
 *
 * Takes `JsonValue` rather than `unknown`, and reads it with the same `isJsonObject` / `jsonField`
 * helpers the rest of the editor uses on unread JSON. A malformed entry is skipped rather than
 * thrown, because a bad `panels` array should not stop a project from opening.
 */
export function declaredPanels(raw: JsonValue | undefined): readonly DeclaredPanel[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DeclaredPanel[] = [];
  for (const entry of raw) {
    if (!isJsonObject(entry)) continue;
    const id = jsonField(entry, 'id');
    if (!isJsonString(id) || id.length === 0) continue;
    const label = jsonField(entry, 'label');
    out.push(isJsonString(label) ? { id, label } : { id });
  }
  return out;
}
