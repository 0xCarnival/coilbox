import type { EntityId, JsonValue } from '@schema/index.js';
import type { BehaviorContext, BehaviorInput, BehaviorInstance } from './types.js';
import type { BehaviorRegistry } from './registry.js';
import type { GameState } from '../game-state.js';
import type { ContactEvent, PhysicsWorldHandle } from '../physics/types.js';
import type { Hud } from '../hud/hud.js';

/**
 * Behavior runtime (plan §9, §10).
 *
 * Behaviors are only constructed in Play or export — never while a scene is being edited —
 * and each instance gets a narrow context: entity lookup, input actions, physics operations,
 * game state, logging, and events. There is no access to the document store, the filesystem,
 * or the editor.
 */

export interface BehaviorHost {
  input: BehaviorInput;
  state: GameState;
  physics: PhysicsWorldHandle;
  hud: Hud | null;
  /** Entity ids present in the running world, in scene order. */
  entityIds(): EntityId[];
  entityName(entityId: EntityId): string | null;
  /** Find an entity by its display name; used by behaviors that point at a named target. */
  findByName(name: string): EntityId | null;
  findById(entityId: EntityId): EntityId | null;
  readTransform(entityId: EntityId, out: Float32Array): boolean;
  readVelocity(entityId: EntityId, out: Float32Array): boolean;
  setKinematicTransform(entityId: EntityId, position: [number, number, number], rotation: [number, number, number, number]): void;
  /** Swept move for a kinematic character; see BehaviorContext.moveCharacter. */
  moveCharacter(entityId: EntityId, position: [number, number, number], rotation: [number, number, number, number]): void;
  setBodyEnabled(entityId: EntityId, enabled: boolean): void;
  setBodyType(entityId: EntityId, type: 'static' | 'dynamic' | 'kinematic'): void;
  isPhysicsBody(entityId: EntityId): boolean;
  requestScene(sceneId: string): void;
  requestRestart(): void;
  /** Play a clip on an entity's animation controller, if it has one. */
  playClip(entityId: EntityId, clip: string | null, options?: { loop?: boolean; speed?: number; autoplay?: boolean }): boolean;
  /** Play the audio asset referenced by an entity's audio component. */
  playSound(entityId: EntityId, options?: { volume?: number; loop?: boolean }): boolean;
  /** Decode an entity's audio asset ahead of the first play. */
  prepareAudio(entityId: EntityId): void;
  log(level: 'info' | 'warning' | 'error', message: string, entityId?: EntityId): void;
  /** Route a scene transition or restart requested by a HUD button. */
  requestAction(action: 'restart' | 'nextScene' | 'resume' | 'none'): void;
}

export interface BehaviorRecord {
  entityId: EntityId;
  behaviorId: string;
  instance: BehaviorInstance;
  properties: Record<string, JsonValue>;
}

export interface BehaviorRuntimeOptions {
  registry: BehaviorRegistry;
  host: BehaviorHost;
  /** Entity id -> behavior components, in document order. */
  behaviorsByEntity: Map<EntityId, Array<{ behaviorId: string; properties: Record<string, JsonValue> }>>;
}

export class BehaviorRuntime {
  private readonly registry: BehaviorRegistry;
  private readonly host: BehaviorHost;
  private readonly records: BehaviorRecord[] = [];
  private readonly byEntity = new Map<EntityId, BehaviorRecord[]>();
  private readonly eventListeners = new Map<EntityId, BehaviorRecord[]>();
  private readonly eventLog: Array<{ entityId: EntityId; kind: string; other: EntityId | null; at: number }> = [];
  private readonly startedAt = Date.now();
  private disposed = false;

  constructor(options: BehaviorRuntimeOptions) {
    this.registry = options.registry;
    this.host = options.host;

    for (const [entityId, components] of options.behaviorsByEntity) {
      for (const component of components) {
        const definition = this.registry.get(component.behaviorId);
        if (!definition?.definition) {
          this.host.log(
            'error',
            `behavior "${component.behaviorId}" on entity "${this.host.entityName(entityId) ?? entityId}" is not registered in this build`,
            entityId,
          );
          continue;
        }
        const properties = { ...this.registry.defaults(component.behaviorId), ...component.properties } as Record<string, JsonValue>;
        try {
          const instance = definition.definition.create(this.createContext(entityId, properties, component.behaviorId));
          const record: BehaviorRecord = { entityId, behaviorId: component.behaviorId, instance, properties };
          this.records.push(record);
          const forEntity = this.byEntity.get(entityId) ?? [];
          forEntity.push(record);
          this.byEntity.set(entityId, forEntity);
        } catch (error) {
          // A behavior that refuses to construct must not take the whole game down.
          this.host.log(
            'error',
            `behavior "${component.behaviorId}" on "${this.host.entityName(entityId) ?? entityId}" failed to start: ${String(error)}`,
            entityId,
          );
        }
      }
    }

    for (const record of this.records) {
      try {
        record.instance.start?.();
      } catch (error) {
        this.host.log('error', `behavior "${record.behaviorId}" threw in start(): ${String(error)}`, record.entityId);
      }
    }
  }

  get size(): number {
    return this.records.length;
  }

  list(): Array<{ entityId: EntityId; behaviorId: string }> {
    return this.records.map((record) => ({ entityId: record.entityId, behaviorId: record.behaviorId }));
  }

