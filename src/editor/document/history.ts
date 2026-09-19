import type { EditorCommand } from './commands.js';

/**
 * Undo/redo history (plan §8).
 *
 * One history entry can hold several commands, which is what makes "reparent and keep the
 * world transform" or "drag a handle" a single undo step. Consecutive edits that share a
 * coalesce key (typing in one inspector field, holding an arrow key) collapse into the
 * entry already on the stack instead of filling it with noise.
 */

export interface HistoryEntry {
  id: number;
  label: string;
  /** Commands applied by this entry, in order. */
  commands: EditorCommand[];
  /** Commands that undo this entry, in the same order (applied in reverse). */
  inverses: EditorCommand[];
  coalesceKey?: string;
  timestamp: number;
}

export interface HistoryOptions {
  /** Maximum number of entries kept. Oldest entries are dropped first. */
  limit?: number;
  /** Consecutive edits sharing a coalesce key merge within this window, in milliseconds. */
  coalesceWindowMs?: number;
  now?: () => number;
}

export interface PushOptions {
  coalesceKey?: string;
  label?: string;
}

export class CommandHistory {
  private entries: HistoryEntry[] = [];
  /** Number of entries that are currently applied; entries beyond it are redoable. */
  private cursor = 0;
  private nextId = 1;
  private readonly limit: number;
  private readonly coalesceWindowMs: number;
  private readonly now: () => number;

  constructor(options: HistoryOptions = {}) {
    this.limit = options.limit ?? 200;
    this.coalesceWindowMs = options.coalesceWindowMs ?? 600;
    this.now = options.now ?? (() => Date.now());
  }

  push(command: EditorCommand | EditorCommand[], inverse: EditorCommand[], options: PushOptions = {}): HistoryEntry {
    const commands = Array.isArray(command) ? command : [command];
    const timestamp = this.now();

    // A new edit after undoing discards the redo branch.
    if (this.cursor < this.entries.length) this.entries = this.entries.slice(0, this.cursor);

    const previous = this.entries[this.entries.length - 1];
    const canCoalesce =
      options.coalesceKey !== undefined &&
      previous !== undefined &&
      previous.coalesceKey === options.coalesceKey &&
      timestamp - previous.timestamp <= this.coalesceWindowMs;

    if (canCoalesce && previous) {
      previous.commands.push(...commands);
      previous.inverses.push(...inverse);
      previous.timestamp = timestamp;
      if (options.label) previous.label = options.label;
      return previous;
    }

    const entry: HistoryEntry = {
      id: this.nextId++,
      label: options.label ?? describeCommand(commands[0]),
      commands,
      inverses: inverse,
      coalesceKey: options.coalesceKey,
      timestamp,
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries = this.entries.slice(this.entries.length - this.limit);
    }
    this.cursor = this.entries.length;
    return entry;
  }

  /**
   * Push a group of commands as one entry. The caller supplies the inverses in the same
   * order as the commands; undo applies them in reverse.
   */
  pushGroup(
    label: string,
    commands: EditorCommand[],
    inverses: EditorCommand[],
    options?: { coalesceKey?: string },
  ): HistoryEntry {
    return this.push(commands, inverses, { label, ...options });
  }

  canUndo(): boolean {
    return this.cursor > 0;
  }

  canRedo(): boolean {
    return this.cursor < this.entries.length;
  }

  peekUndo(): HistoryEntry | undefined {
    return this.entries[this.cursor - 1];
  }

  peekRedo(): HistoryEntry | undefined {
    return this.entries[this.cursor];
  }

  /** Move the cursor back one entry and return it. */
  undo(): HistoryEntry | undefined {
    if (!this.canUndo()) return undefined;
    this.cursor -= 1;
    return this.entries[this.cursor];
  }

  /** Move the cursor forward one entry and return it. */
  redo(): HistoryEntry | undefined {
    if (!this.canRedo()) return undefined;
    const entry = this.entries[this.cursor];
    this.cursor += 1;
    return entry;
  }

  entriesFromOldest(): readonly HistoryEntry[] {
    return this.entries;
  }

  get position(): number {
    return this.cursor;
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
    this.cursor = 0;
  }

  /** Break coalescing so the next edit starts a new entry. */
  breakCoalescing(): void {
    const previous = this.entries[this.entries.length - 1];
    if (previous) previous.coalesceKey = undefined;
  }
}

function describeCommand(command: EditorCommand | undefined): string {
  switch (command?.kind) {
    case 'insertEntities':
      return 'Add entity';
    case 'deleteEntities':
      return 'Delete';
    case 'renameEntity':
      return 'Rename';
    case 'setTransform':
      return 'Transform';
    case 'setComponentProperty':
      return 'Change property';
    case 'setBehaviorProperty':
      return 'Change setting';
    case 'addComponent':
      return 'Add component';
    case 'removeComponent':
      return 'Remove component';
    case 'setEntityEnabled':
      return 'Toggle enabled';
    case 'setEditorState':
      return 'Editor state';
    case 'reparentEntity':
      return 'Reparent';
    case 'setActiveCamera':
      return 'Set camera';
    case 'setSceneEnvironment':
      return 'Environment';
    case 'setSceneName':
      return 'Rename scene';
    default:
      return 'Edit';
  }
}
