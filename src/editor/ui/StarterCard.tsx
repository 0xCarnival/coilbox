import { useRef } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Camera, FileUp, Square, Sun, Sparkles } from 'lucide-react';
import { color, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import { DOM, withDomClass } from '../dom-contract.js';
import { Button } from './Button.js';
import { createEntity, createStarterEntities, type CreatableKind } from '../document/factory.js';

/** Rises and fades in from where it sits: the eye is told something arrived without a sound. */
const rise = stylex.keyframes({
  from: { opacity: 0, transform: 'translateY(8px) scale(0.98)' },
  to: { opacity: 1, transform: 'translateY(0) scale(1)' },
});

/**
 * What an empty scene shows instead of an empty viewport.
 *
 * A blank canvas answers none of a new user's questions, and the actions that would fill it are
 * spread over a menu, a panel, and a file dialog. The card puts the three first moves where the eye
 * is, and disappears the moment the scene has something in it. Every action is an ordinary command,
 * so what it adds is undoable and indistinguishable from what the Create menu adds.
 */

const styles = stylex.create({
  lane: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    zIndex: 30,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space.md,
    width: '340px',
    maxWidth: 'calc(100% - 32px)',
    paddingBlock: space.xl,
    paddingInline: space.xl,
    borderRadius: radius.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.border,
    backgroundColor: color.overlay,
    backdropFilter: 'blur(10px)',
    boxShadow: `0 16px 40px ${color.shadow}`,
    pointerEvents: 'auto',
    animationName: rise,
    animationDuration: '140ms',
    animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
    animationFillMode: 'both',
  },
  title: {
    fontSize: fontSize.lg,
    fontWeight: 600,
    color: color.text,
  },
  hint: {
    fontSize: fontSize.sm,
    color: color.muted,
    textAlign: 'center',
  },
  actions: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: space.sm,
    width: '100%',
    marginBlockStart: space.sm,
  },
  primary: {
    gridColumn: '1 / -1',
  },
});

const QUICK_ADDS: Array<{ kind: CreatableKind; label: string; Icon: typeof Square }> = [
  { kind: 'plane', label: 'Add ground', Icon: Square },
  { kind: 'camera', label: 'Add camera', Icon: Camera },
  { kind: 'directionalLight', label: 'Add light', Icon: Sun },
];

export function StarterCard({ visible }: { visible: boolean }): JSX.Element | null {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const scene = session.scene;
  const fileInput = useRef<HTMLInputElement>(null);

  if (!visible || !scene || scene.entities.length > 0) return null;

  const addStarterSet = () => {
    const entities = createStarterEntities(scene.entities.map((entity) => entity.id));
    const camera = entities.find((entity) => entity.components.some((component) => component.type === 'camera'));
    const ok = session.transaction('Add starter scene', [
      { kind: 'insertEntities', entities },
      ...(camera ? [{ kind: 'setActiveCamera' as const, entityId: camera.id }] : []),
    ]);
    if (ok) session.select(entities[0]?.id ?? null);
  };

  const addOne = (kind: CreatableKind) => {
    const entity = createEntity(kind, { order: 0, position: [0, kind === 'plane' ? 0 : 1, 0] });
    const commands = [
      { kind: 'insertEntities' as const, entities: [entity] },
      ...(kind === 'camera' ? [{ kind: 'setActiveCamera' as const, entityId: entity.id }] : []),
    ];
    if (session.transaction(`Add ${entity.name}`, commands)) session.select(entity.id);
  };

  return (
    <div {...stylex.props(styles.lane)}>
      <div {...withDomClass(styles.card, DOM.starterCard)} role="region" aria-label="Empty scene">
        <span {...stylex.props(styles.title)}>{scene.name} is empty</span>
        <span {...stylex.props(styles.hint)}>
          Start from the usual ground, player, camera and sun, or add things one at a time. Drop files
          anywhere on the asset panel to import them.
        </span>
        <div {...stylex.props(styles.actions)}>
          <span {...stylex.props(styles.primary)}>
            <Button variant="primary" size="md" style={{ width: '100%' }} onClick={addStarterSet}>
              <Sparkles size={14} />
              Add starter scene
            </Button>
          </span>
          {QUICK_ADDS.map(({ kind, label, Icon }) => (
            <Button key={kind} variant="outline" size="md" onClick={() => addOne(kind)}>
              <Icon size={14} />
              {label}
            </Button>
          ))}
          <Button variant="outline" size="md" disabled={snapshot.importing} onClick={() => fileInput.current?.click()}>
            <FileUp size={14} />
            {snapshot.importing ? 'Importing…' : 'Import files'}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".glb,.gltf,.png,.jpg,.jpeg,.webp,.mp3,.ogg,.wav"
            style={{ display: 'none' }}
            onChange={(event) => {
              const files = event.target.files ? Array.from(event.target.files) : [];
              event.target.value = '';
              if (files.length > 0) void session.importFiles(files);
            }}
          />
        </div>
      </div>
    </div>
  );
}