  /** Recent physics events, for the debug overlay and for tests. */
  recentEvents(): Array<{ entityId: EntityId; kind: string; other: EntityId | null; at: number }> {
    return [...this.eventLog];
  }

  fixedUpdate(fixedDelta: number): void {
    if (this.disposed) return;
    for (const record of this.records) {
      try {
        record.instance.fixedUpdate?.(fixedDelta);
      } catch (error) {
        this.host.log('error', `behavior "${record.behaviorId}" threw in fixedUpdate(): ${String(error)}`, record.entityId);
      }
    }
  }

  update(frameDelta: number): void {
    if (this.disposed) return;
    for (const record of this.records) {
      try {
        record.instance.update?.(frameDelta);
      } catch (error) {
        this.host.log('error', `behavior "${record.behaviorId}" threw in update(): ${String(error)}`, record.entityId);
      }
    }
  }

  /** Deliver physics events to the behaviors attached to the entities involved. */
  dispatchPhysicsEvent(event: ContactEvent): void {
    if (this.disposed) return;
    const deliver = (entityId: EntityId | null, other: EntityId | null) => {
      if (!entityId) return;
      const records = this.byEntity.get(entityId);
      if (!records) return;
      for (const record of records) {
        if (!record.instance.onPhysicsEvent) continue;
        try {
          record.instance.onPhysicsEvent({
            kind: event.kind,
            other,
            approachSpeed: event.approachSpeed,
            point: event.point,
            normal: event.normal,
          });
        } catch (error) {
          this.host.log('error', `behavior "${record.behaviorId}" threw in onPhysicsEvent(): ${String(error)}`, entityId);
        }
      }
    };
    deliver(event.a, event.b);
    deliver(event.b, event.a);
    for (const entityId of [event.a, event.b]) {
      if (entityId) this.eventLog.push({ entityId, kind: event.kind, other: null, at: Date.now() - this.startedAt });
    }
    if (this.eventLog.length > 200) this.eventLog.splice(0, this.eventLog.length - 200);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.records) {
      try {
        record.instance.dispose?.();
      } catch (error) {
        this.host.log('error', `behavior "${record.behaviorId}" threw in dispose(): ${String(error)}`, record.entityId);
      }
    }
    this.records.length = 0;
    this.byEntity.clear();
    this.eventListeners.clear();
  }

  private createContext(entityId: EntityId, properties: Record<string, JsonValue>, behaviorId: string): BehaviorContext {
    const host = this.host;
    const transformScratch = new Float32Array(7);
    const velocityScratch = new Float32Array(3);
    const eventSubscribers = new Map<string, Set<(payload?: JsonValue) => void>>();

    const context: BehaviorContext = {
      entityId,
      properties,
      behaviorId,
      readTransform: (id, out) => host.readTransform(id, out),
      readVelocity: (id, out) => host.readVelocity(id, out),
      moveKinematic: (id, position, rotation) => host.setKinematicTransform(id, position, rotation),
      moveCharacter: (id, position, rotation) => host.moveCharacter(id, position, rotation),
      applyImpulse: (id, impulse, point) => host.physics.applyImpulse(id, impulse, point),
      setLinearVelocity: (id, velocity) => host.physics.setLinearVelocity(id, velocity),
      raycast: (origin, direction, maxDistance) => {
        const hit = host.physics.raycastClosest(origin, direction, maxDistance);
        return {
          hit: hit.hit,
          entityId: hit.key,
          distance: hit.distance,
          point: hit.point,
          normal: hit.normal,
        };
      },
      isActionDown: (action) => host.input.isActionDown(action),
      wasActionPressed: (action) => host.input.wasActionPressed(action),
      wasActionReleased: (action) => host.input.wasActionReleased(action),
      getState: <T = JsonValue>(key: string) => host.state.get(key) as T | undefined,
      setState: (key, value) => host.state.set(key, value),
      requestScene: (sceneId) => host.requestScene(sceneId),
      requestRestart: () => host.requestRestart(),
      log: (message, data) => host.log('info', data === undefined ? message : `${message} ${JSON.stringify(data)}`, entityId),
      emit: (event, payload) => {
        const subscribers = eventSubscribers.get(event);
        if (!subscribers) return;
        for (const subscriber of subscribers) subscriber(payload);
      },
      on: (event, handler) => {
        const set = eventSubscribers.get(event) ?? new Set();
        set.add(handler);
        eventSubscribers.set(event, set);
        return () => set.delete(handler);
      },
      findEntityByName: (name) => host.findByName(name),
      findEntityById: (id) => host.findById(id),
      setBodyType: (id, type) => host.setBodyType(id, type),
      setBodyEnabled: (id, enabled) => host.setBodyEnabled(id, enabled),
      isPhysicsBody: (id) => host.isPhysicsBody(id),
      playClip: (clip, options) => host.playClip(entityId, clip, options),
      playSound: (options) => host.playSound(entityId, options),
      prepareAudio: () => host.prepareAudio(entityId),
      showOverlay: (kind) => host.hud?.showOnlyOverlay(kind),
      setOverlayVisible: (kind, visible) => host.hud?.setOverlayVisible(kind, visible),
      setHudText: (elementId, text) => host.hud?.updateText(elementId, text),
      requestAction: (action) => host.requestAction(action),
      pointer: () => host.input.pointer(),
      moveAxis: () => host.input.moveAxis(),
      scratch: { transform: transformScratch, velocity: velocityScratch },
    };
    return context;
  }
}
