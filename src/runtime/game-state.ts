import type { JsonValue } from '@schema/index.js';

/**
 * Game state: the small shared object HUD bindings and behaviors read and write (plan §10).
 *
 * It is deliberately not a general store — string keys with JSON values, plus change
 * notifications so the HUD can re-render without the runtime pushing values every frame.
 */

export type GameStateListener = (key: string, value: JsonValue) => void;

export class GameState {
  private values: Record<string, JsonValue>;
  private readonly listeners = new Set<GameStateListener>();

  constructor(initial: Record<string, JsonValue> = {}) {
    this.values = { ...initial };
  }

  get<T extends JsonValue = JsonValue>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }

  set(key: string, value: JsonValue): void {
    if (this.values[key] === value) return;
    this.values[key] = value;
    for (const listener of this.listeners) listener(key, value);
  }

  increment(key: string, delta = 1): number {
    const current = this.values[key];
    const next = (typeof current === 'number' ? current : 0) + delta;
    this.set(key, next);
    return next;
  }

  has(key: string): boolean {
    return key in this.values;
  }

  snapshot(): Record<string, JsonValue> {
    return { ...this.values };
  }

  subscribe(listener: GameStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reset to the initial values, keeping subscribers (used by restart). */
  reset(initial: Record<string, JsonValue> = {}): void {
    const keys = new Set([...Object.keys(this.values), ...Object.keys(initial)]);
    this.values = { ...initial };
    for (const key of keys) {
      for (const listener of this.listeners) listener(key, this.values[key] ?? null);
    }
  }
}
