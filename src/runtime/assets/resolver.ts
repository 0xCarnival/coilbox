import type { AssetEntry, AssetId, AssetManifest } from '@schema/index.js';

/**
 * Asset resolution for a running world.
 *
 * Assets keep a stable id and an immutable original file (plan §9): scenes and
 * behaviors reference `assetId`, never a path, so moving or renaming a file does not
 * break every scene that used it.
 */
export interface AssetResolver {
  /** Absolute or base-relative URL for an asset id, or null when the id is unknown. */
  resolveUrl(assetId: AssetId): string | null;
  /** Manifest entry for an asset id, when the project has a manifest. */
  getEntry(assetId: AssetId): AssetEntry | undefined;
  /** All entries, for validation and export-time reachability checks. */
  list(): AssetEntry[];
}

/** Resolve assets against a base URL (used by the player and by exported games). */
export class UrlAssetResolver implements AssetResolver {
  private readonly byId = new Map<string, AssetEntry>();
  private readonly urls = new Map<string, string>();

  constructor(manifest: AssetManifest, baseUrl: string) {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    for (const entry of manifest.assets) {
      this.byId.set(entry.id, entry);
      this.urls.set(entry.id, new URL(entry.path, base.endsWith('/') ? base : `${base}/`).href);
    }
  }

  resolveUrl(assetId: string): string | null {
    return this.urls.get(assetId) ?? null;
  }

  getEntry(assetId: string): AssetEntry | undefined {
    return this.byId.get(assetId);
  }

  list(): AssetEntry[] {
    return [...this.byId.values()];
  }
}

/** Resolver for a project with no assets yet; keeps runtime code branch-free. */
export class EmptyAssetResolver implements AssetResolver {
  resolveUrl(): string | null {
    return null;
  }

  getEntry(): undefined {
    return undefined;
  }

  list(): AssetEntry[] {
    return [];
  }
}
