import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { button, color, fontSize, radius, space, surface } from '../styles/tokens.stylex.js';
import { DOM, DOM_STATE, withDomClass } from '../dom-contract.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import type { TransformTool } from '../viewport/viewport-controller.js';
import type { PlayState, ViewportHandle } from './Viewport.js';
import type { SnapSettings } from '../viewport/viewport-controller.js';
import { createEntity, CREATABLE_KINDS, CREATABLE_LABELS, type CreatableKind } from '../document/factory.js';
import {
  IconBack,
  IconCameraCapture,
  IconExport,
  IconHistory,
  IconMore,
  IconPause,
  IconPlay,
  IconPlus,
  IconStep,
  IconStop,
} from './icons.js';

/**
 * Top toolbar (plan §3): project and scene identity, Save, undo/redo, transform tools, snap,
 * Play/Pause/Step/Stop, and Export Game.
 *
 * It also holds the creation menu. The save *state* is rendered by the shell in the status bar
 * instead of here, because a status word sitting inside a control row reads as a button — that is
 * exactly how the old "Saved" label next to Save was being read.
 *
 * ## Structure
 *
 * Controls are clustered by what they act on, and clusters are separated by a hairline plus more
 * space than the gap inside a cluster. The previous toolbar was nine equally-spaced children in one
 * row, so "Play" and "Set thumbnail" carried the same visual rank. Proximity is the whole hierarchy
 * here: there is no border or band, only which controls sit near each other.
 *
 * Rare actions live behind the overflow rather than competing for width. `Set thumbnail` was the
 * clearest case — a once-per-project action that held permanent toolbar space.
 */

const TRANSFORM_TOOLS: TransformTool[] = ['translate', 'rotate', 'scale'];

/**
 * Toolbar chrome.
 *
 * The toolbar and its buttons deliberately carry no colour of their own where the bare `button`
 * element rule already styles them: the element rule and an atomic class would fight over the same
 * property, and the atomic class would win by specificity — silently changing every button's
 * padding. Overrides are limited to what a cluster actually needs.
 */
