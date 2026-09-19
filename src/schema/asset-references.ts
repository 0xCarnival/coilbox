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
 * The registry decides which keys hold assets, so the caller passes those keys per behavior id;
 * a behavior with no entry has no asset properties.
 */
export function behaviorAssetIdsOf(component: Component, assetProperties: ReadonlyMap<string, ReadonlySet<string>>): AssetId[] {
  if (component.type !== 'behavior') return [];
  const keys = assetProperties.get(component.behaviorId);
  if (!keys) return [];
  const ids: AssetId[] = [];
  for (const key of keys) {
    const value = component.properties[key];
    if (value !== undefined && isAssetId(value)) ids.push(value);
  }
  return ids;
}

/** An `asset` property holds an id or `null` for none; the validator checks the type, this reads it. */
const isAssetId = (value: JsonValue): value is AssetId => typeof value === 'string' && value.length > 0;
