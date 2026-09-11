import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useSession, useSessionSnapshot } from '../hooks.js';
import type { TransformTool } from '../viewport/viewport-controller.js';
import type { PlayState, ViewportHandle } from './Viewport.js';
import type { SnapSettings } from '../viewport/viewport-controller.js';
import { createEntity, CREATABLE_KINDS, CREATABLE_LABELS, type CreatableKind } from '../document/factory.js';

/**
 * Top toolbar (plan §3): project and scene name, Save, undo/redo, transform tools, snap,
 * Play/Pause/Step/Stop, and Export Game.
 *
 * It also holds the creation menu and reflects the save state, which only ever reads
 * "Saved" after the workspace service acknowledges a write.
 */

export interface ToolbarProps {
  viewport: React.RefObject<ViewportHandle | null>;
  playState: PlayState;
  tool: TransformTool;
  snap: SnapSettings;
  onToolChange(tool: TransformTool): void;
  onSnapChange(snap: SnapSettings): void;
  onExport(): void;
  exporting: boolean;
}

export function Toolbar({
  viewport,
  playState,
  tool,
  snap,
  onToolChange,
  onSnapChange,
  onExport,
  exporting,
}: ToolbarProps): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const [createOpen, setCreateOpen] = useState(false);
  const [sceneNameDraft, setSceneNameDraft] = useState<string | null>(null);
  const editorLocked = playState !== 'stopped';
  const scene = session.scene;

  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <button type="button" className="link" onClick={() => session.closeProject()} title="Back to projects">
          ◀ Projects
        </button>
        <span className="project-name">{snapshot.project?.name ?? 'No project'}</span>
        <span className="scene-name">
          <input
            value={sceneNameDraft ?? scene?.name ?? ''}
            disabled={editorLocked || !scene}
            aria-label="Scene name"
            onChange={(event) => setSceneNameDraft(event.target.value)}
            onBlur={() => {
              if (sceneNameDraft !== null && scene && sceneNameDraft !== scene.name) {
                session.execute({ kind: 'setSceneName', name: sceneNameDraft });
              }
              setSceneNameDraft(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
              if (event.key === 'Escape') setSceneNameDraft(null);
            }}
          />
        </span>
      </div>

      <div className="toolbar-group">
        <button type="button" onClick={() => void session.save()} disabled={!snapshot.dirty || editorLocked}>
          Save
        </button>
        <SaveIndicator state={snapshot.saveState} lastSavedAt={snapshot.lastSavedAt} />
      </div>

      <div className="toolbar-group">
        <button type="button" title="Undo" disabled={!snapshot.canUndo || editorLocked} onClick={() => session.undo()}>
          ↶
        </button>
        <button type="button" title="Redo" disabled={!snapshot.canRedo || editorLocked} onClick={() => session.redo()}>
          ↷
        </button>
      </div>

      <div className="toolbar-group" role="group" aria-label="Transform tool">
        {(['translate', 'rotate', 'scale'] as TransformTool[]).map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={tool === candidate ? 'active' : ''}
            title={`${candidate} (${candidate === 'translate' ? 'W' : candidate === 'rotate' ? 'E' : 'R'})`}
            onClick={() => onToolChange(candidate)}
          >
            {candidate === 'translate' ? 'Move' : candidate === 'rotate' ? 'Rotate' : 'Scale'}
          </button>
        ))}
        <label className="snap-toggle" title="Snap transforms to the grid">
          <input
            type="checkbox"
            checked={snap.enabled}
            onChange={(event) => onSnapChange({ ...snap, enabled: event.target.checked })}
          />
          Snap
        </label>
      </div>

      <div className="toolbar-group">
        <div className="create-menu">
          <button type="button" disabled={editorLocked || !scene} onClick={() => setCreateOpen((open) => !open)}>
            + Create
          </button>
          {createOpen && (
            <div className="menu">
              {CREATABLE_KINDS.map((kind: CreatableKind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    setCreateOpen(false);
                    if (!scene) return;
                    const used = scene.entities.map((candidate) => candidate.id);
                    const siblings = scene.entities.filter((candidate) => candidate.parentId === null);
                    const entity = createEntity(kind, {
                      usedIds: used,
                      order: siblings.length,
                      position: [0, kind === 'plane' ? 0 : 1, 0],
                    });
                    if (session.execute({ kind: 'insertEntities', entities: [entity] })) session.select(entity.id);
                  }}
                >
                  {CREATABLE_LABELS[kind]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-group" role="group" aria-label="Playback">
        {playState === 'stopped' ? (
          <button type="button" className="primary" onClick={() => void viewport.current?.play()}>
            ▶ Play
          </button>
        ) : (
          <button type="button" onClick={() => viewport.current?.pause()}>
            {playState === 'paused' ? '▶ Resume' : '⏸ Pause'}
          </button>
        )}
        <button type="button" disabled={playState !== 'paused'} onClick={() => viewport.current?.step()}>
          Step
        </button>
        <button type="button" disabled={playState === 'stopped'} onClick={() => viewport.current?.stop()}>
          ■ Stop
        </button>
      </div>

      <div className="toolbar-group">
        <button type="button" disabled={editorLocked || exporting} onClick={onExport}>
          {exporting ? 'Exporting…' : 'Export Game'}
        </button>
      </div>
    </header>
  );
}

function SaveIndicator({ state, lastSavedAt }: { state: string; lastSavedAt: string | null }): JSX.Element {
  const [flash, setFlash] = useState(false);
  const previous = useRef(state);
  useEffect(() => {
    if (previous.current !== 'clean' && state === 'clean') {
      setFlash(true);
      const handle = setTimeout(() => setFlash(false), 1200);
      return () => clearTimeout(handle);
    }
    previous.current = state;
    return undefined;
  }, [state]);

  const label =
    state === 'clean'
      ? lastSavedAt
        ? `Saved ${new Date(lastSavedAt).toLocaleTimeString()}`
        : 'Saved'
      : state === 'dirty'
        ? 'Unsaved changes'
        : state === 'saving'
          ? 'Saving…'
          : 'Save failed';
  return (
    <span className={`save-indicator ${state}${flash ? ' flash' : ''}`} data-save-state={state}>
      {label}
    </span>
  );
}
