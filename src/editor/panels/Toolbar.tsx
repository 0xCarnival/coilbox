import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { button, color, radius, space } from '../styles/tokens.stylex.js';
import { DOM, DOM_STATE, withDomClass } from '../dom-contract.js';
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

const TRANSFORM_TOOLS: TransformTool[] = ['translate', 'rotate', 'scale'];

/**
 * Toolbar chrome.
 *
 * `toolbar` and the transform-tool buttons deliberately do not carry a colour of their own where
 * `base.css` already styles the bare `button` element: the element rule and an atomic class would
 * fight over the same property, and the atomic class would win by specificity — silently changing
 * every button's padding. Overrides are limited to what the original classes actually declared.
 */
const styles = stylex.create({
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: space.sm,
    paddingInline: space.md,
    backgroundColor: color['panel-2'],
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: color.line,
    flexWrap: 'wrap',
  },
  group: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
  },
  spacer: {
    flex: 1,
  },

  projectName: {
    fontWeight: 600,
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    /**
     * The original class asked for `padding: 4px 6px`, but `button` in `base.css` declared
     * `padding: 4px 9px` at higher specificity and always won in practice. This keeps the rendered
     * result identical rather than the intent; changing it would be a redesign, not a migration.
     */
    paddingBlock: space.xs,
    paddingInline: '9px',
    ':hover': {
      borderColor: color.line,
    },
  },
  sceneName: {
    display: 'flex',
    /**
     * `.scene-name input { width: 150px }` targeted an element that is not a `stylex` class, so the
     * width moves onto the wrapper and the input is told to fill it.
     */
    width: '150px',
  },
  sceneNameInput: {
    width: '100%',
  },
  /** `.active` for the transform tools: the toolbar's own selected treatment. */
  toolActive: {
    backgroundColor: '#24314a',
    borderColor: color.accent,
  },
  snapToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    color: color.muted,
  },
  createMenu: {
    position: 'relative',
  },
  menu: {
    position: 'absolute',
    zIndex: 20,
    top: 'calc(100% + 4px)',
    left: 0,
    backgroundColor: color['panel-2'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.line,
    borderRadius: radius.lg,
    padding: space.xs,
    display: 'flex',
    flexDirection: 'column',
    minWidth: '170px',
    boxShadow: '0 12px 28px rgba(0, 0, 0, 0.45)',
  },
  /** `.menu button` — the menu owns its buttons' chrome, so this is an intentional button override. */
  menuButton: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    textAlign: 'left',
    borderRadius: radius.sm,
    paddingInline: space.sm,
    ':hover': {
      backgroundColor: '#212838',
    },
  },
  saveIndicator: {
    color: color.muted,
    minWidth: '108px',
  },
  saveDirty: {
    color: color.warn,
  },
  saveError: {
    color: color.danger,
  },
  saveFlash: {
    color: color.ok,
  },
  saveSaving: {
    color: color.muted,
  },
});

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
    <header {...stylex.props(styles.toolbar)}>
      <div {...withDomClass(styles.group, DOM.toolbarGroup)}>
        <button {...stylex.props(button.link)} type="button" onClick={() => session.closeProject()} title="Back to projects">
          ◀ Projects
        </button>
        <button
          {...stylex.props(styles.projectName)}
          type="button"
          title="Rename this project (the folder and id stay the same)"
          onClick={() => {
            const current = snapshot.project?.name ?? '';
            const next = globalThis.prompt('Project name', current);
            if (next && next !== current) void session.renameProject(next);
          }}
        >
          {snapshot.project?.name ?? 'No project'}
        </button>
        <span {...stylex.props(styles.sceneName)}>
          <input
            {...stylex.props(styles.sceneNameInput)}
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
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') setSceneNameDraft(null);
            }}
          />
        </span>
      </div>

      <div {...withDomClass(styles.group, DOM.toolbarGroup)}>
        <button type="button" onClick={() => void session.save()} disabled={!snapshot.dirty || editorLocked}>
          Save
        </button>
        <SaveIndicator state={snapshot.saveState} lastSavedAt={snapshot.lastSavedAt} />
      </div>

      <div {...withDomClass(styles.group, DOM.toolbarGroup)}>
        <button type="button" title="Undo" disabled={!snapshot.canUndo || editorLocked} onClick={() => session.undo()}>
          ↶
        </button>
        <button type="button" title="Redo" disabled={!snapshot.canRedo || editorLocked} onClick={() => session.redo()}>
          ↷
        </button>
      </div>

      <div {...withDomClass(styles.group, DOM.toolbarGroup)} role="group" aria-label="Transform tool">
        {TRANSFORM_TOOLS.map((candidate) => (
          <button
            key={candidate}
            {...withDomClass(tool === candidate && styles.toolActive, tool === candidate && DOM_STATE.active)}
            type="button"
            title={`${candidate} (${candidate === 'translate' ? 'W' : candidate === 'rotate' ? 'E' : 'R'})`}
            onClick={() => onToolChange(candidate)}
          >
            {candidate === 'translate' ? 'Move' : candidate === 'rotate' ? 'Rotate' : 'Scale'}
          </button>
        ))}
        <label {...withDomClass(styles.snapToggle, DOM.snapToggle)} title="Snap transforms to the grid">
          <input
            type="checkbox"
            checked={snap.enabled}
            onChange={(event) => onSnapChange({ ...snap, enabled: event.target.checked })}
          />
          Snap
        </label>
      </div>

      <div {...withDomClass(styles.group, DOM.toolbarGroup)}>
        <div {...stylex.props(styles.createMenu)}>
          <button type="button" disabled={editorLocked || !scene} onClick={() => setCreateOpen((open) => !open)}>
            + Create
          </button>
          {createOpen && (
            <div {...withDomClass(styles.menu, DOM.menu)}>
              {CREATABLE_KINDS.map((kind: CreatableKind) => (
                <button
                  key={kind}
                  {...stylex.props(styles.menuButton)}
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

      <span {...withDomClass(styles.spacer, DOM.toolbarSpacer)} />

      <div {...withDomClass(styles.group, DOM.toolbarGroup)} role="group" aria-label="Playback">
        {playState === 'stopped' ? (
          <button {...stylex.props(button.primary)} type="button" onClick={() => void viewport.current?.play()}>
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

      <div {...withDomClass(styles.group, DOM.toolbarGroup)}>
        <button
          type="button"
          title="Store the current view as this project's thumbnail"
          disabled={editorLocked}
          onClick={() => {
            const dataUrl = viewport.current?.captureThumbnail();
            if (!dataUrl) return;
            void session.setThumbnail(dataUrlToBytes(dataUrl));
          }}
        >
          Set thumbnail
        </button>
      </div>

      <div {...withDomClass(styles.group, DOM.toolbarGroup)}>
        <button type="button" disabled={editorLocked || exporting} onClick={onExport}>
          {exporting ? 'Exporting…' : 'Export Game'}
        </button>
      </div>
    </header>
  );
}

/** Decode a canvas data URL into bytes for the thumbnail upload. */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
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
    <span
      {...withDomClass(
        styles.saveIndicator,
        state === 'dirty' && styles.saveDirty,
        state === 'error' && styles.saveError,
        state === 'saving' && styles.saveSaving,
        flash && styles.saveFlash,
        DOM.saveIndicator,
        // The state word rides along as a class as well as an attribute: `data-save-state` is what the
        // gates read, and `.save-indicator.dirty` is what a person reads in devtools. The flash class
        // is included so the just-saved colour is inspectable for the 1.2s it is on screen.
        state,
        flash && 'flash',
      )}
      data-save-state={state}
    >
      {label}
    </span>
  );
}
