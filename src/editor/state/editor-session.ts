import type { GameDocument, SceneDocument, ValidationIssue } from '@schema/index.js';
import type { EditorCommand } from '../document/commands.js';
import { SceneDocumentStore, type SaveState } from '../document/store.js';
import { SelectionStore } from '../document/selection.js';
import { WorkspaceClient, WorkspaceClientError, type ProjectDetail, type ProjectSummary } from '../api/client.js';

export type { ProjectDetail, ProjectSummary } from '../api/client.js';

/**
 * Editor session: the authoring state the panels render.
 *
 * Holds the open project and scene, the document store with its history, the selection,
 * and a console log. It is deliberately framework-free — React subscribes to it through
 * `useSyncExternalStore`, and the viewport reads the same documents imperatively.
 */

export type LogLevel = 'info' | 'warning' | 'error';

export interface LogEntry {
  id: number;
  level: LogLevel;
  message: string;
  at: string;
  detail?: string;
}

export interface SessionSnapshot {
  projects: ProjectSummary[];
  project: ProjectDetail | null;
  sceneId: string | null;
  projectError: string | null;
  loading: boolean;
  saveState: SaveState;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  dirty: boolean;
  selectedIds: readonly string[];
  primarySelection: string | null;
  logs: LogEntry[];
  /** Set when a write was refused because the file changed underneath the editor. */
  conflict: { message: string; expected: number; actual: number } | null;
  lastSavedAt: string | null;
}

export class EditorSession {
  readonly client: WorkspaceClient;
  readonly selection = new SelectionStore();

  private projects: ProjectSummary[] = [];
  private project: ProjectDetail | null = null;
  private sceneId: string | null = null;
  private store: SceneDocumentStore | null = null;
  private projectError: string | null = null;
  private loading = false;
  private logs: LogEntry[] = [];
  private logCounter = 1;
  private conflict: SessionSnapshot['conflict'] = null;
  private lastSavedAt: string | null = null;
  private listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private unsubscribes: Array<() => void> = [];
  private cachedSnapshot: SessionSnapshot | null = null;

  constructor(client: WorkspaceClient = new WorkspaceClient()) {
    this.client = client;
  }

  // ------------------------------------------------------------------ reading

  get document(): SceneDocumentStore | null {
    return this.store;
  }

  get scene(): SceneDocument | null {
    return this.store?.scene ?? null;
  }

  get game(): GameDocument | null {
    return this.store?.project ?? null;
  }

  snapshot(): SessionSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    const snapshot: SessionSnapshot = {
      projects: this.projects,
      project: this.project,
      sceneId: this.sceneId,
      projectError: this.projectError,
      loading: this.loading,
      saveState: this.store?.currentSaveState ?? 'clean',
      canUndo: this.store?.canUndo ?? false,
      canRedo: this.store?.canRedo ?? false,
      undoLabel: this.store?.undoLabel() ?? null,
      redoLabel: this.store?.redoLabel() ?? null,
      dirty: this.store?.isDirty ?? false,
      selectedIds: this.selection.selectedIds,
      primarySelection: this.selection.primary,
      logs: this.logs,
      conflict: this.conflict,
      lastSavedAt: this.lastSavedAt,
    };
    this.cachedSnapshot = snapshot;
    return snapshot;
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.cachedSnapshot = null;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  log(level: LogLevel, message: string, detail?: string): void {
    this.logs = [...this.logs.slice(-199), { id: this.logCounter++, level, message, at: new Date().toISOString(), detail }];
    this.emit();
  }

  clearLogs(): void {
    this.logs = [];
    this.emit();
  }

  // ------------------------------------------------------------------ project

