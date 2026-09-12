import { Boxes, FolderTree, ListTree, ScrollText } from 'lucide-react';

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
