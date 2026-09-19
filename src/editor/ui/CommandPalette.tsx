import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import { createEntity, CREATABLE_KINDS, CREATABLE_LABELS, type CreatableKind } from '../document/factory.js';
import { duplicateEntities } from '../document/duplicate.js';
import { color, control, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import type { TransformTool, ViewFace } from '../viewport/viewport-controller.js';

/**
 * The command palette.
 *
 * The reference has one, and it is the piece of chrome that scales: a menu bar runs out of room and
 * a keyboard shortcut set is invisible unless you already know it, but one list that is searchable
 * covers every action the editor has and teaches the shortcuts as it shows them.
 *
 * ## One registry, not a list beside the UI
 *
 * Every action is declared once in `buildActions`, with its label, its group, its shortcut, and what
 * it runs. The dock and the toolbar deliberately do *not* read from it — they are hand-placed
 * surfaces with their own affordances — so this is a third entry point to the same session methods,
 * and the reason it is declarative is that a palette is only useful if it is complete. Adding an
 * action to the editor and forgetting to add it here is the failure mode, and a single array is
 * where that omission is visible.
 *
 * ## Keyboard behaviour
 *
 * Ctrl/Cmd+K opens it from anywhere. Arrow keys move, Enter runs, Escape closes. The list is a
 * `listbox` with an `aria-activedescendant`, which is what lets the input keep focus while the
 * active row moves — a palette that moves focus into the list loses the caret and cannot be typed in.
 */

const styles = stylex.create({
  overlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    backdropFilter: 'blur(2px)',
    zIndex: 100,
    animationName: 'coilbox-menu-in',
    animationDuration: '120ms',
    animationTimingFunction: 'ease-out',
    animationFillMode: 'both',
  },
  content: {
    position: 'fixed',
    top: '18%',
    left: '50%',
    transform: 'translateX(-50%)',
    width: '560px',
    maxWidth: 'calc(100vw - 32px)',
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '60vh',
    borderRadius: radius.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.border,
    backgroundColor: color.elevated,
    boxShadow: '0 24px 60px rgba(0, 0, 0, 0.6)',
    zIndex: 101,
    overflow: 'hidden',
  },
  searchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    paddingInline: space.lg,
    height: '48px',
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: color.border,
    flexShrink: 0,
    color: color.dim,
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    paddingInline: 0,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    color: color.text,
    fontSize: fontSize.md,
    ':hover': { borderWidth: 0, borderColor: 'transparent' },
    ':focus': { outline: 'none', borderColor: 'transparent' },
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    padding: space.xs,
    overflowY: 'auto',
    minHeight: 0,
  },
  groupLabel: {
    paddingBlock: space.sm,
    paddingInline: space.md,
    fontSize: fontSize.micro,
    fontWeight: 600,
    letterSpacing: '0.09em',
    textTransform: 'uppercase',
    color: color.dim,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.md,
    borderRadius: radius.md,
    color: color.text,
    fontSize: fontSize.md,
    cursor: 'pointer',
  },
  /** The active row. `aria-selected` drives it so the keyboard and the pointer agree. */
  itemActive: {
    backgroundColor: color.surface,
  },
  itemGlyph: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    color: color.dim,
  },
  itemLabel: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  shortcut: {
    flexShrink: 0,
    paddingInline: space.sm,
    paddingBlock: '1px',
    borderRadius: radius.sm,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.border,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: fontSize.micro,
    color: color.muted,
  },
  empty: {
    padding: space.xl,
    textAlign: 'center',
    fontSize: fontSize.sm,
    color: color.dim,
  },
});

interface PaletteAction {
  id: string;
  label: string;
  group: string;
  /** The keyboard hint, shown on the row. Cosmetic: the keys themselves are handled elsewhere. */
  shortcut?: string;
  run(): void;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onToolChange(tool: TransformTool): void;
  onFocusSelection(): void;
  /** Playback, so the palette can offer it. Each is a no-op when it does not apply. */
  playback: {
    play(): void;
    pause(): void;
    step(): void;
    stop(): void;
    state: 'stopped' | 'running' | 'paused';
  };
  onExport(): void;
  /**
   * The view commands, so the numpad is discoverable rather than folklore.
   *
   * Every one of these has a key, and none of them has a button anywhere in the shell — the gizmo
   * covers the faces and the overlays menu covers the switches, but "orthographic", "opposite" and
   * "look through the game camera" are only reachable from the keyboard. A shortcut nobody can find
   * is the same as no shortcut.
   */
  view: {
    face(face: ViewFace): void;
    opposite(): void;
    toggleProjection(): void;
    cameraView(): void;
    frameAll(): void;
    inCameraView: boolean;
  };
}

