import type { AssetId } from './primitives.js';
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
