import type { AssetEntry, BehaviorComponent, GameDocument, JsonValue, SceneDocument, ValidationIssue } from '@schema/index.js';
import type { EditorCommand } from '../document/commands.js';
import { SceneDocumentStore, type SaveState } from '../document/store.js';
import { SelectionStore } from '../document/selection.js';
import { WorkspaceClient, WorkspaceClientError, type ProjectDetail, type ProjectSummary } from '../api/client.js';
import { ApiAssetResolver } from '../api/asset-resolver.js';
import { BehaviorRegistry } from '@runtime/behaviors/registry.js';
import { declaredPanels, type DeclaredPanel } from '../ui/rail-registry.js';
import { BEHAVIOR_LIBRARY } from '@runtime/behaviors/library.js';
import type { BehaviorEntry, BehaviorPropertyDescriptor, BehaviorPropertyType } from '@runtime/behaviors/types.js';
import { isFiniteJsonNumber, isJsonBoolean, isJsonString, jsonField } from '../json-values.js';

export type { ProjectDetail, ProjectSummary } from '../api/client.js';

/** The `scene-updated` payload: which scene changed and the revision now on disk. */
interface SceneChange {
  sceneId: string | null;
  revision: number | null;
}

function sceneChange(data: string): SceneChange {
  const payload: JsonValue = JSON.parse(data);
  const sceneId = jsonField(payload, 'sceneId');
  const revision = jsonField(payload, 'revision');
  return {
    sceneId: isJsonString(sceneId) ? sceneId : null,
    revision: isFiniteJsonNumber(revision) ? revision : null,
  };
}

/** The optional `message` an `invalid` event carries. */
function invalidMessage(data: string): string | null {
  const payload: JsonValue = JSON.parse(data);
  const message = jsonField(payload, 'message');
  return isJsonString(message) ? message : null;
}

/** One behavior declaration from `scripts/registry.json`, or null when it carries no usable id. */
function declaredBehavior(entry: JsonValue): Omit<BehaviorEntry, 'definition'> | null {
  const id = jsonField(entry, 'id');
  if (!isJsonString(id)) return null;
  const name = jsonField(entry, 'name');
  const description = jsonField(entry, 'description');
  return {
    id,
    name: isJsonString(name) ? name : id,
    description: isJsonString(description) ? description : '',
    properties: declaredProperties(jsonField(entry, 'properties')),
  };
}

/** The property descriptors a behavior declares; entries without a usable key and type are dropped. */
function declaredProperties(value: JsonValue): BehaviorPropertyDescriptor[] {
  if (!Array.isArray(value)) return [];
  const descriptors: BehaviorPropertyDescriptor[] = [];
  for (const candidate of value) {
    const descriptor = declaredProperty(candidate);
    if (descriptor) descriptors.push(descriptor);
  }
  return descriptors;
}

function declaredProperty(value: JsonValue): BehaviorPropertyDescriptor | null {
  const key = jsonField(value, 'key');
  const type = jsonField(value, 'type');
  if (!isJsonString(key) || !isBehaviorPropertyType(type)) return null;
  const label = jsonField(value, 'label');
  const description = jsonField(value, 'description');
  const group = jsonField(value, 'group');
  const min = jsonField(value, 'min');
  const max = jsonField(value, 'max');
  const step = jsonField(value, 'step');
  const advanced = jsonField(value, 'advanced');
  return {
    key,
    label: isJsonString(label) ? label : key,
    type,
    default: jsonField(value, 'default'),
    description: isJsonString(description) ? description : undefined,
    min: isFiniteJsonNumber(min) ? min : undefined,
    max: isFiniteJsonNumber(max) ? max : undefined,
    step: isFiniteJsonNumber(step) ? step : undefined,
    options: declaredOptions(jsonField(value, 'options')),
    group: isJsonString(group) ? group : undefined,
    advanced: isJsonBoolean(advanced) ? advanced : undefined,
  };
}

/** Enum options as declared; a non-array declaration means "no list" rather than an empty one. */
function declaredOptions(value: JsonValue): string[] | undefined {
  return Array.isArray(value) ? value.filter(isJsonString) : undefined;
}