export function CommandPalette({
  open,
  onOpenChange,
  onToolChange,
  onFocusSelection,
  playback,
  onExport,
  view,
}: CommandPaletteProps): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  /**
   * Every action the palette offers, rebuilt when what it can act on changes.
   *
   * Memoised on the scene and selection rather than declared once: "duplicate the selection" only
   * exists when something is selected, and a stale entry that runs against a deleted entity is
   * worse than an absent one.
   */
  const actions = useMemo<PaletteAction[]>(() => {
    const primary = snapshot.primarySelection;
    const scene = session.scene;
    const entity = primary && scene ? scene.entities.find((candidate) => candidate.id === primary) : undefined;

    const createActions: PaletteAction[] = CREATABLE_KINDS.map((kind: CreatableKind) => ({
      id: `create:${kind}`,
      label: `Add ${CREATABLE_LABELS[kind]}`,
      group: 'Create',
      run: () => {
        if (!scene) return;
        const used = scene.entities.map((candidate) => candidate.id);
        const siblings = scene.entities.filter((candidate) => candidate.parentId === null);
        const created = createEntity(kind, {
          usedIds: used,
          order: siblings.length,
          position: [0, kind === 'plane' ? 0 : 1, 0],
        });
        if (session.execute({ kind: 'insertEntities', entities: [created] })) session.select(created.id);
      },
    }));

    return [
      ...createActions,
      { id: 'tool:translate', label: 'Tool: Move', group: 'Tools', shortcut: 'W', run: () => onToolChange('translate') },
      { id: 'tool:rotate', label: 'Tool: Rotate', group: 'Tools', shortcut: 'E', run: () => onToolChange('rotate') },
      { id: 'tool:scale', label: 'Tool: Scale', group: 'Tools', shortcut: 'R', run: () => onToolChange('scale') },
      { id: 'tool:focus', label: 'Focus the selection', group: 'Tools', shortcut: 'F', run: onFocusSelection },
      { id: 'view:front', label: 'View: front', group: 'View', shortcut: '1', run: () => view.face({ axis: 'z', sign: 1 }) },
      { id: 'view:right', label: 'View: right', group: 'View', shortcut: '3', run: () => view.face({ axis: 'x', sign: 1 }) },
      { id: 'view:top', label: 'View: top', group: 'View', shortcut: '7', run: () => view.face({ axis: 'y', sign: 1 }) },
      { id: 'view:opposite', label: 'View: opposite side', group: 'View', shortcut: '9', run: view.opposite },
      {
        id: 'view:projection',
        label: 'Toggle perspective and orthographic',
        group: 'View',
        shortcut: '5',
        run: view.toggleProjection,
      },
      {
        id: 'view:camera',
        label: view.inCameraView ? 'Leave the game camera' : 'Look through the game camera',
        group: 'View',
        shortcut: '0',
        run: view.cameraView,
      },
      { id: 'view:frame-all', label: 'Frame everything', group: 'View', shortcut: 'Home', run: view.frameAll },
      {
        id: 'edit:undo',
        label: 'Undo',
        group: 'Edit',
        shortcut: '⌘Z',
        run: () => session.undo(),
      },
      {
        id: 'edit:redo',
        label: 'Redo',
        group: 'Edit',
        shortcut: '⇧⌘Z',
        run: () => session.redo(),
      },
      {
        id: 'edit:delete',
        label: entity ? `Delete “${entity.name}”` : 'Delete the selection',
        group: 'Edit',
        shortcut: 'Del',
        run: () => {
          if (!primary) return;
          session.execute({ kind: 'deleteEntities', entityIds: [...snapshot.selectedIds] });
        },
      },
      {
        id: 'edit:duplicate',
        label: 'Duplicate the selection',
        group: 'Edit',
        shortcut: '⌘D',
        run: () => {
          if (!scene || snapshot.selectedIds.length === 0) return;
          const duplicate = duplicateEntities(scene, [...snapshot.selectedIds]);
          const primaryEntity = entity;
          if (duplicate.entities.length === 0) return;
          if (session.execute({
            kind: 'insertEntities',
            entities: duplicate.entities,
            label: snapshot.selectedIds.length === 1 ? `Duplicate ${primaryEntity?.name ?? 'object'}` : `Duplicate ${snapshot.selectedIds.length} objects`,
          })) {
            session.selectMany(duplicate.selectIds);
          }
        },
      },
      { id: 'file:save', label: 'Save the scene', group: 'File', shortcut: '⌘S', run: () => void session.save() },
      { id: 'file:reload', label: 'Reload the scene from disk', group: 'File', run: () => void session.reloadScene() },
      { id: 'file:close', label: 'Close the project', group: 'File', run: () => session.closeProject() },
      {
        id: 'play:start',
        label: 'Play the scene',
        group: 'Play',
        run: playback.play,
      },
      {
        id: 'play:pause',
        label: playback.state === 'paused' ? 'Resume the simulation' : 'Pause the simulation',
        group: 'Play',
        run: playback.pause,
      },
      { id: 'play:step', label: 'Step one frame', group: 'Play', run: playback.step },
      { id: 'play:stop', label: 'Stop and discard the simulation', group: 'Play', run: playback.stop },
      { id: 'file:export', label: 'Export the game', group: 'File', run: onExport },
    ];
  }, [onExport, onFocusSelection, onToolChange, playback, session, snapshot.primarySelection, snapshot.selectedIds]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return actions;
    return actions.filter((action) => action.label.toLowerCase().includes(needle));
  }, [actions, query]);

  // Reset the query and the highlight each time the palette opens, and clamp the highlight when the
  // filtered list shrinks under it.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);
  useEffect(() => {
    setActive((current) => (current >= filtered.length ? 0 : current));
  }, [filtered.length]);

  const choose = (action: PaletteAction | undefined) => {
    if (!action) return;
    onOpenChange(false);
    action.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => (filtered.length === 0 ? 0 : (current + 1) % filtered.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => (filtered.length === 0 ? 0 : (current - 1 + filtered.length) % filtered.length));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(filtered[active]);
    }
  };

  // Keep the active row in view as the arrow keys walk past the fold.
  useEffect(() => {
    const row = listRef.current?.querySelector('[aria-selected="true"]');
    row?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  let lastGroup: string | null = null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={stylex.props(styles.overlay).className} />
        <DialogPrimitive.Content
          className={stylex.props(styles.content).className}
          aria-label="Command palette"
          onKeyDown={onKeyDown}
        >
          <DialogPrimitive.Title style={{ display: 'none' }}>Command palette</DialogPrimitive.Title>
          <div {...stylex.props(styles.searchRow)}>
            <Search size={control.icon} />
            <input
              {...stylex.props(styles.input)}
              autoFocus
              value={query}
              placeholder="Search actions…"
              aria-label="Search actions"
              aria-controls="command-palette-list"
              aria-activedescendant={filtered[active] ? `palette-${filtered[active]!.id}` : undefined}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div {...stylex.props(styles.list)} id="command-palette-list" role="listbox" ref={listRef}>
            {filtered.length === 0 ? (
              <div {...stylex.props(styles.empty)}>No action matches “{query}”.</div>
            ) : (
              filtered.map((action, index) => {
                const showGroup = action.group !== lastGroup;
                lastGroup = action.group;
                return (
                  <div key={action.id}>
                    {showGroup ? (
                      <div {...stylex.props(styles.groupLabel)} role="presentation">
                        {action.group}
                      </div>
                    ) : null}
                    <div
                      {...stylex.props(styles.item, index === active && styles.itemActive)}
                      id={`palette-${action.id}`}
                      role="option"
                      aria-selected={index === active}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => choose(action)}
                    >
                      <span {...stylex.props(styles.itemLabel)}>{action.label}</span>
                      {action.shortcut ? (
                        <span {...stylex.props(styles.shortcut)}>{action.shortcut}</span>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
