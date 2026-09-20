import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import {
  ArrowLeft,
  ChevronDown,
  Download,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Redo2,
  Save,
  Square,
  StepForward,
  Undo2,
} from 'lucide-react';
import { color, control, controlSize, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { DOM, DOM_STATE, withDomClass } from '../dom-contract.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import type { TransformSpace, TransformTool } from '../viewport/viewport-controller.js';
import type { PlayState, ViewportHandle } from './Viewport.js';
import type { SnapSettings } from '../viewport/viewport-controller.js';
import { createEntity, CREATABLE_KINDS, CREATABLE_LABELS, type CreatableKind } from '../document/factory.js';
import { Button, IconButton } from '../ui/Button.js';
import { AppearanceMenu } from '../ui/AppearanceMenu.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../ui/Menu.js';

/**
 * Top toolbar (plan §3).
 *
 * ## Structure, from the reference editor
 *
 * One 48px band with a hairline under it: document identity on the left, the tool cluster in the
 * middle, the primary action on the right. The reference has no grouped sub-bars and no status text
 * inside the control row, and its controls are icon-only wherever the glyph is unambiguous.
 *
 * Three changes do most of the work here:
 *
 * - **Icon-only transport, undo/redo, and export.** The reference leans on `lucide-react` glyphs
 *   with a tooltip instead of labels, which is what lets one row carry this many actions without
 *   becoming a wall of text. Each keeps an accessible name through `IconButton`.
 * - **Menus are real menus.** Create and the overflow are Radix dropdowns, so they close on Escape,
 *   on an outside click, and on selection. The previous hand-rolled popover stayed open until its
 *   own trigger was pressed a second time.
 * - **No status text in the row.** The save state lives in the status bar; a report sitting between
 *   two buttons reads as a third button.
 */

const TRANSFORM_TOOLS: TransformTool[] = ['translate', 'rotate', 'scale'];

const TOOL_LABELS: Record<TransformTool, string> = {
  translate: 'Move',
  rotate: 'Rotate',
  scale: 'Scale',
};

const TOOL_KEYS: Record<TransformTool, string> = {
  translate: 'G',
  rotate: 'R',
  scale: 'S',
};

const styles = stylex.create({
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    height: '48px',
    paddingInline: space.lg,
    backgroundColor: color.bg,
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: color.border,
    flexShrink: 0,
  },
  group: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    minWidth: 0,
  },
  spacer: {
    flex: 1,
  },
  /** A vertical rule between clusters, inset from the row's edges so it reads as a divider. */
  divider: {
    width: '1px',
    alignSelf: 'stretch',
    marginBlock: space.md,
    marginInline: space.xs,
    backgroundColor: color.border,
    flexShrink: 0,
  },

  /**
   * The document name is the one piece of text in the row that is not a control label: it is what
   * you are editing. It stays a button because clicking it renames, but it reads as a title.
   */
  docName: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    height: controlSize.xs,
    paddingInline: space.md,
    borderRadius: radius.md,
    color: color.text,
    fontSize: fontSize.md,
    fontWeight: 600,
    maxWidth: '240px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    cursor: 'pointer',
    ':hover': {
      backgroundColor: color.wash,
    },
  },
  /** The scene name is a quieter, secondary identity beside the project. */
  sceneName: {
    width: '150px',
    height: controlSize.xs,
    fontSize: fontSize.xs,
    color: color.muted,
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    ':hover': {
      borderColor: color.border,
    },
  },

  /** The active tool: a filled neutral chip, the same treatment the reference's tab bar uses. */
  toolActive: {
    backgroundColor: color.surface,
    color: color.text,
  },
  toolButton: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    height: controlSize.xs,
    paddingInline: space.md,
    borderRadius: radius.md,
    color: color.muted,
    fontSize: fontSize.xs,
    fontWeight: 500,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    cursor: 'pointer',
    ':hover': {
      color: color.text,
      backgroundColor: color.wash,
    },
  },
  snapToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    height: controlSize.xs,
    paddingInline: space.md,
    borderRadius: radius.md,
    color: color.muted,
    fontSize: fontSize.xs,
    cursor: 'pointer',
    ':hover': {
      color: color.text,
      backgroundColor: color.wash,
    },
  },
  playButton: {
    paddingInline: space.lg,
  },
});

export interface ToolbarProps {
  viewport: React.RefObject<ViewportHandle | null>;
  playState: PlayState;
  tool: TransformTool;
  space: TransformSpace;
  snap: SnapSettings;
  onToolChange(tool: TransformTool): void;
  onSpaceChange(space: TransformSpace): void;
  onSnapChange(snap: SnapSettings): void;
  onExport(target: ExportTarget): void;
  exporting: boolean;
}

/** Where an export goes: the project's export folder, or that folder zipped into a download. */
export type ExportTarget = 'folder' | 'download';

