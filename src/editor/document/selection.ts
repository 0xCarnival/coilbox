import type { EntityId } from '@schema/index.js';

/**
 * Selection state (plan §3).
 *
 * Selection is editor state, not document state: it never enters the scene file and never
 * creates history entries. Stage 1 supports single-object selection, with the additive
 * flag already in place for groups and multi-selection later.
 */

export interface SelectionSnapshot {
  primary: EntityId | null;
  ids: EntityId[];
}

export class SelectionStore {
  private ids: EntityId[] = [];
  private listeners = new Set<(snapshot: SelectionSnapshot) => void>();

  get primary(): EntityId | null {
    return this.ids[0] ?? null;
  }

  get selectedIds(): readonly EntityId[] {
    return this.ids;
  }

  isSelected(entityId: EntityId): boolean {
    return this.ids.includes(entityId);
  }

  snapshot(): SelectionSnapshot {
    return { primary: this.primary, ids: [...this.ids] };
  }

  subscribe(listener: (snapshot: SelectionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  select(entityId: EntityId | null, options: { additive?: boolean } = {}): void {
    if (entityId === null) {
      this.set([]);
      return;
    }
    if (options.additive) {
      this.set(this.ids.includes(entityId) ? this.ids.filter((id) => id !== entityId) : [...this.ids, entityId]);
      return;
    }
    if (this.ids.length === 1 && this.ids[0] === entityId) return;
    this.set([entityId]);
  }

  clear(): void {
    this.set([]);
  }

  /** Drop ids that no longer exist in the document (after a delete or an external reload). */
  prune(existing: Iterable<EntityId>): void {
    const known = new Set(existing);
    if (this.ids.every((id) => known.has(id))) return;
    this.set(this.ids.filter((id) => known.has(id)));
  }

  private set(next: EntityId[]): void {
    this.ids = next;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
