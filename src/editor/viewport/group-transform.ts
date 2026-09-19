import * as THREE from 'three';
import type { EntityId } from '@schema/index.js';
export { selectionRoots } from '../document/selection-roots.js';

/** World matrices after moving a pivot: world' = pivotNow * pivotStart^-1 * startWorld. */
export function applyPivotDelta(
  pivotStart: THREE.Matrix4,
  pivotNow: THREE.Matrix4,
  startWorlds: ReadonlyMap<EntityId, THREE.Matrix4>,
): Map<EntityId, THREE.Matrix4> {
  const delta = new THREE.Matrix4().copy(pivotNow).multiply(new THREE.Matrix4().copy(pivotStart).invert());
  return new Map([...startWorlds].map(([id, startWorld]) => [id, delta.clone().multiply(startWorld)]));
}

export function pointsInRect(
  points: ReadonlyMap<EntityId, { x: number; y: number }>,
  rect: { x: number; y: number; width: number; height: number },
): EntityId[] {
  const left = Math.min(rect.x, rect.x + rect.width);
  const right = Math.max(rect.x, rect.x + rect.width);
  const top = Math.min(rect.y, rect.y + rect.height);
  const bottom = Math.max(rect.y, rect.y + rect.height);
  const result: EntityId[] = [];
  for (const [id, point] of points) {
    if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) result.push(id);
  }
  return result;
}
