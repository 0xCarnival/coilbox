import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseScene, type SceneDocument } from '@schema/index.js';
import { PROJECT_FILES, Workspace } from './workspace.js';

/**
 * External file watching (plan §11).
 *
 * "Watch external file changes. Debounce incomplete writes, validate before loading, and
 * preserve the last known-good in-memory document if the new file is invalid. When local edits
 * conflict with an external revision, show a conflict rather than silently overwriting either
 * version."
 *
 * This module owns exactly that policy: it debounces, validates, and reports. It never writes
 * anything and never replaces what the editor holds — the editor decides.
 */

export type SceneChangeKind =
  | 'scene-updated'
  | 'scene-created'
  | 'scene-removed'
  | 'invalid'
  | 'assets-changed'
  | 'registry-changed';

export interface SceneChangeEvent {
  kind: SceneChangeKind;
  projectId: string;
  sceneId: string | null;
  /** Path relative to the project root. */
  path: string;
  /** Revision read from the new file, when it was valid. */
  revision: number | null;
  /** Validation message for `invalid`. */
  message?: string;
  at: string;
}

export interface WatcherOptions {
  workspace: Workspace;
  projectId: string;
  /** Milliseconds of quiet before a write is considered complete. */
  debounceMs?: number;
  onEvent: (event: SceneChangeEvent) => void;
}

interface WatchedScene {
  id: string;
  path: string;
}

export class ProjectWatcher {
  private watcher: FSWatcher | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly scenes = new Map<string, WatchedScene>();
  private closed = false;

  constructor(private readonly options: WatcherOptions) {}

  private get debounceMs(): number {
    return this.options.debounceMs ?? 250;
  }

  async start(): Promise<void> {
    const project = await this.options.workspace.readProject(this.options.projectId);
    const projectRoot = await this.options.workspace.projectRoot(this.options.projectId);
    for (const scene of project.scenes) this.scenes.set(scene.path, { id: scene.id, path: scene.path });

    // `fs.watch` on the project root with recursive mode is supported on macOS and Windows; on
    // other platforms this degrades to watching the scenes folder, which is what changes most.
    try {
      this.watcher = watch(projectRoot, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) return;
        this.schedule(projectRoot, filename.toString());
      });
    } catch {
      this.watcher = watch(join(projectRoot, 'scenes'), { persistent: false }, (_event, filename) => {
        if (!filename) return;
        this.schedule(projectRoot, join('scenes', filename.toString()));
      });
    }
    this.watcher.on('error', () => {
      // A watcher error must not take the service down; the editor can still reload manually.
      this.options.onEvent({
        kind: 'invalid',
        projectId: this.options.projectId,
        sceneId: null,
        path: '',
        revision: null,
        message: 'the file watcher stopped; reload the scene manually to pick up external changes',
        at: new Date().toISOString(),
      });
    });
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.watcher?.close();
    this.watcher = null;
  }

  /** Debounce per path: editors write in several steps, and half a file must never be read. */
  private schedule(projectRoot: string, relativePath: string): void {
    if (this.closed) return;
    const normalized = relativePath.split('\\').join('/');
    if (normalized.includes('.coilbox/') || normalized.startsWith('.')) return;
    const existing = this.timers.get(normalized);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(normalized);
      void this.handleChange(projectRoot, normalized);
    }, this.debounceMs);
    this.timers.set(normalized, timer);
  }

  private async handleChange(projectRoot: string, relativePath: string): Promise<void> {
    if (this.closed) return;
    const scene = this.scenes.get(relativePath);
    if (!scene) {
      if (relativePath.startsWith('assets/') || relativePath.endsWith(PROJECT_FILES.assetManifest)) {
        this.emit({ kind: 'assets-changed', projectId: this.options.projectId, sceneId: null, path: relativePath, revision: null });
        return;
      }
      // A changed behavior registry means the preview should be rebuilt rather than migrated:
      // behavior code and its metadata are a build-time contract, not live state.
      if (relativePath.endsWith(PROJECT_FILES.behaviorRegistry)) {
        this.emit({ kind: 'registry-changed', projectId: this.options.projectId, sceneId: null, path: relativePath, revision: null });
      }
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(projectRoot, relativePath), 'utf8'));
    } catch (cause) {
      this.emit({
        kind: 'invalid',
        projectId: this.options.projectId,
        sceneId: scene.id,
        path: relativePath,
        revision: null,
        message: `the file on disk is not valid JSON (${String(cause)}); the editor keeps its last known-good document`,
      });
      return;
    }

    const parsed = parseScene(raw);
    if (!parsed.value) {
      this.emit({
        kind: 'invalid',
        projectId: this.options.projectId,
        sceneId: scene.id,
        path: relativePath,
        revision: null,
        message: `the file on disk is not a valid scene (${parsed.issues.map((issue) => issue.message).join('; ')}); the editor keeps its last known-good document`,
      });
      return;
    }

    const document_: SceneDocument = parsed.value;
    this.emit({
      kind: 'scene-updated',
      projectId: this.options.projectId,
      sceneId: scene.id,
      path: relativePath,
      revision: document_.revision,
    });
  }

  private emit(event: Omit<SceneChangeEvent, 'at'>): void {
    this.options.onEvent({ ...event, at: new Date().toISOString() });
  }
}
