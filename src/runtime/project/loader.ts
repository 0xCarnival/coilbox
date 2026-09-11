import {
  formatIssues,
  parseAssetManifest,
  parseGame,
  parseScene,
  type AssetManifest,
  type GameDocument,
  type JsonValue,
  type SceneDocument,
  type ValidationIssue,
} from '@schema/index.js';
import { EmptyAssetResolver, UrlAssetResolver, type AssetResolver } from '../assets/resolver.js';
import type { BehaviorRegistry } from '../behaviors/registry.js';

/**
 * Project loading from a static base URL.
 *
 * Used by the standalone player and by exported games, where the project documents are
 * served as plain files next to the build. The editor uses the workspace service for
 * the same documents plus writes; both paths funnel through the same schema validation.
 */

export class ProjectLoadError extends Error {
  readonly issues: ValidationIssue[];
  readonly url: string;

  constructor(url: string, message: string, issues: ValidationIssue[] = []) {
    super(`Failed to load project from ${url}: ${message}`);
    this.name = 'ProjectLoadError';
    this.url = url;
    this.issues = issues;
  }
}

export interface LoadedProject {
  game: GameDocument;
  scene: SceneDocument;
  assets: AssetManifest;
  resolver: AssetResolver;
  /** Base URL the project was loaded from, always ending in `/`. */
  baseUrl: string;
  issues: ValidationIssue[];
}

export interface LoadProjectOptions {
  /** Scene to load; defaults to the project's start scene. */
  sceneId?: string;
  /** Behavior registry used to validate behavior references. */
  registry?: BehaviorRegistry;
  fetchImpl?: typeof fetch;
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<JsonValue> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (cause) {
    throw new ProjectLoadError(url, `network error: ${String(cause)}`);
  }
  if (!response.ok) {
    throw new ProjectLoadError(url, `HTTP ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  try {
    // SAFETY: `JSON.parse` produces exactly the JSON value shapes — objects, arrays, strings,
    // booleans, finite numbers, and null — or throws; it cannot fabricate a live JS value.
    return JSON.parse(text) as JsonValue;
  } catch (cause) {
    throw new ProjectLoadError(url, `invalid JSON: ${String(cause)}`);
  }
}

/**
 * Normalise a project base URL to an absolute, trailing-slash URL.
 *
 * Relative bases ("../my-game/") are resolved against the document base so the player
 * works when it is served from a nested path.
 */
export function normalizeBaseUrl(baseUrl: string, absoluteAgainst?: string): string {
  const fallback =
    absoluteAgainst ??
    (typeof document !== 'undefined' ? document.baseURI : undefined) ??
    (typeof location !== 'undefined' ? location.href : undefined);
  let resolved: URL;
  try {
    resolved = new URL(baseUrl, fallback);
  } catch (cause) {
    throw new ProjectLoadError(baseUrl, `not a usable project URL: ${String(cause)}`);
  }
  const href = resolved.href;
  return href.endsWith('/') ? href : `${href}/`;
}

export async function loadProjectFromUrl(baseUrl: string, options: LoadProjectOptions = {}): Promise<LoadedProject> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = normalizeBaseUrl(baseUrl);

  const gameRaw = await fetchJson(new URL('game.json', base).href, fetchImpl);
  const gameResult = parseGame(gameRaw);
  if (!gameResult.ok || !gameResult.value) {
    throw new ProjectLoadError(new URL('game.json', base).href, 'game.json is not valid', gameResult.issues);
  }
  const game = gameResult.value;

  const sceneEntry =
    options.sceneId === undefined
      ? game.scenes.find((entry) => entry.id === game.startScene)
      : game.scenes.find((entry) => entry.id === options.sceneId);
  if (!sceneEntry) {
    throw new ProjectLoadError(base, `scene "${options.sceneId ?? game.startScene}" is not listed in game.json`);
  }

  const manifestResult = parseAssetManifest(
    await fetchJson(new URL(game.assetManifest, base).href, fetchImpl).catch(() => ({ schemaVersion: 1, assets: [] })),
  );
  const assets = manifestResult.value ?? { schemaVersion: 1, assets: [] };
  const assetIds = new Set(assets.assets.map((asset) => asset.id));

  const sceneUrl = new URL(sceneEntry.path, base).href;
  const sceneRaw = await fetchJson(sceneUrl, fetchImpl);
  const sceneResult = parseScene(sceneRaw, {
    assetIds,
    behaviorIds: options.registry ? new Set(options.registry.list().map((b) => b.id)) : undefined,
    behaviorProperties: options.registry ? options.registry.propertyDescriptors() : undefined,
  });
  if (!sceneResult.value) {
    throw new ProjectLoadError(sceneUrl, 'scene document is not valid', sceneResult.issues);
  }
  if (!sceneResult.ok) {
    throw new ProjectLoadError(sceneUrl, 'scene document failed relationship validation', sceneResult.issues);
  }

  const resolver = assets.assets.length > 0 ? new UrlAssetResolver(assets, base) : new EmptyAssetResolver();
  return {
    game,
    scene: sceneResult.value,
    assets,
    resolver,
    baseUrl: base,
    issues: [...gameResult.issues, ...manifestResult.issues, ...sceneResult.issues],
  };
}

export function describeIssues(issues: ValidationIssue[]): string {
  return formatIssues(issues);
}
