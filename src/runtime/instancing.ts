import * as THREE from 'three';
import type { Entity } from '@schema/index.js';

/**
 * Draw-call batching for repeated primitives.
 *
 * A racetrack is a few shapes drawn a few thousand times: rails, caps, pylons, deck slabs. Each one
 * is its own entity, which is right for authoring and wrong for the GPU — a scene of 2,000 primitives
 * cost 2,000 draw calls for 50,000 triangles. This module folds every set of primitives that share
 * a shape, size and material into one `InstancedMesh`, so the same scenery is a few dozen calls.
 *
 * It is a projection-side optimisation only. The authored entities are untouched; each keeps its own
 * group (so transforms, physics bindings and picking keep working) and its own mesh, which is moved
 * to a layer no camera renders rather than removed. Restoring is the reverse move, so the batches can
 * be rebuilt as often as the caller likes — the editor does it on every sync and selection change.
 */

/** Layer a batched primitive's own mesh lives on: rendered by no camera, still raycast by the editor. */
export const BATCHED_LAYER = 31;

/** Fewer than this many identical primitives are cheaper drawn one by one. */
const MIN_BATCH = 2;

export type BatchableMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

export interface BatchMember {
  key: string;
  mesh: BatchableMesh;
}

/**
 * The batch a primitive entity belongs to, or null when it renders on its own.
 *
 * Two entities share a batch when the game could not tell their meshes apart: same shape and size,
 * same shadow flags, same material component (the textures derive from it). Per-entity texture
 * transforms are inside the material component, so they are part of the key for free.
 */
export function primitiveBatchKey(entity: Entity): string | null {
  const primitive = entity.components.find((component) => component.type === 'primitive');
  if (primitive?.type !== 'primitive') return null;
  const material = entity.components.find((component) => component.type === 'material');
  if (material?.type === 'material' && (material.transparent || !material.visible)) return null;
  return JSON.stringify([primitive, material ?? null]);
}

/**
 * Whether nothing in the game can move or hide this entity once the scene is built.
 *
 * Physics bodies move; behaviors move bodies and toggle their visibility; and a child goes wherever
 * its parent goes, so the whole ancestor chain has to be inert.
 */
export function isStaticInGame(entity: Entity, lookup: (id: string) => Entity | undefined): boolean {
  const seen = new Set<string>();
  for (let current: Entity | undefined = entity; current; current = current.parentId === null ? undefined : lookup(current.parentId)) {
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    for (const component of current.components) {
      if (component.type === 'rigidBody' || component.type === 'behavior' || component.type === 'animation') return false;
    }
  }
  return true;
}

export class PrimitiveBatches {
  private readonly batches: THREE.InstancedMesh[] = [];
  private readonly hidden: BatchableMesh[] = [];

  /** Number of primitives currently drawn through a batch. */
  instanced(): number {
    return this.hidden.length;
  }

  /**
   * Replace every batch with ones built from `members`, whose world matrices must be current.
   *
   * Members are expected to be visible in the world; the caller filters, because only it knows
   * about isolation, selection and the like.
   */
  rebuild(members: Iterable<BatchMember>, root: THREE.Object3D): void {
    this.clear();
    const groups = new Map<string, BatchMember[]>();
    for (const member of members) {
      const group = groups.get(member.key);
      if (group) group.push(member);
      else groups.set(member.key, [member]);
    }
    for (const [key, group] of groups) {
      if (group.length < MIN_BATCH) continue;
      const first = group[0]!;
      const batch = new THREE.InstancedMesh(first.mesh.geometry, first.mesh.material, group.length);
      batch.name = `batch:${first.mesh.name}`;
      batch.castShadow = first.mesh.castShadow;
      batch.receiveShadow = first.mesh.receiveShadow;
      batch.userData.batchKey = key;
      // Picking goes through the entities' own meshes, which the raycaster still sees.
      batch.raycast = () => {};
      group.forEach((member, index) => {
        batch.setMatrixAt(index, member.mesh.matrixWorld);
        member.mesh.layers.set(BATCHED_LAYER);
        this.hidden.push(member.mesh);
      });
      batch.instanceMatrix.needsUpdate = true;
      batch.computeBoundingSphere();
      root.add(batch);
      this.batches.push(batch);
    }
  }

  /** Remove every batch and hand each primitive back to its own mesh. */
  clear(): void {
    for (const batch of this.batches) {
      batch.removeFromParent();
      batch.dispose();
    }
    this.batches.length = 0;
    for (const mesh of this.hidden) mesh.layers.set(0);
    this.hidden.length = 0;
  }

  dispose(): void {
    this.clear();
  }
}
