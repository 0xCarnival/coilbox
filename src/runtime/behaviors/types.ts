import type { EntityId, JsonValue } from '@schema/index.js';

/**
 * Behavior contract (plan §10).
 *
 * Registered behaviors, not a large entity-component framework and not a visual
 * scripting language. The runtime needs exactly five predictable hooks: creation,
 * start, fixed update, frame update, and disposal. Property metadata lives in
 * `scripts/registry.json` and is mirrored here so the inspector, the validator, and the
 * build-time check all read one description.
 */

export type BehaviorPropertyType = 'number' | 'boolean' | 'text' | 'enum' | 'entity' | 'asset';

export interface BehaviorPropertyDescriptor {
  key: string;
  label: string;
  type: BehaviorPropertyType;
  /** Default used when a scene omits the property. */
  default: JsonValue;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Allowed values for `enum` properties. */
  options?: string[];
  /** Group heading in the inspector. */
  group?: string;
  /** Advanced properties start collapsed in the inspector. */
  advanced?: boolean;
}

export type HudOverlayKind = 'start' | 'win' | 'lose' | 'pause';

export interface PointerSnapshot {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  down: boolean;
  justPressed: boolean;
  justReleased: boolean;
}

/** The subset of the input system behaviors may use; the runtime's InputSystem satisfies it. */
export interface BehaviorInput {
  isActionDown(action: string): boolean;
  wasActionPressed(action: string): boolean;
  wasActionReleased(action: string): boolean;
  moveAxis(): { x: number; y: number };
  pointer(): PointerSnapshot;
}

export interface RaycastSummary {
  hit: boolean;
  entityId: EntityId | null;
  distance: number;
  point: [number, number, number];
  normal: [number, number, number];
}

/**
 * The narrow game-facing context (plan §10): entity lookup, input actions, physics
 * operations, audio, scene loading, and game state. Behaviors get nothing else — no
 * document store, no filesystem, no editor.
 */
export interface BehaviorContext {
  readonly entityId: EntityId;
  readonly behaviorId: string;
  /** Declared defaults merged with the values stored on the entity. */
  readonly properties: Record<string, JsonValue>;

  readTransform(entityId: EntityId, out: Float32Array): boolean;
  readVelocity(entityId: EntityId, out: Float32Array): boolean;
  /** Move a kinematic body through the physics adapter, never around it. */
  moveKinematic(entityId: EntityId, position: [number, number, number], rotation: [number, number, number, number]): void;
  /**
   * Move a kinematic character to `position`, sweeping its collider against the world first so a
   * wall stops it instead of letting it pass through. Movement is resolved one horizontal axis at
   * a time, so a diagonal push slides along a wall rather than stopping dead.
   *
   * `position` is updated in place to wherever the character actually got to, which is what the
   * caller should keep using as its own position.
   */
  moveCharacter(entityId: EntityId, position: [number, number, number], rotation: [number, number, number, number]): void;
  applyImpulse(entityId: EntityId, impulse: [number, number, number], point?: [number, number, number]): void;
  setLinearVelocity(entityId: EntityId, velocity: [number, number, number]): void;
  raycast(origin: [number, number, number], direction: [number, number, number], maxDistance: number): RaycastSummary;
  setBodyType(entityId: EntityId, type: 'static' | 'dynamic' | 'kinematic'): void;
  setBodyEnabled(entityId: EntityId, enabled: boolean): void;
  isPhysicsBody(entityId: EntityId): boolean;

  isActionDown(action: string): boolean;
  wasActionPressed(action: string): boolean;
  wasActionReleased(action: string): boolean;
  /** Movement axis in the XZ plane, normalised for diagonal input. */
  moveAxis(): { x: number; y: number };
  pointer(): PointerSnapshot;

  getState<T = JsonValue>(key: string): T | undefined;
  setState(key: string, value: JsonValue): void;
  /** Request a scene transition or a restart; applied by the host after the current step. */
  requestScene(sceneId: string): void;
  requestRestart(): void;
  /** Route a HUD action ('restart', 'nextScene', 'resume'). */
  requestAction(action: 'restart' | 'nextScene' | 'resume' | 'none'): void;

  /** Play one of this entity's model clips. Returns false when the entity has no model/clips. */
  playClip(clip: string | null, options?: { loop?: boolean; speed?: number; autoplay?: boolean }): boolean;
  /** Play this entity's audio asset. Returns false when there is nothing to play yet. */
  playSound(options?: { volume?: number; loop?: boolean }): boolean;
  /** Decode this entity's audio ahead of time; call from a user gesture. */
  prepareAudio(): void;

  showOverlay(kind: HudOverlayKind | null): void;
  setOverlayVisible(kind: HudOverlayKind, visible: boolean): void;
  setHudText(elementId: string, text: string): void;

  findEntityByName(name: string): EntityId | null;
  findEntityById(entityId: EntityId): EntityId | null;

  log(message: string, data?: JsonValue): void;
  emit(event: string, payload?: JsonValue): void;
  on(event: string, handler: (payload?: JsonValue) => void): () => void;

  /** Reusable per-instance buffers, so behaviors do not allocate on the hot path. */
  readonly scratch: { transform: Float32Array; velocity: Float32Array };
}

export interface BehaviorInstance {
  /** Called once after construction, before the first update. */
  start?(): void;
  /** Fixed-timestep update; the only place gameplay should mutate physics. */
  fixedUpdate?(fixedDelta: number): void;
  /** Per-frame update for camera smoothing and presentation. Never step physics here. */
  update?(frameDelta: number): void;
  /** Physics events involving this entity. */
  onPhysicsEvent?(event: {
    kind: 'begin' | 'end' | 'hit' | 'sensorBegin' | 'sensorEnd';
    other: EntityId | null;
    approachSpeed?: number;
    point?: [number, number, number];
    normal?: [number, number, number];
  }): void;
  /** Release listeners, audio, and any per-instance resources. */
  dispose?(): void;
}

export interface BehaviorDefinition {
  id: string;
  name: string;
  description: string;
  properties: BehaviorPropertyDescriptor[];
  create(context: BehaviorContext): BehaviorInstance;
}

/** A behavior registration with its metadata, as stored in `scripts/registry.json`. */
export interface BehaviorEntry {
  id: string;
  name: string;
  description: string;
  properties: BehaviorPropertyDescriptor[];
  /** Executable definition; absent in metadata-only contexts. */
  definition?: BehaviorDefinition;
  /** Source file the behavior was registered from, for error reporting. */
  source?: string;
}
