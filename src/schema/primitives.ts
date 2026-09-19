/**
 * Shared primitive value types for the authored project format.
 *
 * Conventions (see docs/threejs-game-studio-plan.md §7):
 * - Distances are metres.
 * - Time is seconds.
 * - Rotations are normalised quaternions `[x, y, z, w]`; the editor presents degrees.
 * - The world is Y-up, right-handed.
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];
export const ZERO_VEC3: Vec3 = [0, 0, 0];
export const ONE_VEC3: Vec3 = [1, 1, 1];

/** Stable identifier for an entity inside one scene document. */
export type EntityId = string;
/** Stable identifier for a scene, unique inside a project. */
export type SceneId = string;
/** Stable identifier for an asset, unique inside a project. */
export type AssetId = string;
/** Stable identifier for a registered behavior. */
export type BehaviorId = string;
/** Stable identifier for a project. */
export type ProjectId = string;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