  async refreshProjects(): Promise<void> {
    this.loading = true;
    this.emit();
    try {
      const { projects } = await this.client.listProjects();
      this.projects = projects;
      this.projectError = null;
    } catch (error) {
      this.projectError = describeError(error);
      this.log('error', 'Could not list projects', describeError(error));
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  async createProject(input: { id: string; name: string; template?: string }): Promise<boolean> {
    try {
      const { project } = await this.client.createProject(input);
      this.log('info', `Created project "${project.name}"`);
      await this.refreshProjects();
      await this.openProject(project.id);
      return true;
    } catch (error) {
      const message = describeError(error);
      this.log('error', `Could not create "${input.id}"`, message);
      return false;
    }
  }

  async openProject(projectId: string, sceneId?: string): Promise<boolean> {
    this.loading = true;
    this.emit();
    try {
      const { project } = await this.client.readProject(projectId);
      this.project = project;
      this.projectError = null;
      await this.openScene(sceneId ?? project.game.startScene, project);
      this.log('info', `Opened "${project.name}"`);
      return true;
    } catch (error) {
      this.projectError = describeError(error);
      this.log('error', `Could not open "${projectId}"`, describeError(error));
      return false;
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  closeProject(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    this.project = null;
    this.sceneId = null;
    this.store = null;
    this.selection.clear();
    this.emit();
  }

  async openScene(sceneId: string, project: ProjectDetail | null = this.project): Promise<boolean> {
    if (!project) return false;
    this.loading = true;
    this.emit();
    try {
      const { scene } = await this.client.readScene(project.id, sceneId);
      for (const unsubscribe of this.unsubscribes) unsubscribe();
      this.unsubscribes = [];
      this.store = new SceneDocumentStore(project.game, scene);
      this.sceneId = sceneId;
      this.conflict = null;
      this.unsubscribes.push(
        this.store.subscribe(() => this.emit()),
        this.selection.subscribe(() => this.emit()),
      );
      this.selection.prune(scene.entities.map((entity) => entity.id));
      return true;
    } catch (error) {
      this.log('error', `Could not open scene "${sceneId}"`, describeError(error));
      return false;
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  // ------------------------------------------------------------------ editing

  execute(command: EditorCommand, options: { coalesceKey?: string; label?: string } = {}): boolean {
    if (!this.store) return false;
    const result = this.store.execute(command, options);
    if (!result.ok) {
      this.log('warning', `Rejected: ${describeIssues(result.issues)}`, result.issues.map((issue) => issue.code).join(', '));
      return false;
    }
    this.selection.prune(this.store.scene.entities.map((entity) => entity.id));
    return true;
  }

  transaction(label: string, commands: EditorCommand[]): boolean {
    if (!this.store) return false;
    const result = this.store.transaction(label, commands);
    if (!result.ok) {
      this.log('warning', `Rejected: ${describeIssues(result.issues)}`);
      return false;
    }
    return true;
  }

  undo(): void {
    if (this.store?.undo()) this.selection.prune(this.store.scene.entities.map((entity) => entity.id));
  }

  redo(): void {
    if (this.store?.redo()) this.selection.prune(this.store.scene.entities.map((entity) => entity.id));
  }

  select(entityId: string | null, options: { additive?: boolean } = {}): void {
    this.selection.select(entityId, options);
  }

  // ------------------------------------------------------------------ saving

  async save(): Promise<boolean> {
    if (!this.store || !this.project || !this.sceneId) return false;
    const document = this.store.documentForWrite();
    this.store.markSaving();
    try {
      const written = await this.client.writeScene(this.project.id, this.sceneId, document, document.revision);
      this.store.markSaved(written.scene.revision);
      this.conflict = null;
      this.lastSavedAt = new Date().toISOString();
      this.log('info', `Saved ${this.sceneId} (revision ${written.scene.revision})`);
      return true;
    } catch (error) {
      this.store.markSaveFailed();
      if (error instanceof WorkspaceClientError && error.isConflict) {
        this.conflict = { message: error.message, expected: document.revision, actual: -1 };
        this.log('error', 'Save refused: the file changed on disk', error.message);
      } else {
        this.log('error', 'Save failed', describeError(error));
      }
      return false;
    }
  }

  /** Re-read the scene from disk, discarding local edits (used after a conflict). */
  async reloadScene(): Promise<void> {
    if (!this.sceneId) return;
    await this.openScene(this.sceneId);
    this.conflict = null;
    this.log('info', 'Reloaded the scene from disk');
  }

  /** Accept the disk revision and re-apply the local document on top of it. */
  async overwriteWithLocal(): Promise<boolean> {
    if (!this.store || !this.project || !this.sceneId) return false;
    const local = this.store.documentForWrite();
    try {
      const onDisk = await this.client.readScene(this.project.id, this.sceneId);
      const written = await this.client.writeScene(this.project.id, this.sceneId, local, onDisk.scene.revision);
      this.store.markSaved(written.scene.revision);
      this.conflict = null;
      this.log('info', `Overwrote ${this.sceneId} at revision ${written.scene.revision}`);
      return true;
    } catch (error) {
      this.store.markSaveFailed();
      this.log('error', 'Overwrite failed', describeError(error));
      return false;
    }
  }
}

export function describeIssues(issues: ValidationIssue[]): string {
  return issues.length > 0 ? issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ') : 'the change was rejected';
}

export function describeError(error: unknown): string {
  if (error instanceof WorkspaceClientError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
