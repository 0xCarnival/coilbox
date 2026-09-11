import type { AssetEntry, AssetId } from '@schema/index.js';
import type { AssetResolver } from '@runtime/assets/resolver.js';

/**
 * Editor-side asset resolution.
 *
 * The editor does not have the project's files on disk — the workspace service does — so
 * asset URLs point at the service's content endpoint. The runtime, the editor viewport, and
 * the player all receive an `AssetResolver`; only the URL behind it differs.
 */
export class ApiAssetResolver implements AssetResolver {
  private readonly entries = new Map<string, AssetEntry>();

  constructor(
    private projectId: string,
    assets: AssetEntry[] = [],
  ) {
    this.setEntries(assets);
  }

  setProject(projectId: string, assets: AssetEntry[]): void {
    this.projectId = projectId;
    this.setEntries(assets);
  }

  setEntries(assets: AssetEntry[]): void {
    this.entries.clear();
    for (const entry of assets) this.entries.set(entry.id, entry);
  }

  resolveUrl(assetId: AssetId): string | null {
    if (!this.entries.has(assetId)) return null;
    return `/api/projects/${encodeURIComponent(this.projectId)}/assets/${encodeURIComponent(assetId)}/content`;
  }

  getEntry(assetId: AssetId): AssetEntry | undefined {
    return this.entries.get(assetId);
  }

  list(): AssetEntry[] {
    return [...this.entries.values()];
  }
}