export function Toolbar({
  viewport,
  playState,
  tool,
  space,
  snap,
  onToolChange,
  onSpaceChange,
  onSnapChange,
  onExport,
  exporting,
}: ToolbarProps): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const [sceneNameDraft, setSceneNameDraft] = useState<string | null>(null);
  const editorLocked = playState !== 'stopped';
  const scene = session.scene;

  return (
    <header {...stylex.props(styles.toolbar)}>
      <div {...withDomClass(styles.group, DOM.toolbarGroup)} aria-label="Project">
        <IconButton label="Back to projects" onClick={() => session.closeProject()}>
          <ArrowLeft size={control.icon} />
        </IconButton>
        <button
          {...stylex.props(styles.docName)}
          type="button"
          title="Rename this project (the folder and id stay the same)"
          onClick={() => {
            const current = snapshot.project?.name ?? '';
            const next = globalThis.prompt('Project name', current);
            if (next && next !== current) void session.renameProject(next);
          }}
        >
          {snapshot.project?.name ?? 'No project'}
          <ChevronDown size={control.iconSm} />
        </button>
        <span {...stylex.props(styles.divider)} />
        <input
          {...stylex.props(styles.sceneName)}
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
      </div>

      <span {...stylex.props(styles.divider)} />

      <div {...withDomClass(styles.group, DOM.toolbarGroup)} aria-label="Document">
        <IconButton label="Save" disabled={!snapshot.dirty || editorLocked} onClick={() => void session.save()}>
          <Save size={control.icon} />
        </IconButton>
        <IconButton label="Undo" disabled={!snapshot.canUndo || editorLocked} onClick={() => session.undo()}>
          <Undo2 size={control.icon} />
        </IconButton>
        <IconButton label="Redo" disabled={!snapshot.canRedo || editorLocked} onClick={() => session.redo()}>
          <Redo2 size={control.icon} />
        </IconButton>
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
            title={`${TOOL_LABELS[candidate]} (${TOOL_KEYS[candidate]})`}
            aria-pressed={tool === candidate}
            onClick={() => onToolChange(candidate)}
          >
            {TOOL_LABELS[candidate]}
          </button>
        ))}
        <button
          {...withDomClass(styles.toolButton, space === 'local' && styles.toolActive, space === 'local' && DOM_STATE.active)}
          type="button"
          title={
            space === 'world'
              ? 'Gizmo axes follow the world (L switches to the object’s own axes)'
              : 'Gizmo axes follow the selected object (L switches back to the world)'
          }
          aria-label="Transform space"
          aria-pressed={space === 'local'}
          onClick={() => onSpaceChange(space === 'world' ? 'local' : 'world')}
        >
          {space === 'world' ? 'World' : 'Local'}
        </button>
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button disabled={editorLocked || !scene}>
              <Plus size={control.icon} />
              Create
              <ChevronDown size={control.iconSm} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent wide align="start" hooks={[DOM.menu]}>
            <DropdownMenuLabel>Add to scene</DropdownMenuLabel>
            {CREATABLE_KINDS.map((kind: CreatableKind) => (
              <DropdownMenuItem
                key={kind}
                onSelect={() => {
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
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <span {...withDomClass(styles.spacer, DOM.toolbarSpacer)} />

      <div {...withDomClass(styles.group, DOM.toolbarGroup)} role="group" aria-label="Playback">
        {playState === 'stopped' || playState === 'starting' ? (
          <Button
            variant="primary"
            disabled={playState === 'starting'}
            onClick={() => void viewport.current?.play()}
          >
            <Play size={control.icon} />
            {playState === 'starting' ? 'Starting…' : 'Play'}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => viewport.current?.pause()}>
            {playState === 'paused' ? <Play size={control.icon} /> : <Pause size={control.icon} />}
            {playState === 'paused' ? 'Resume' : 'Pause'}
          </Button>
        )}
        <IconButton
          label="Step one frame"
          disabled={playState !== 'paused'}
          onClick={() => viewport.current?.step()}
        >
          <StepForward size={control.icon} />
        </IconButton>
        <IconButton
          label="Stop and discard the simulation"
          disabled={playState === 'stopped' || playState === 'starting'}
          onClick={() => viewport.current?.stop()}
        >
          <Square size={control.icon} />
        </IconButton>
      </div>

      <span {...stylex.props(styles.divider)} />

      <div {...withDomClass(styles.group, DOM.toolbarGroup)}>
        <AppearanceMenu />
        <IconButton label="Export Game" disabled={editorLocked || exporting} onClick={() => onExport('folder')}>
          <Download size={control.icon} />
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label="More actions">
              <MoreHorizontal size={control.icon} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" hooks={[DOM.menu]}>
            <DropdownMenuItem disabled={editorLocked || exporting} onSelect={() => onExport('download')}>
              Download game as .zip
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={editorLocked}
              onSelect={() => {
                const dataUrl = viewport.current?.captureThumbnail();
                if (!dataUrl) return;
                void session.setThumbnail(dataUrlToBytes(dataUrl));
              }}
            >
              Set thumbnail
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
    color: color.muted,
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
    color: color.muted,
  },
  flash: {
    color: color.ok,
  },
});

/**
 * The save state, rendered by the shell in the status bar.
 *
 * It reports rather than acts, which is why it is not a button: the previous arrangement put
 * "Saved" immediately after Save in the toolbar, where it read as a second, disabled Save.
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