const styles = stylex.create({
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    paddingBlock: space.sm,
    paddingInline: space.md,
    backgroundColor: color['panel-2'],
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: color.line,
    minHeight: '46px',
  },
  group: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xxs,
    minWidth: 0,
  },
  /**
   * The cluster divider: a 1px rule with an inset block, not a full-height border, so it groups
   * without drawing a box around anything.
   */
  divider: {
    width: '1px',
    alignSelf: 'stretch',
    marginBlock: space.xs,
    marginInline: space.xxs,
    backgroundColor: color.line,
    flexShrink: 0,
  },
  spacer: {
    flex: 1,
  },

  /** Identity: the project is a place you are in, so its name is a label rather than a field. */
  identity: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minWidth: 0,
  },
  backButton: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    color: color.muted,
    paddingInline: space.sm,
  },
  /**
   * The project name's own geometry. The "quiet until hovered" treatment is `button.ghost`,
   * composed at the call site rather than spread here: StyleX cannot reference a style from inside
   * another `stylex.create` block — it fails the compile with "Rule contains an unclosed function",
   * which names neither the file's cause nor the offending property.
   */
  projectName: {
    fontWeight: 600,
    maxWidth: '220px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    paddingBlock: space.xs,
    paddingInline: space.sm,
    ':hover': {
      backgroundColor: color.wash,
    },
  },
  sceneName: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    color: color.dim,
  },
  sceneNameInput: {
    width: '132px',
    color: color.muted,
    fontWeight: 500,
  },
  /** A quiet icon-only control: undo, redo, and the overflow. */
  iconButton: {
    display: 'grid',
    placeItems: 'center',
    width: '28px',
    height: '28px',
    paddingInline: 0,
    color: color.muted,
    ':hover': {
      color: color.text,
    },
  },
  /** The toolbar's own selected treatment, now in the accent rather than a blue fill. */
  toolActive: {
    backgroundColor: color['accent-quiet'],
    color: color.accent,
    fontWeight: 600,
  },
  toolButton: {
    paddingInline: space.sm,
  },
  snapToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    color: color.muted,
    fontSize: fontSize.sm,
    paddingInline: space.xs,
    cursor: 'pointer',
  },
  menuHost: {
    position: 'relative',
  },
  menuTrigger: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
  },
  /**
   * The position on this layer is the toolbar's own; the surface, radius, and shadow come from
   * `surface.menu`, which is spread at the call site. Splitting them this way is deliberate: the
   * surface is shared with the add-component menu, the placement is not.
   */
  menuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    textAlign: 'left',
    borderRadius: radius.md,
    paddingBlock: space.sm,
    paddingInline: space.sm,
    color: color.text,
    ':hover': {
      backgroundColor: color.wash,
    },
  },
  menuPlacement: {
    position: 'absolute',
    zIndex: 20,
    top: 'calc(100% + 6px)',
    left: 0,
  },
  menuPlacementEnd: {
    left: 'auto',
    right: 0,
  },
  playback: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
  },
  /** Play is the one filled control in the toolbar; see `button.primary`. */
  playButton: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    paddingInline: space.md,
  },
  transportButton: {
    display: 'grid',
    placeItems: 'center',
    width: '28px',
    height: '28px',
    paddingInline: 0,
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [sceneNameDraft, setSceneNameDraft] = useState<string | null>(null);
  const editorLocked = playState !== 'stopped';
  const scene = session.scene;

  return (
    <header {...stylex.props(styles.toolbar)}>
      <div {...withDomClass(styles.identity, DOM.toolbarGroup)} aria-label="Project">
        <button
          {...stylex.props(button.link, styles.backButton)}
          type="button"
          onClick={() => session.closeProject()}
          title="Back to projects"
        >
          <IconBack size={13} />
          Projects
        </button>
        <span {...stylex.props(styles.divider)} />
        <button
          {...stylex.props(button.ghost, styles.projectName)}
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
        <span {...stylex.props(styles.divider)} />
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

      <span {...stylex.props(styles.divider)} />

      <div {...withDomClass(styles.group, DOM.toolbarGroup)} aria-label="Document">
        <button type="button" onClick={() => void session.save()} disabled={!snapshot.dirty || editorLocked}>
          Save
        </button>
        <button
          {...stylex.props(styles.iconButton)}
          type="button"
          title="Undo"
          aria-label="Undo"
          disabled={!snapshot.canUndo || editorLocked}
          onClick={() => session.undo()}
        >
          <IconHistory direction="undo" />
        </button>
        <button
          {...stylex.props(styles.iconButton)}
          type="button"
          title="Redo"
          aria-label="Redo"
          disabled={!snapshot.canRedo || editorLocked}
          onClick={() => session.redo()}
        >
          <IconHistory direction="redo" />
        </button>
      </div>

      <span {...stylex.props(styles.divider)} />

      <div {...withDomClass(styles.group, DOM.toolbarGroup)} role="group" aria-label="Transform tool">
        {TRANSFORM_TOOLS.map((candidate) => (
          <button
            key={candidate}
            {...withDomClass(
              styles.toolButton,
              tool === candidate && styles.toolActive,
              tool === candidate && DOM_STATE.active,
            )}
            type="button"
            title={`${candidate} (${candidate === 'translate' ? 'W' : candidate === 'rotate' ? 'E' : 'R'})`}
            aria-pressed={tool === candidate}
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

      <span {...stylex.props(styles.divider)} />

      <div {...withDomClass(styles.group, DOM.toolbarGroup)}>
        <div {...stylex.props(styles.menuHost)}>
          <button
            {...stylex.props(styles.menuTrigger)}
            type="button"
            disabled={editorLocked || !scene}
            aria-expanded={createOpen}
            onClick={() => setCreateOpen((open) => !open)}
          >
            <IconPlus />
            Create
          </button>
          {createOpen && (
            <div {...withDomClass(surface.menu, styles.menuPlacement, DOM.menu)}>
              <span {...stylex.props(surface.microLabel)}>Add to scene</span>
              {CREATABLE_KINDS.map((kind: CreatableKind) => (
                <button
                  key={kind}
                  {...stylex.props(styles.menuItem)}
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

      <div {...withDomClass(styles.playback, DOM.toolbarGroup)} role="group" aria-label="Playback">
        {playState === 'stopped' ? (
          <button
            {...stylex.props(button.primary, styles.playButton)}
            type="button"
            onClick={() => void viewport.current?.play()}
          >
            <IconPlay />
            Play
          </button>
        ) : (
          <button
            {...stylex.props(button.primary, styles.playButton)}
            type="button"
            onClick={() => viewport.current?.pause()}
          >
            {playState === 'paused' ? <IconPlay /> : <IconPause />}
            {playState === 'paused' ? 'Resume' : 'Pause'}
          </button>
        )}
        <button
          {...stylex.props(styles.transportButton)}
          type="button"
          title="Step one frame"
          disabled={playState !== 'paused'}
          onClick={() => viewport.current?.step()}
        >
          <IconStep />
          <span className="visually-hidden">Step</span>
        </button>
        <button
          {...stylex.props(styles.transportButton)}
          type="button"
          title="Stop and discard the simulation"
          disabled={playState === 'stopped'}
          onClick={() => viewport.current?.stop()}
        >
          <IconStop />
          <span className="visually-hidden">Stop</span>
        </button>
      </div>

      <span {...stylex.props(styles.divider)} />

      <div {...withDomClass(styles.group, DOM.toolbarGroup)}>
        <button
          {...stylex.props(styles.menuTrigger)}
          type="button"
          disabled={editorLocked || exporting}
          onClick={onExport}
        >
          <IconExport />
          {exporting ? 'Exporting…' : 'Export'}
        </button>
        <div {...stylex.props(styles.menuHost)}>
          <button
            {...stylex.props(styles.iconButton)}
            type="button"
            title="More actions"
            aria-label="More actions"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <IconMore />
          </button>
          {moreOpen && (
            <div {...withDomClass(surface.menu, styles.menuPlacement, styles.menuPlacementEnd, DOM.menu)}>
              <button
                {...stylex.props(styles.menuItem)}
                type="button"
                disabled={editorLocked}
                onClick={() => {
                  setMoreOpen(false);
                  const dataUrl = viewport.current?.captureThumbnail();
                  if (!dataUrl) return;
                  void session.setThumbnail(dataUrlToBytes(dataUrl));
                }}
              >
                <IconCameraCapture />
                Set thumbnail
              </button>
            </div>
          )}
        </div>
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

const saveStyles = stylex.create({
  indicator: {
    color: color.dim,
    fontSize: fontSize.xs,
    fontVariantNumeric: 'tabular-nums',
  },
  dirty: {
    color: color.warn,
  },
  error: {
    color: color.danger,
  },
  saving: {
    color: color.dim,
  },
  flash: {
    color: color.ok,
  },
});

/**
 * The save state, rendered by the shell in the status bar.
 *
 * It reports rather than acts, which is why it is not a button: the previous arrangement put
 * "Saved" / "Unsaved changes" immediately after Save, where it read as a second, disabled Save.
 */
export function SaveIndicator({ state, lastSavedAt }: { state: string; lastSavedAt: string | null }): JSX.Element {
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
        saveStyles.indicator,
        state === 'dirty' && saveStyles.dirty,
        state === 'error' && saveStyles.error,
        state === 'saving' && saveStyles.saving,
        flash && saveStyles.flash,
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