const isBehaviorPropertyType = (value: JsonValue): value is BehaviorPropertyType =>
  value === 'number' || value === 'boolean' || value === 'text' || value === 'enum' || value === 'entity' || value === 'asset';

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
  /** Set when a write was refused, or an external change landed, while edits were pending. */
  conflict: { message: string; expected: number; actual: number; source: 'save' | 'external' } | null;
  /** Live when the workspace service is reporting external file changes for this project. */
  watching: boolean;
  lastSavedAt: string | null;
  /** Imported assets, newest last. */
  assets: AssetEntry[];
  /** Where each asset is used, so removal can be honest about the consequences. */
  assetUsage: Record<string, Array<{ sceneId: string; entityId: string; entityName: string }>>;
  /** True while an import is in flight. */
  importing: boolean;
  /** Clip names per entity, reported as models finish loading. */
  modelClips: Record<string, string[]>;
  thumbnails: Record<string, string>;
  /** Behavior metadata declared by the project's scripts/registry.json. */
  behaviors: Array<{ id: string; name: string; description: string; properties: BehaviorPropertyDescriptor[] }>;
  /**
   * Editor panels the project declares.
   *
   * `null` means the project has not asked, which is different from asking for none: the rail shows
   * everything by default, and only a project that names panels gets a restricted set. See
   * `docs/extension-points.md`.
   */
  panels: readonly DeclaredPanel[] | null;
}

export class EditorSession {
  readonly client: WorkspaceClient;
  readonly selection = new SelectionStore();
  /** Resolves asset ids to URLs for the viewport and for Play. */
  readonly assetResolver = new ApiAssetResolver('');
  /** Metadata-only registry: it drives the inspector and validation, never execution. */
  private registry = new BehaviorRegistry();
  /** Panels declared by the project's registry document, or null when it declares none. */
  private panels: readonly DeclaredPanel[] | null = null;

