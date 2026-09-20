import type { AssetId, JsonValue } from './primitives.js';
import type { Component } from './components.js';
import type { AssetKind } from './project.js';

export interface AssetReference {
  property: string;
  assetId: AssetId;
  kind: AssetKind;
}

/** Every asset a component points at, with the kind that slot requires. */
export function assetReferencesOf(component: Component): AssetReference[] {
  switch (component.type) {
    case 'model':
      return [{ property: 'assetId', assetId: component.assetId, kind: 'model' }];
    case 'audio':
      return [{ property: 'assetId', assetId: component.assetId, kind: 'audio' }];
    case 'material':
      return (['map', 'normalMap', 'emissiveMap'] as const)
        .flatMap((property) => {
          const assetId = component[property];
          return assetId === null ? [] : [{ property, assetId, kind: 'image' as const }];
        });
    default:
      return [];
  }
}

/**
 * The assets a behavior points at through properties its registry entry declares as `asset`.
 * The registry decides which keys hold assets and what each defaults to, so the caller passes
 * `behaviorId -> (key -> default asset id or null)`; a stored value wins over the default, the way
 * the runtime merges them. A behavior with no entry has no asset properties.
 */
export function behaviorAssetIdsOf(
  component: Component,
  assetProperties: ReadonlyMap<string, ReadonlyMap<string, AssetId | null>>,
): AssetId[] {
  if (component.type !== 'behavior') return [];
  const properties = assetProperties.get(component.behaviorId);
  if (!properties) return [];
  const ids: AssetId[] = [];
  for (const [key, fallback] of properties) {
    const stored = component.properties[key];
    const value = stored === undefined ? fallback : stored;
    if (value !== null && isAssetId(value)) ids.push(value);
  }
  return ids;
}

/** Every asset id a component uses: its fixed slots plus its behavior's `asset` properties. */
export function referencedAssetIdsOf(
  component: Component,
  assetProperties: ReadonlyMap<string, ReadonlyMap<string, AssetId | null>>,
): AssetId[] {
  return [...assetReferencesOf(component).map((reference) => reference.assetId), ...behaviorAssetIdsOf(component, assetProperties)];
}

/**
 * The component with every reference to `from` pointing at `to`, or `null` when it holds none.
 *
 * A behavior property that falls back to a registry default naming `from` is written out
 * explicitly as `to`: the default belongs to the registry, and the rename must not depend on it
 * being rewritten too.
 */
export function renameAssetReferences(
  component: Component,
  from: AssetId,
  to: AssetId,
  assetProperties: ReadonlyMap<string, ReadonlyMap<string, AssetId | null>>,
): Component | null {
  switch (component.type) {
    case 'model':
    case 'audio':
      return component.assetId === from ? { ...component, assetId: to } : null;
    case 'material': {
      const slots = (['map', 'normalMap', 'emissiveMap'] as const).filter((property) => component[property] === from);
      if (slots.length === 0) return null;
      const next = { ...component };
      for (const property of slots) next[property] = to;
      return next;
    }
    case 'behavior': {
      const properties = assetProperties.get(component.behaviorId);
      if (!properties) return null;
      const rewritten: Record<string, JsonValue> = {};
      for (const [key, fallback] of properties) {
        const stored = component.properties[key];
        if ((stored === undefined ? fallback : stored) === from) rewritten[key] = to;
      }
      if (Object.keys(rewritten).length === 0) return null;
      return { ...component, properties: { ...component.properties, ...rewritten } };
    }
    default:
      return null;
  }
}

/** An `asset` property holds an id or `null` for none; the validator checks the type, this reads it. */
const isAssetId = (value: JsonValue): value is AssetId => typeof value === 'string' && value.length > 0;
