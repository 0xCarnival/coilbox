import type { GameDocument, SceneDocument, ValidationIssue } from '@schema/index.js';
import { planCommand, type CommandPlan, type EditorCommand } from './commands.js';
import { CommandHistory, type HistoryEntry } from './history.js';

/**
 * The authored document store (plan §6, §8).
 *
 * Owns the authored entities, properties, and scene settings. It never holds live Three.js
 * objects or running script instances — the viewport and the runtime are projections of
 * what lives here.
 *
 * Every committed change goes through `execute`, which plans the change, validates the
 * result, applies it immutably, and records an undo entry. Temporary viewport feedback
 * during a drag belongs to the viewport, not to this store.
 */

export type SaveState = 'clean' | 'dirty' | 'saving' | 'error';

export interface ExecuteOptions {
  /** Consecutive commands with the same key collapse into one undo entry. */
  coalesceKey?: string;
  label?: string;
  /** Plan the command without committing it (used for previews and tests). */
  dryRun?: boolean;
}

export type ExecuteResult = { ok: true; plan: CommandPlan } | { ok: false; issues: ValidationIssue[] };

export interface StoreSnapshot {
  project: GameDocument;
  scene: SceneDocument;
  saveState: SaveState;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  historySize: number;
}

export interface StoreOptions {
  history?: CommandHistory;
  /** Called after every committed change. */
  onChange?: (snapshot: StoreSnapshot, cause: 'execute' | 'undo' | 'redo' | 'reset' | 'saved') => void;
}

export class SceneDocumentStore {
  private projectDocument: GameDocument;
  private sceneDocument: SceneDocument;
  private readonly history: CommandHistory;
  private readonly onChange: StoreOptions['onChange'];
  private saveState: SaveState = 'clean';
  private listeners = new Set<(snapshot: StoreSnapshot) => void>();

  constructor(project: GameDocument, scene: SceneDocument, options: StoreOptions = {}) {
    this.projectDocument = project;
    this.sceneDocument = scene;
    this.history = options.history ?? new CommandHistory();
    this.onChange = options.onChange;
  }

  /** Replace the loaded documents (opening another project or scene). */
  reset(project: GameDocument, scene: SceneDocument): void {
    this.projectDocument = project;
    this.sceneDocument = scene;
    this.history.clear();
    this.saveState = 'clean';
    this.emit('reset');
  }

  get project(): GameDocument {
    return this.projectDocument;
  }

  get scene(): SceneDocument {
    return this.sceneDocument;
  }

  get isDirty(): boolean {
    return this.saveState === 'dirty' || this.saveState === 'error';
  }

  get currentSaveState(): SaveState {
    return this.saveState;
  }

  get currentHistory(): CommandHistory {
    return this.history;
  }

  get canUndo(): boolean {
    return this.history.canUndo();
  }

  get canRedo(): boolean {
    return this.history.canRedo();
  }

  undoLabel(): string | null {
    return this.history.peekUndo()?.label ?? null;
  }

  redoLabel(): string | null {
    return this.history.peekRedo()?.label ?? null;
  }

  snapshot(): StoreSnapshot {
    return {
      project: this.projectDocument,
      scene: this.sceneDocument,
      saveState: this.saveState,
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
      undoLabel: this.undoLabel(),
      redoLabel: this.redoLabel(),
      historySize: this.history.size,
    };
  }

  subscribe(listener: (snapshot: StoreSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Plan and apply one command. Invalid commands change nothing. */
  execute(command: EditorCommand, options: ExecuteOptions = {}): ExecuteResult {
    const plan = planCommand(this.sceneDocument, command);
    if (!plan.ok) return plan;
    if (options.dryRun) return { ok: true, plan };

    this.sceneDocument = plan.next;
    this.history.push(command, [plan.inverse], {
      coalesceKey: options.coalesceKey,
      label: options.label ?? plan.label,
    });
    this.saveState = 'dirty';
    this.emit('execute');
    return { ok: true, plan };
  }

  /**
   * Apply several commands as one undo step.
   *
   * The transaction is all-or-nothing: if any command fails to plan, earlier commands in
   * the transaction are rolled back and the failure is reported.
   */
  transaction(label: string, commands: EditorCommand[]): ExecuteResult {
    const appliedCommands: EditorCommand[] = [];
    const appliedInverses: EditorCommand[] = [];
    const original = this.sceneDocument;
    let lastPlan: CommandPlan | null = null;

    for (const command of commands) {
      const plan = planCommand(this.sceneDocument, command);
      if (!plan.ok) {
        this.sceneDocument = original;
        return plan;
      }
      this.sceneDocument = plan.next;
      appliedCommands.push(command);
      appliedInverses.push(plan.inverse);
      lastPlan = plan;
    }

    if (appliedCommands.length === 0) {
      return { ok: false, issues: [{ code: 'empty-transaction', path: 'command', message: 'nothing to do', severity: 'error' }] };
    }

    this.history.pushGroup(label, appliedCommands, appliedInverses);
    this.saveState = 'dirty';
    this.emit('execute');
    return lastPlan ? { ok: true, plan: lastPlan } : { ok: false, issues: [] };
  }

  undo(): boolean {
    const entry = this.history.undo();
    if (!entry) return false;
    this.applyEntry(entry, 'undo');
    return true;
  }

  redo(): boolean {
    const entry = this.history.redo();
    if (!entry) return false;
    this.applyEntry(entry, 'redo');
    return true;
  }

  /** Mark the document as written by the workspace service. */
  markSaved(revision?: number): void {
    if (revision !== undefined) this.sceneDocument = { ...this.sceneDocument, revision };
    this.saveState = 'clean';
    this.emit('saved');
  }

  markSaving(): void {
    this.saveState = 'saving';
    this.emit('saved');
  }

  markSaveFailed(): void {
    this.saveState = 'error';
    this.emit('saved');
  }

  /**
   * The scene document to write to disk. Revision is bumped by the caller (the workspace
   * service owns write concurrency, not the editor).
   */
  documentForWrite(): SceneDocument {
    return this.sceneDocument;
  }

  /** Apply an entry's commands or inverses without touching the undo stack. */
  private applyEntry(entry: HistoryEntry, direction: 'undo' | 'redo'): void {
    const commands = direction === 'undo' ? [...entry.inverses].reverse() : entry.commands;
    for (const command of commands) {
      const plan = planCommand(this.sceneDocument, command);
      if (!plan.ok) {
        // A history entry that no longer applies means the document was changed behind
        // the editor's back; stop rather than applying half an entry.
        this.saveState = 'error';
        this.emit(direction === 'undo' ? 'undo' : 'redo');
        return;
      }
      this.sceneDocument = plan.next;
    }
    this.saveState = 'dirty';
    this.emit(direction === 'undo' ? 'undo' : 'redo');
  }

  private emit(cause: 'execute' | 'undo' | 'redo' | 'reset' | 'saved'): void {
    const snapshot = this.snapshot();
    this.onChange?.(snapshot, cause);
    for (const listener of this.listeners) listener(snapshot);
  }
}