  get behaviorRegistry(): BehaviorRegistry {
    return this.registry;
  }

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
  private assets: AssetEntry[] = [];
  private assetUsage: SessionSnapshot['assetUsage'] = {};
  private importing = false;
  private modelClips: Record<string, string[]> = {};
  private thumbnails: Record<string, string> = {};
  private thumbnailRenderer: ((assetId: string) => Promise<string | null>) | null = null;
  private readonly thumbnailRequests = new Set<string>();
  private listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private readonly assetReplacedListeners = new Set<(assetId: string) => void>();
  private unsubscribes: Array<() => void> = [];
  private cachedSnapshot: SessionSnapshot | null = null;
  private events: EventSource | null = null;
  private watching = false;

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
      watching: this.watching,
      lastSavedAt: this.lastSavedAt,
      assets: this.assets,
      assetUsage: this.assetUsage,
      importing: this.importing,
      modelClips: this.modelClips,
      thumbnails: this.thumbnails,
      panels: this.panels,
      behaviors: this.behaviorRegistry.list().map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        properties: entry.properties,
      })),
    };
    this.cachedSnapshot = snapshot;
    return snapshot;
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onAssetReplaced(listener: (assetId: string) => void): () => void {
    this.assetReplacedListeners.add(listener);
    return () => this.assetReplacedListeners.delete(listener);
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
      await this.refreshAssets();
      await this.refreshRegistry();
      this.watchProject();
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

  /** Called by the viewport when a model instance finishes loading. */
  reportModelClips(entityId: string, clips: string[]): void {
    const existing = this.modelClips[entityId];
    if (existing && existing.length === clips.length && existing.every((name, index) => name === clips[index])) return;
    this.modelClips = { ...this.modelClips, [entityId]: clips };
    this.emit();
  }

  clipsFor(entityId: string): string[] {
    return this.modelClips[entityId] ?? [];
  }

  /**
   * Subscribe to external file changes (plan §11).
   *
   * The service debounces and validates before reporting, so anything arriving here is a complete
   * document. With no local edits the editor reloads silently; with unsaved edits it shows a
   * conflict instead of discarding either version.
   */
  private watchProject(): void {
    this.stopWatching();
    if (!this.project || typeof EventSource === 'undefined') return;
    const projectId = this.project.id;
    const events = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`);
    this.events = events;
    // `watching` means the service has confirmed the stream, not that a connection object exists:
    // an external edit made before the service is listening is a missed event, and the status bar
    // (and the gates) should not claim otherwise.
    this.watching = false;
    this.emit();

    events.addEventListener('ready', () => {
      this.watching = true;
      this.emit();
    });
    events.addEventListener('scene-updated', (event) => {
      // Server-sent events always arrive as MessageEvents; anything else cannot carry a payload.
      if (!(event instanceof MessageEvent)) return;
      void this.handleExternalSceneChange(sceneChange(event.data));
    });
    events.addEventListener('invalid', (event) => {
      if (!(event instanceof MessageEvent)) return;
      this.log('warning', invalidMessage(event.data) ?? 'an external change could not be read');
    });
    events.addEventListener('assets-changed', () => {
      void this.refreshAssets();
    });
    events.addEventListener('registry-changed', () => {
      void this.refreshRegistry();
      this.log('info', 'scripts/registry.json changed on disk and was reloaded; Play will use the rebuilt behaviors');
    });
    events.onerror = () => {
      // A dropped stream is not fatal: the editor keeps its document and the human can reload.
      this.watching = false;
      this.emit();
    };
  }

  private stopWatching(): void {
    this.events?.close();
    this.events = null;
    this.watching = false;
  }

  private async handleExternalSceneChange(payload: SceneChange): Promise<void> {
    if (!this.store || !this.sceneId || payload.sceneId !== this.sceneId) return;
    const currentRevision = this.store.scene.revision;
    if (payload.revision === currentRevision) return;

    if (!this.store.isDirty) {
      await this.openScene(this.sceneId);
      this.log('info', `${this.sceneId} changed on disk and was reloaded (revision ${payload.revision})`);
      return;
    }
    this.conflict = {
      message: `${this.sceneId} changed on disk (revision ${payload.revision}) while you have unsaved edits`,
      expected: currentRevision,
      actual: payload.revision ?? -1,
      source: 'external',
    };
    this.log('warning', 'The file changed on disk', 'reload the scene or keep your version');
    this.emit();
  }

  /** Re-read the project's behavior registry so the inspector shows current property metadata. */
  async refreshRegistry(): Promise<void> {
    if (!this.project) return;
    try {
      const document_ = await this.client.readRegistry(this.project.id);
      const entries: Array<Omit<BehaviorEntry, 'definition'>> = [];
      // `scripts/registry.json` is a file on disk that people and tools edit, so every declaration
      // is read out of the JSON rather than assumed: a malformed entry is dropped, not half-used.
      for (const entry of document_.behaviors) {
        const declared = declaredBehavior(entry);
        if (declared) entries.push(declared);
      }
      this.registry = new BehaviorRegistry();
      this.registry.replaceMetadata(entries);
      /**
       * Panels ride in the same document as behaviors, because a project's editor configuration and
       * its game logic are the same kind of thing: declarations a project owns, read from disk, with
       * nothing trusted. Reading them here means one fetch serves both.
       */
      this.panels = declaredPanels(document_.panels);

      // The inspector renders the project's declarations; Play runs the compiled library. Say
      // so plainly when the two disagree instead of letting a behavior silently do nothing.
      const declared = new Set(entries.map((entry) => entry.id));
      const implemented = new Set(BEHAVIOR_LIBRARY.map((definition) => definition.id));
      for (const id of declared) {
        if (!implemented.has(id)) this.log('error', `scripts/registry.json declares "${id}", which this build does not implement`);
      }
      for (const id of implemented) {
        if (!declared.has(id)) this.log('warning', `"${id}" is implemented but missing from scripts/registry.json`);
      }
    } catch (error) {
      this.log('error', 'Could not read scripts/registry.json', describeError(error));
    }
    this.emit();
  }

  behaviorsFor(entityId: string): Array<{ behaviorId: string; properties: Record<string, JsonValue> }> {
    const entity = this.scene?.entities.find((candidate) => candidate.id === entityId);
    if (!entity) return [];
    return entity.components
      .filter((component): component is BehaviorComponent => component.type === 'behavior')
      .map((component) => ({ behaviorId: component.behaviorId, properties: component.properties }));
  }

  /** Rename the project's display name; the folder and id stay put. */
  async renameProject(name: string): Promise<boolean> {
    if (!this.project) return false;
    try {
      const { project } = await this.client.renameProject(this.project.id, name);
      this.project = project;
      await this.refreshProjects();
      this.emit();
      return true;
    } catch (error) {
      this.log('error', 'Could not rename the project', describeError(error));
      return false;
    }
  }

  /** Store a viewport capture as the project thumbnail. */
  async setThumbnail(pngBytes: Uint8Array): Promise<boolean> {
    if (!this.project) return false;
    try {
      const result = await this.client.uploadThumbnail(this.project.id, pngBytes);
      this.log('info', `Thumbnail updated (${(result.bytes / 1024).toFixed(0)} KiB)`);
      await this.refreshProjects();
      return true;
    } catch (error) {
      this.log('error', 'Could not save the thumbnail', describeError(error));
      return false;
    }
  }

  /** Copy this project into a new one (plan §4: duplicate). */
  async duplicateProject(newId: string, newName?: string): Promise<boolean> {
    if (!this.project) return false;
    try {
      await this.client.duplicateProject(this.project.id, { newId, newName });
      this.log('info', `Duplicated "${this.project.id}" to "${newId}"`);
      await this.refreshProjects();
      return true;
    } catch (error) {
      this.log('error', `Could not duplicate "${this.project.id}"`, describeError(error));
      return false;
    }
  }

  /** Archive this project into the workspace's recoverable archive folder. */
  async archiveProject(reason?: string): Promise<boolean> {
    if (!this.project) return false;
    const projectId = this.project.id;
    try {
      await this.client.archiveProject(projectId, reason);
      this.log('info', `Archived "${projectId}"`);
      this.closeProject();
      await this.refreshProjects();
      return true;
    } catch (error) {
      this.log('error', `Could not archive "${projectId}"`, describeError(error));
      return false;
    }
  }

  /** Export Project: download a source archive for a project. */
  async exportSource(projectId = this.project?.id): Promise<boolean> {
    if (!projectId) return false;
    try {
      const bytes = await this.client.exportSource(projectId);
      // `bytes.slice()` copies into a plain `ArrayBuffer`, which is what `BlobPart` accepts.
      const blob = new Blob([bytes.slice()], { type: 'application/gzip' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${projectId}-source.tar.gz`;
      anchor.click();
      URL.revokeObjectURL(url);
      this.log('info', `Exported the source of "${projectId}" (${(bytes.byteLength / 1024).toFixed(0)} KiB)`);
      return true;
    } catch (error) {
      this.log('error', `Could not export "${projectId}"`, describeError(error));
      return false;
    }
  }

  /** Import a source archive as a new project. */
  async importSource(file: { name: string; arrayBuffer(): Promise<ArrayBuffer> }, projectId?: string): Promise<boolean> {
    try {
      const bytes = await file.arrayBuffer();
      const result = await this.client.importSource(new Uint8Array(bytes), projectId);
      this.log('info', `Imported "${result.projectId}" from ${file.name}`);
      for (const warning of result.warnings) this.log('warning', warning);
      await this.refreshProjects();
      return true;
    } catch (error) {
      this.log('error', `Could not import "${file.name}"`, describeError(error));
      return false;
    }
  }

  async refreshAssets(options: { beforeEmit?: () => void } = {}): Promise<void> {
    if (!this.project) return;
    try {
      const { manifest, usage } = await this.client.listAssets(this.project.id);
      this.assets = manifest.assets;
      this.assetUsage = usage;
      this.assetResolver.setProject(this.project.id, manifest.assets);
    } catch (error) {
      this.log('error', 'Could not read the asset manifest', describeError(error));
      return;
    }
    options.beforeEmit?.();
    this.emit();
  }

  /**
   * Import dropped or chosen files one by one, so one bad file does not hide the rest and
   * every failure has its own message in the console.
   */
  async importFiles(files: Array<{ name: string; arrayBuffer(): Promise<ArrayBuffer>; type?: string }>): Promise<{ imported: number; failed: number }> {
    if (!this.project) return { imported: 0, failed: 0 };
    this.importing = true;
    this.emit();
    let imported = 0;
    let failed = 0;
    try {
      for (const file of files) {
        try {
          const bytes = await file.arrayBuffer();
          const result = await this.client.importAsset(this.project.id, { name: file.name, bytes, type: file.type });
          imported += 1;
          for (const warning of result.warnings) this.log('warning', `${result.entry.id}: ${warning}`);
          this.log('info', `Imported ${result.entry.kind} "${result.entry.id}" (${(result.entry.bytes / 1024).toFixed(0)} KiB)`);
        } catch (error) {
          failed += 1;
          this.log('error', `Could not import "${file.name}"`, describeError(error));
        }
      }
      await this.refreshAssets();
      return { imported, failed };
    } finally {
      this.importing = false;
      this.emit();
    }
  }

  /** Replace the bytes behind an asset id, keeping every scene reference intact. */
  async replaceAsset(assetId: string, file: { name: string; arrayBuffer(): Promise<ArrayBuffer>; type?: string }): Promise<boolean> {
    if (!this.project) return false;
    try {
      const bytes = await file.arrayBuffer();
      const result = await this.client.importAsset(this.project.id, { name: file.name, bytes, type: file.type }, { replaceAssetId: assetId });
      this.log('info', `Replaced "${assetId}" with ${file.name}`);
      for (const warning of result.warnings) this.log('warning', `${assetId}: ${warning}`);
      for (const key of Object.keys(this.thumbnails)) {
        if (key.startsWith(`${assetId}@`)) delete this.thumbnails[key];
      }
      await this.refreshAssets({
        beforeEmit: () => {
          for (const listener of this.assetReplacedListeners) listener(assetId);
        },
      });
      return true;
    } catch (error) {
      this.log('error', `Could not replace "${assetId}"`, describeError(error));
      return false;
    }
  }

  async deleteAsset(assetId: string): Promise<boolean> {
    if (!this.project) return false;
    try {
      await this.client.deleteAsset(this.project.id, assetId);
      this.log('info', `Removed "${assetId}" (the file is kept in the project's recovery folder)`);
      await this.refreshAssets();
      return true;
    } catch (error) {
      if (error instanceof WorkspaceClientError && error.code === 'asset-in-use') {
        this.log('warning', `Cannot remove "${assetId}"`, error.message);
      } else {
        this.log('error', `Could not remove "${assetId}"`, describeError(error));
      }
      return false;
    }
  }

  closeProject(): void {
    this.stopWatching();
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
      this.modelClips = {};
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

  selectMany(ids: string[], options: { additive?: boolean } = {}): void {
    this.selection.selectMany(ids, options);
  }

  setThumbnailRenderer(render: ((assetId: string) => Promise<string | null>) | null): void {
    this.thumbnailRenderer = render;
  }

  requestThumbnail(asset: AssetEntry): void {
    const key = `${asset.id}@${asset.hash}`;
    if (Object.hasOwn(this.thumbnails, key) || this.thumbnailRequests.has(key) || !this.thumbnailRenderer) return;
    this.thumbnailRequests.add(key);
    void this.thumbnailRenderer(asset.id)
      .then((result) => {
        this.thumbnails = { ...this.thumbnails, [key]: result ?? '' };
        this.emit();
      })
      .catch(() => {
        this.thumbnails = { ...this.thumbnails, [key]: '' };
        this.emit();
      })
      .finally(() => this.thumbnailRequests.delete(key));
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
        this.conflict = { message: error.message, expected: document.revision, actual: -1, source: 'save' };
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

/** Describe a caught failure. `cause` is whatever was thrown, so it has no narrower contract. */
export function describeError(cause: unknown): string {
  if (cause instanceof WorkspaceClientError) return `${cause.code}: ${cause.message}`;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
