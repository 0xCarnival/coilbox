import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { AssetEntry, Component, ComponentType, Entity, JsonValue, Quat, Vec2, Vec3 } from '@schema/index.js';
import { COMPONENT_TYPES, COMPONENT_LABELS, IDENTITY_QUAT, ZERO_VEC3 } from '@schema/index.js';
import { color, control, fontFamily, fontSize, space } from '../styles/tokens.stylex.js';
import { DOM, withDomClass } from '../dom-contract.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import {
  COMPONENT_DESCRIPTORS,
  componentLabel,
  eulerDegreesToQuaternion,
  quaternionToEulerDegrees,
  type FieldDescriptor,
  type FieldKind,
} from './field-schema.js';
import type { BehaviorPropertyDescriptor } from '@runtime/behaviors/types.js';
import { componentsFor, type CreatableKind } from '../document/factory.js';
import { isFiniteJsonNumber, isJsonString, jsonQuaternion, jsonVec2, jsonVec3 } from '../json-values.js';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useScrub } from '../ui/useScrub.js';
import { FieldShell, ScrubLabel, Select } from '../ui/Field.js';
import { Switch } from '../ui/Field.js';
import { Button, IconButton } from '../ui/Button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/Menu.js';

/**
 * Inspector (plan §3): only the selected object's applicable properties, with readable
 * labels and advanced fields collapsed. Every edit goes through a command, so it is
 * validated and undoable like any other authored change.
 */

/**
 * Inspector chrome.
 *
 * Two rules shape this block. StyleX has no descendant selector, so every treatment the stylesheet
 * used to reach through a parent — `.field input[type='number']`, `.field.checkbox span`,
 * `.axis span`, `.axis input`, `.advanced button`, `.component-actions button` — now sits on the
 * child that wears it. And where the stylesheet already styles the bare `button`/`input` elements,
 * a converted class declares only what the original class declared: an atomic class would otherwise
 * win by specificity over the element rule and silently change every control's padding or border.
 *
 * The class names the browser gates query ride along through `withDomClass`, so a hook class and
 * StyleX's atomic classes coexist on the same element instead of one replacing the other.
 */
const styles = stylex.create({
  /**
   * The panel scrolls as one column, and its padding lives here rather than on each section so
   * every row in the inspector starts on the same vertical line.
   */
  inspector: {
    overflow: 'auto',
    height: '100%',
    paddingBlockEnd: space.lg,
    paddingInline: space.sm,
    position: 'relative',
  },
  /**
   * The object's name is the panel's title, so it is the one text field in the inspector that does
   * not look like a field until it is hovered. `name-field` is a gate hook, so it keeps its class.
   */
  inspectorTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    paddingBlock: space.md,
    paddingInline: space.xs,
  },
  nameField: {
    flex: 1,
    fontWeight: 600,
    fontSize: fontSize.md,
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    paddingInline: space.xs,
  },
  enabledToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    color: color.muted,
    fontSize: fontSize.xs,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  /**
   * A section is separated from the next by a hairline, which is the only rule left in the panel.
   * The previous treatment gave every section a filled header band *and* a bottom border, so the
   * inspector read as a stack of stripes rather than a column of properties.
   */
  /**
   * A section is separated from the next by a hairline under its header, which is the only rule left
   * in the panel. The previous treatment gave every section both a filled header band and a bottom
   * border, so the inspector read as a stack of stripes rather than a column of properties.
   */
  section: {
    display: 'flex',
    flexDirection: 'column',
  },
  sectionHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: color.border,
  },
  /**
   * The section header is an uppercase micro-label with a rotating chevron.
   *
   * It carries no background, no border, and no radius — those all came from the old translated
   * `button` element rule and are exactly what made a disclosure look like a form field. Hierarchy
   * now comes from the label itself: at 10px, tracked and uppercase, it reads as a heading at a
   * glance while staying quieter than the values underneath it.
   */
  /**
   * A section header, on the reference's `PanelSection` geometry: a 40px band, the title on the
   * leading edge, the summary and the chevron on the trailing one, and a hairline under the pair.
   *
   * Two details are load bearing. An expanded section keeps a faint fill, so its title reads as
   * belonging to the body it opened rather than floating above it; and the chevron *turns* rather
   * than swapping glyphs, which is what makes the relationship between the two states legible.
   */
  sectionHeader: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    height: '36px',
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: 0,
    paddingBlock: 0,
    paddingInline: space.lg,
    textAlign: 'left',
    color: color.muted,
    cursor: 'pointer',
    transitionProperty: 'background-color, color',
    transitionDuration: '150ms',
    ':hover': {
      backgroundColor: color.wash,
      color: color.text,
    },
  },
  sectionHeaderToggle: {
    flex: 1,
    minWidth: 0,
  },
  sectionAction: {
    flexShrink: 0,
    marginInlineEnd: space.sm,
  },
  /** An open section's header sits on a faint fill: the title belongs to what it opened. */
  sectionHeaderOpen: {
    backgroundColor: color.wash,
    color: color.text,
  },
  sectionTitle: {
    fontSize: fontSize.sm,
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /**
   * The subtitle is the technical name — `box 1 x 2.4 x 1 m`, a behavior id, `dynamic`. It sits on
   * the far side of the header in mono so it cannot be confused with the heading itself.
   */
  sectionSubtitle: {
    color: color.dim,
    marginInlineStart: 'auto',
    fontSize: fontSize.xs,
    fontFamily: fontFamily.mono,
  },
  /**
   * Pushes the disclosure chevron to the trailing edge when there is no subtitle to push it.
   * A section with a subtitle gets its spacing from the subtitle's own `marginInlineStart: auto`.
   */
  chevronTrailing: {
    marginInlineStart: 'auto',
    display: 'flex',
    alignItems: 'center',
  },
  sectionBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
    paddingBlockStart: space.xs,
    paddingBlockEnd: space.sm,
    paddingInline: space.xs,
  },
  /**
   * The field rhythm: a fixed label column, then a control that fills the rest.
   *
   * The fixed basis is what makes the panel scannable — with a content-sized label, every row's
   * control started at a different x and the column of values had no edge to read down. `start`
   * alignment rather than `center` keeps a label on the first line of a vector row.
   */
  field: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minHeight: '24px',
  },
  /**
   * A boolean row: the name on the left, the switch on the right, on the panel's own background.
   *
   * It deliberately has no field box. The reference marks an on/off property with a bare row and a
   * switch, which is what keeps a component's list of toggles from reading as a form of inputs.
   */
  fieldToggle: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    minHeight: '28px',
    paddingInline: space.lg,
  },
  fieldToggleLabel: {
    fontSize: fontSize.md,
    fontWeight: 500,
    color: color.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /**
   * The input inside a field box. It is borderless and transparent because the *box* is the field
   * now: an input drawing its own border inside a bordered shell is two boxes for one control, which
   * is exactly what the previous version looked like.
   */
  fieldInput: {
    flex: 1,
    minWidth: 0,
    height: '24px',
    paddingInline: space.xs,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    color: color.text,
    fontSize: fontSize.md,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    ':hover': {
      borderWidth: 0,
      borderColor: 'transparent',
    },
    ':focus': {
      outline: 'none',
      borderColor: 'transparent',
    },
  },
  /** `.field.checkbox` — the tighter gap of a checkbox row. */
  fieldCheckbox: {
    gap: space.sm,
  },
  fieldLabel: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: '96px',
    color: color.dim,
    fontSize: fontSize.sm,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /**
   * `.field input[type='number']`, `.field input[type='text']`, and `.field select` were one
   * descendant rule; the flex now lives on the controls themselves. `input[type='color']` is
   * deliberately left alone because the original rule never covered it.
   */
  fieldControl: {
    flex: 1,
    minWidth: 0,
  },
  /** `.field.checkbox span` — the label text carries its own colour instead of inheriting it. */
  checkboxText: {
    color: color.text,
    fontSize: fontSize.sm,
  },
  vectorField: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    width: '100%',
  },
  vectorInputs: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: space.xs,
    flex: 1,
  },
  /**
   * A vector row's name sits *outside* the box, not inside it.
   *
   * One box around three numbers is what the reference does — the three axes are one value, and
   * three separately bordered inputs would read as three unrelated settings. The name labels the
   * group, so it belongs on the group's edge.
   */
  fieldLabelBare: {
    flexShrink: 0,
    flexBasis: '88px',
    paddingInlineStart: space.lg,
    fontSize: fontSize.xs,
    fontWeight: 500,
    color: color.muted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  axis: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flex: 1,
    minWidth: 0,
  },
  /**
   * `.axis span`. The axis letter stays at 10px: it is a colour-coded suffix on a number, not a
   * label the reader parses, so it has to be quieter than the value beside it.
   */
  /**
   * The axis letter is the scrub handle, so it carries the `ew-resize` cursor that advertises the
   * gesture. It is deliberately not a chip or a button: it must stay a 10px letter so the number
   * beside it keeps the row's width.
   */
  axisLabel: {
    color: color.dim,
    fontSize: fontSize.micro,
    fontWeight: 600,
    cursor: 'ew-resize',
    userSelect: 'none',
    paddingInlineEnd: space.xs,
    ':hover': {
      color: color.text,
    },
  },
  axisLabelDragging: {
    color: color.text,
  },
  /**
   * `.axis input` — borderless and transparent, because the surrounding field box is the control
   * now. An input drawing its own border inside a bordered shell is two boxes for one value.
   */
  axisInput: {
    width: '100%',
    height: '22px',
    paddingInline: space.xs,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    color: color.text,
    fontSize: fontSize.sm,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    ':hover': {
      borderWidth: 0,
      borderColor: 'transparent',
    },
    ':focus': {
      outline: 'none',
      borderColor: 'transparent',
      backgroundColor: color.wash,
    },
  },
  /**
   * `.advanced button`: the disclosure row's own chrome. A quiet text disclosure with a chevron,
   * rather than a bordered control — several of these appear inside one section and the borders
   * were what made a component look like it had a dozen buttons.
   */
  advancedToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    color: color.dim,
    fontSize: fontSize.xs,
    paddingBlock: space.xxs,
    paddingInline: 0,
    ':hover': {
      color: color.muted,
    },
  },
  addComponent: {
    paddingBlock: space.sm,
    paddingInline: space.xs,
    position: 'relative',
  },
  menuHint: {
    color: color.dim,
    padding: space.sm,
    maxWidth: '220px',
    fontSize: fontSize.xs,
  },
  /** `.muted` also carried `margin: 0` from the shared `.home-header p, .muted` rule. */
  muted: {
    color: color.muted,
    margin: 0,
    fontSize: fontSize.sm,
  },
  warn: {
    color: color.warn,
    margin: 0,
    fontSize: fontSize.sm,
  },
  empty: {
    color: color.dim,
    padding: space.lg,
    textAlign: 'center',
    fontSize: fontSize.sm,
  },
  multiHint: {
    color: color.dim,
    fontSize: fontSize.xs,
    paddingInline: space.lg,
    paddingBlock: space.sm,
  },
  selectedNames: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
    paddingInline: space.lg,
    paddingBlock: space.sm,
    color: color.muted,
    fontSize: fontSize.sm,
  },
});

function sameTuple(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function Inspector({ locked }: { locked: boolean }): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const scene = session.scene;
  const entity = scene?.entities.find((candidate) => candidate.id === snapshot.primarySelection) ?? null;
  const selectedEntities = scene ? snapshot.selectedIds.map((id) => scene.entities.find((candidate) => candidate.id === id)).filter((candidate): candidate is Entity => Boolean(candidate)) : [];
  const multi = selectedEntities.length > 1;
  const enabledInput = useRef<HTMLInputElement | null>(null);
  const allEnabled = multi && selectedEntities.every((candidate) => candidate.enabled);
  const mixedEnabled = multi && selectedEntities.some((candidate) => candidate.enabled) && !allEnabled;
  useEffect(() => {
    if (enabledInput.current) enabledInput.current.indeterminate = mixedEnabled;
  }, [mixedEnabled]);

  if (!entity || !scene) {
    return (
      <div {...withDomClass(styles.inspector, DOM.inspector)}>
        <div {...withDomClass(styles.empty, DOM.panelEmpty)}>
          Select an object to see its properties
        </div>
      </div>
    );
  }

  if (multi) {
    const applyEnabled = (enabled: boolean) => {
      const commands = selectedEntities
        .filter((candidate) => candidate.enabled !== enabled)
        .map((candidate) => ({ kind: 'setEntityEnabled' as const, entityId: candidate.id, enabled }));
      if (commands.length > 0) session.transaction('Set enabled state', commands);
    };
    const applyTransform = (patch: { position?: Vec3; rotation?: Quat; scale?: Vec3 }, label: string) => {
      const commands = selectedEntities
        .filter((candidate) =>
          (patch.position !== undefined && !sameTuple(candidate.transform.position, patch.position)) ||
          (patch.rotation !== undefined && !sameTuple(candidate.transform.rotation, patch.rotation)) ||
          (patch.scale !== undefined && !sameTuple(candidate.transform.scale, patch.scale)),
        )
        .map((candidate) => ({ kind: 'setTransform' as const, entityId: candidate.id, transform: patch }));
      if (commands.length > 0) {
        session.transaction(label, commands, {
          coalesceKey: `transform:${selectedEntities.map((candidate) => candidate.id).join(',')}`,
        });
      }
    };
    return (
      <div {...withDomClass(styles.inspector, DOM.inspector)}>
        <div {...withDomClass(styles.inspectorTitle, DOM.inspectorTitle)}>
          <strong>{selectedEntities.length} objects selected</strong>
          <label {...stylex.props(styles.enabledToggle)} title="Whether these objects exist in the game">
            <input
              ref={enabledInput}
              type="checkbox"
              checked={allEnabled}
              disabled={locked}
              onChange={(event) => applyEnabled(event.target.checked)}
            />
            In game
          </label>
        </div>
        <Section title="Transform" defaultOpen>
          <VectorField label="Position (m)" value={entity.transform.position} step={0.1} disabled={locked} onChange={(value) => {
            if (value.length === 3) applyTransform({ position: value }, 'Set position');
          }} />
          <RotationField value={entity.transform.rotation} disabled={locked} onChange={(value) => applyTransform({ rotation: value }, 'Set rotation')} />
          <VectorField label="Scale" value={entity.transform.scale} step={0.05} disabled={locked} onChange={(value) => {
            if (value.length === 3) applyTransform({ scale: value }, 'Set scale');
          }} />
        </Section>
        <div {...stylex.props(styles.multiHint)}>Edits apply to all selected objects</div>
        <div {...stylex.props(styles.selectedNames)}>
          {selectedEntities.map((candidate) => <div key={candidate.id}>{candidate.name}</div>)}
        </div>
        <Button disabled={locked} onClick={() => session.execute({ kind: 'deleteEntities', entityIds: selectedEntities.map((candidate) => candidate.id) })}>
          Delete {selectedEntities.length} objects
        </Button>
      </div>
    );
  }

  const setProperty = (componentType: ComponentType, property: string, value: JsonValue) => {
    session.execute(
      { kind: 'setComponentProperty', entityId: entity.id, componentType, property, value },
      { coalesceKey: `prop:${entity.id}:${componentType}:${property}` },
    );
  };

  const setTransform = (patch: { position?: Vec3; rotation?: [number, number, number, number]; scale?: Vec3 }) => {
    session.execute({ kind: 'setTransform', entityId: entity.id, transform: patch }, { coalesceKey: `transform:${entity.id}` });
  };

  return (
    <div {...withDomClass(styles.inspector, DOM.inspector)}>
      <div {...withDomClass(styles.inspectorTitle, DOM.inspectorTitle)}>
        <input
          {...withDomClass(styles.nameField, DOM.nameField)}
          value={entity.name}
          disabled={locked}
          aria-label="Object name"
          onChange={(event) => session.execute({ kind: 'renameEntity', entityId: entity.id, name: event.target.value }, { coalesceKey: `name:${entity.id}` })}
        />
        <label {...stylex.props(styles.enabledToggle)} title="Whether this object exists in the game">
          <input
            type="checkbox"
            checked={entity.enabled}
            disabled={locked}
            onChange={(event) => session.execute({ kind: 'setEntityEnabled', entityId: entity.id, enabled: event.target.checked })}
          />
          In game
        </label>
      </div>

      <Section title="Transform" defaultOpen>
        <VectorField
          label="Position (m)"
          value={entity.transform.position}
          step={0.1}
          disabled={locked}
          onChange={(value) => {
            if (value.length === 3) setTransform({ position: value });
          }}
        />
        <RotationField
          value={entity.transform.rotation}
          disabled={locked}
          onChange={(value) => setTransform({ rotation: value })}
        />
        <VectorField
          label="Scale"
          value={entity.transform.scale}
          step={0.05}
          disabled={locked}
          onChange={(value) => {
            if (value.length === 3) setTransform({ scale: value });
          }}
        />
      </Section>

      {entity.components.map((component) =>
        component.type === 'behavior' ? (
          <BehaviorSection key={`behavior:${component.behaviorId}`} entity={entity} component={component} locked={locked} />
        ) : (
          <ComponentSection
            key={component.type}
            entity={entity}
            component={component}
            locked={locked}
            onSetProperty={setProperty}
          />
        ),
      )}

      <div {...withDomClass(styles.addComponent, DOM.addComponent)}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button disabled={locked}>
              <Plus size={control.icon} />
              Add component
            </Button>
          </DropdownMenuTrigger>
          {/**
           * The menu is Radix's, like the toolbar's, rather than a hand-rolled popover. That is what
           * gives it Escape, outside-click dismissal, and keyboard traversal for free — and it is
           * why the `add-menu` hook rides along as data: Radix owns this element's `className`, so a
           * hook the browser gates select on cannot be applied by the caller the usual way.
           */}
          <DropdownMenuContent align="start" hooks={[DOM.addMenu]}>
            {COMPONENT_TYPES.filter((type) => isAddable(entity, type))
              .map((type) => ({ type, component: defaultComponent(type, snapshot.assets) }))
              .filter((entry): entry is { type: ComponentType; component: Component } => entry.component !== null)
              .map(({ type, component }) => (
                <DropdownMenuItem
                  key={type}
                  onSelect={() => {
                    // A model replaces the primitive placeholder rather than stacking a second
                    // renderable on the same entity; both changes are one undo step.
                    const replacePrimitive = type === 'model' && entity.components.some((candidate) => candidate.type === 'primitive');
                    if (replacePrimitive) {
                      session.transaction(`Add ${COMPONENT_LABELS[type]}`, [
                        { kind: 'removeComponent', entityId: entity.id, componentType: 'primitive' },
                        { kind: 'addComponent', entityId: entity.id, component },
                      ]);
                      return;
                    }
                    session.execute({ kind: 'addComponent', entityId: entity.id, component });
                  }}
                >
                  {COMPONENT_LABELS[type]}
                </DropdownMenuItem>
              ))}
            {snapshot.assets.filter((asset) => asset.kind === 'model').length === 0 && (
              <span {...stylex.props(styles.menuHint)}>Import a .glb in the Assets tab to add a Model component.</span>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

const SINGLETON: ComponentType[] = ['primitive', 'model', 'camera', 'rigidBody', 'collider', 'animation', 'audio'];

function isAddable(entity: Entity, type: ComponentType): boolean {
  if (type === 'primitive' && entity.components.some((component) => component.type === 'primitive' || component.type === 'model')) {
    return false;
  }

  if (SINGLETON.includes(type) && entity.components.some((component) => component.type === type)) return false;
  if (type === 'collider' && !entity.components.some((component) => component.type === 'rigidBody')) return false;
  return true;
}

/**
 * Default values for a component added from the menu.
 *
 * Creation-menu kinds reuse the single source of defaults in `document/factory.ts`. Model and
 * audio components need an asset to reference, so with none imported they return null and the
 * entry is not offered — an empty asset reference would be an invalid document.
 */
function defaultComponent(type: ComponentType, assets: readonly AssetEntry[]): Component | null {
  switch (type) {
    case 'primitive':
      return componentsFor('box')[0];
    case 'camera':
      return componentsFor('camera')[0];
    case 'light':
      return componentsFor('directionalLight')[0];
    case 'model': {
      const asset = assets.find((candidate) => candidate.kind === 'model');
      return asset ? { type: 'model', assetId: asset.id, castShadow: true, receiveShadow: true } : null;
    }
    case 'audio': {
      const asset = assets.find((candidate) => candidate.kind === 'audio');
      return asset
        ? { type: 'audio', assetId: asset.id, loop: false, autoplay: false, volume: 1, spatial: false, maxDistance: 20 }
        : null;
    }
    default:
      return defaultLiteralFor(type);
  }
}

function defaultLiteralFor(type: ComponentType): Component {
  switch (type) {
    case 'material':
      return { type: 'material', color: '#cccccc', roughness: 0.8, metalness: 0, emissive: '#000000', emissiveIntensity: 1, opacity: 1, map: null, normalMap: null, emissiveMap: null, textureRepeat: [1, 1], textureOffset: [0, 0], transparent: false, doubleSided: false, flatShading: false, visible: true };
    case 'rigidBody':
      return { type: 'rigidBody', bodyType: 'dynamic', mass: null, gravityScale: 1, linearDamping: 0, angularDamping: 0.05, lockRotation: false, continuous: false, moveWithPhysics: true };
    case 'collider':
      return { type: 'collider', shape: 'box', size: [1, 1, 1], offset: [0, 0, 0], localRotation: [0, 0, 0, 1], isSensor: false, friction: 0.6, restitution: 0, density: 1, reportContacts: false };
    case 'animation':
      return { type: 'animation', clip: null, playing: true, loop: true, speed: 1, autoplay: true };
    case 'audio':
      return { type: 'audio', assetId: 'audio', loop: false, autoplay: false, volume: 1, spatial: false, maxDistance: 20 };
    case 'model':
      return { type: 'model', assetId: 'model', castShadow: true, receiveShadow: true };
    case 'behavior':
      return { type: 'behavior', behaviorId: 'behavior.id', properties: {} };
    default:
      return { type: 'primitive', shape: 'box', size: [1, 1, 1], castShadow: true, receiveShadow: true };
  }
}

/** Behavior component: fields come from the project's registry metadata, not this file. */
function BehaviorSection({ entity, component, locked }: { entity: Entity; component: Extract<Component, { type: 'behavior' }>; locked: boolean }): JSX.Element {
  const session = useSession();
  const descriptor = session.behaviorRegistry.get(component.behaviorId);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const properties = component.properties;
  const fields = descriptor?.properties ?? [];
  const basic = fields.filter((field) => !field.advanced);
  const advanced = fields.filter((field) => field.advanced);

  // Behavior properties live inside the component's `properties` record, so they have their
  // own command rather than the flat component-property one.
  const set = (key: string, value: JsonValue) =>
    session.execute(
      { kind: 'setBehaviorProperty', entityId: entity.id, behaviorId: component.behaviorId, property: key, value },
      { coalesceKey: `behavior:${entity.id}:${component.behaviorId}:${key}` },
    );

  return (
    <Section
      title={descriptor?.name ?? component.behaviorId}
      subtitle={component.behaviorId}
      defaultOpen
      actions={
        <IconButton
          label={`Remove ${descriptor?.name ?? component.behaviorId}`}
          variant="danger"
          size="row"
          disabled={locked}
          onClick={() =>
            session.execute({ kind: 'removeComponent', entityId: entity.id, componentType: 'behavior' })
          }
        >
          <Trash2 size={control.iconSm} />
        </IconButton>
      }
    >
      {!descriptor && (
        <p {...stylex.props(styles.warn)}>
          “{component.behaviorId}” is not declared in scripts/registry.json, so its properties cannot be edited here.
        </p>
      )}
      {descriptor?.description && <p {...stylex.props(styles.muted)}>{descriptor.description}</p>}
      {basic.map((field) => (
        <Field
          key={field.key}
          field={{
            key: field.key,
            label: field.label,
            kind: behaviorFieldKind(field),
            help: field.description,
            min: field.min,
            max: field.max,
            step: field.step,
            options: field.options?.map((option) => ({ value: option, label: option })),
          }}
          value={properties[field.key] ?? field.default}
          disabled={locked}
          entity={entity}
          onChange={(value) => set(field.key, value)}
        />
      ))}
      {advanced.length > 0 && (
        <div>
          <button {...stylex.props(styles.advancedToggle)} type="button" onClick={() => setAdvancedOpen((open) => !open)}>
            <ChevronRight size={14} style={{ transform: advancedOpen ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }} />
            {advancedOpen ? 'Hide advanced' : `${advanced.length} advanced`}
          </button>
          {advancedOpen &&
            advanced.map((field) => (
              <Field
                key={field.key}
                field={{
                  key: field.key,
                  label: field.label,
                  kind: behaviorFieldKind(field),
                  help: field.description,
                  min: field.min,
                  max: field.max,
                  step: field.step,
                  options: field.options?.map((option) => ({ value: option, label: option })),
                }}
                value={properties[field.key] ?? field.default}
                disabled={locked}
                entity={entity}
                onChange={(value) => set(field.key, value)}
              />
            ))}
        </div>
      )}
    </Section>
  );
}

/** Map a registry property type onto the inspector's field kinds. */
function behaviorFieldKind(field: BehaviorPropertyDescriptor): FieldKind {
  switch (field.type) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'enum':
      return 'enum';
    case 'entity':
      return 'entity-reference';
    case 'asset':
      return 'asset-reference';
    case 'text':
    default:
      return 'text';
  }
}

function ComponentSection({
  entity,
  component,
  locked,
  onSetProperty,
}: {
  entity: Entity;
  component: Component;
  locked: boolean;
  onSetProperty(type: ComponentType, property: string, value: JsonValue): void;
}): JSX.Element {
  const descriptor = COMPONENT_DESCRIPTORS[component.type];
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const session = useSession();
  const advanced = descriptor.fields.filter((field) => field.advanced);
  const basic = descriptor.fields.filter((field) => !field.advanced);
  // Every authored component field is JSON by construction: the scene schema validates each
  // component, and the only free-form field (`behavior.properties`) is a `jsonObject`. Reading the
  // component through that view is what lets one descriptor-driven form serve every component type.
  const values: Record<string, JsonValue> = component;

  return (
    <Section
      title={componentLabel(component)}
      subtitle={descriptor.summary(component)}
      defaultOpen
      actions={
        <IconButton
          label={`Remove ${componentLabel(component)}`}
          variant="danger"
          size="row"
          disabled={locked}
          onClick={() =>
            session.execute({ kind: 'removeComponent', entityId: entity.id, componentType: component.type })
          }
        >
          <Trash2 size={control.iconSm} />
        </IconButton>
      }
    >
      {basic.map((field) => (
        <Field
          key={field.key}
          field={field}
          value={values[field.key] ?? null}
          disabled={locked}
          entity={entity}
          onChange={(value) => onSetProperty(component.type, field.key, value)}
        />
      ))}
      {advanced.length > 0 && (
        <div>
          <button {...stylex.props(styles.advancedToggle)} type="button" onClick={() => setAdvancedOpen((open) => !open)}>
            <ChevronRight size={14} style={{ transform: advancedOpen ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }} />
            {advancedOpen ? 'Hide advanced' : `${advanced.length} advanced`}
          </button>
          {advancedOpen &&
            advanced.map((field) => (
              <Field
                key={field.key}
                field={field}
                value={values[field.key] ?? null}
                disabled={locked}
                entity={entity}
                onChange={(value) => onSetProperty(component.type, field.key, value)}
              />
            ))}
        </div>
      )}
    </Section>
  );
}

function Field({
  field,
  value,
  disabled,
  entity,
  onChange,
}: {
  field: FieldDescriptor;
  value: JsonValue;
  disabled: boolean;
  entity: Entity;
  onChange(value: JsonValue): void;
}): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const scene = session.scene;

  switch (field.kind) {
    case 'boolean':
      /**
       * A switch, not a checkbox.
       *
       * The reference marks every on/off property with one, and the difference is not cosmetic: a
       * checkbox is a box you tick as part of a form, a switch is a setting that is already in one of
       * two states. These are all the latter.
       */
      return (
        <div {...withDomClass(styles.fieldToggle, DOM.field)}>
          <span {...withDomClass(styles.fieldToggleLabel, DOM.fieldLabel)}>{field.label}</span>
          <Switch
            label={field.label}
            checked={Boolean(value)}
            disabled={disabled}
            onCheckedChange={(next) => onChange(next)}
          />
        </div>
      );
    case 'color':
      return (
        <label {...withDomClass(styles.field, DOM.field)}>
          <span {...withDomClass(styles.fieldLabel, DOM.fieldLabel)}>{field.label}</span>
          <input
            type="color"
            value={isJsonString(value) ? value : '#ffffff'}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      );
    case 'enum':
      return (
        <SelectField
          label={field.label}
          value={String(value ?? '')}
          disabled={disabled}
          options={(field.options ?? []).map((option) => ({ value: option.value, label: option.label }))}
          onValueChange={(next) => onChange(coerceEnum(field, next))}
        />
      );
    case 'vec3':
    case 'positive-vec3':
      return (
        <div {...withDomClass(styles.field, DOM.field)}>
          <span {...withDomClass(styles.fieldLabel, DOM.fieldLabel)}>{field.label}</span>
          <VectorField
            label=""
            value={jsonVec3(value) ?? ZERO_VEC3}
            step={field.step ?? 0.1}
            disabled={disabled}
            positive={field.kind === 'positive-vec3'}
            onChange={(next) => onChange(next)}
          />
        </div>
      );
    case 'vec2':
      return (
        <div {...withDomClass(styles.field, DOM.field)}>
          <span {...withDomClass(styles.fieldLabel, DOM.fieldLabel)}>{field.label}</span>
          <VectorField
            label=""
            value={jsonVec2(value) ?? [0, 0]}
            step={field.step ?? 0.1}
            disabled={disabled}
            onChange={(next) => onChange(next)}
          />
        </div>
      );
    case 'quaternion-degrees':
      return (
        <div {...withDomClass(styles.field, DOM.field)}>
          <span {...withDomClass(styles.fieldLabel, DOM.fieldLabel)}>{field.label}</span>
          <RotationField
            value={jsonQuaternion(value) ?? IDENTITY_QUAT}
            disabled={disabled}
            onChange={(next) => onChange(next)}
          />
        </div>
      );
    case 'asset-reference': {
      const kind = field.assetKind ?? 'model';
      const options = snapshot.assets.filter((asset) => asset.kind === kind);
      return (
        <SelectField
          label={field.label}
          value={isJsonString(value) ? value : ''}
          disabled={disabled}
          options={[
            { value: '', label: 'None' },
            ...options.map((asset) => ({ value: asset.id, label: asset.id })),
            /**
             * A reference to an asset that is no longer in the manifest stays selectable and says
             * so. Dropping it would silently rewrite the document to "None" the moment the field
             * rendered, which is the failure this panel exists to prevent.
             */
            ...(isJsonString(value) && value.length > 0 && !options.some((asset) => asset.id === value)
              ? [{ value, label: `${value} (missing)` }]
              : []),
          ]}
          onValueChange={(next) => onChange(next === '' && field.nullable ? null : next)}
        />
      );
    }
    case 'clip-reference': {
      const clips = snapshot.modelClips[entity.id] ?? [];
      return (
        <SelectField
          label={field.label}
          value={isJsonString(value) ? value : ''}
          disabled={disabled || clips.length === 0}
          options={[
            { value: '', label: clips.length === 0 ? 'No clips loaded' : 'First clip' },
            ...clips.map((clip) => ({ value: clip, label: clip })),
          ]}
          onValueChange={(next) => onChange(next === '' ? null : next)}
        />
      );
    }
    case 'entity-reference':
      return (
        <label {...withDomClass(styles.field, DOM.field)}>
          <span {...withDomClass(styles.fieldLabel, DOM.fieldLabel)}>{field.label}</span>
          <select
            {...stylex.props(styles.fieldControl)}
            value={isJsonString(value) ? value : ''}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value || null)}
          >
            <option value="">None</option>
            {(scene?.entities ?? [])
              .filter((candidate) => candidate.id !== entity.id)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
          </select>
        </label>
      );
    case 'number':
      /**
       * A field whose value carries a unit gets the reference's metric treatment: the unit sits
       * inside the box, after the number.
       *
       * The unit is not decoration. A number in a 3D editor is meaningless without it — `18` is a
       * position or an extent or a rotation, and the suffix is the only thing that says which.
       */
      /**
       * A scrub handle *and* a real number input.
       *
       * The input stays because the browser gates drive these fields through it, and because typing
       * an exact value is a legitimate thing to want. The gesture is attached to the label, which is
       * where the reference puts it — see `ScrubField` for why the gesture lives on the label rather
       * than on the value.
       */
      return (
        <FieldShell
          hookProps={withDomClass(styles.field, DOM.field)}
          label={
            <ScrubLabel
              label={field.label}
              hookProps={withDomClass(styles.fieldLabel, DOM.fieldLabel)}
              config={{
                value: isFiniteJsonNumber(value) ? value : 0,
                onChange: (next) => onChange(componentValue(field, clamp(next, field))),
                step: field.step ?? 0.1,
                min: field.min,
                max: field.max,
                disabled,
              }}
            />
          }
        >
          <input
            {...stylex.props(styles.fieldInput)}
            type="number"
            aria-label={field.label}
            value={isFiniteJsonNumber(value) ? value : ''}
            step={field.step ?? 0.1}
            min={field.min}
            max={field.max}
            disabled={disabled}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              if (!Number.isFinite(parsed)) return;
              const clamped = clamp(parsed, field);
              onChange(componentValue(field, clamped));
            }}
          />
        </FieldShell>
      );
    case 'text':
    default:
      return (
        <FieldShell
          hookProps={withDomClass(styles.field, DOM.field)}
          label={<span {...withDomClass(styles.fieldLabel, DOM.fieldLabel)}>{field.label}</span>}
        >
          <input
            {...stylex.props(styles.fieldInput)}
            type="text"
            aria-label={field.label}
            value={value === null || value === undefined ? '' : String(value)}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value === '' && field.key === 'clip' ? null : event.target.value)}
          />
        </FieldShell>
      );
  }
}

function componentValue(field: FieldDescriptor, value: number): JsonValue {
  // `mass` is nullable: an empty field means "derive from the collider".
  if (field.key === 'mass' && value <= 0) return null;
  return value;
}

function clamp(value: number, field: FieldDescriptor): number {
  let result = value;
  if (field.min !== undefined) result = Math.max(field.min, result);
  if (field.max !== undefined) result = Math.min(field.max, result);
  return result;
}

function coerceEnum(field: FieldDescriptor, raw: string): JsonValue {
  const numeric = field.options?.every((option) => Number.isFinite(Number(option.value)));
  if (field.key === 'shadowMapSize' || numeric) return Number(raw);
  return raw;
}

function VectorField({
  label,
  value,
  step,
  disabled,
  positive,
  onChange,
}: {
  label: string;
  value: Vec2 | Vec3;
  step: number;
  disabled: boolean;
  positive?: boolean;
  onChange(value: Vec2 | Vec3): void;
}): JSX.Element {
  return (
    <FieldShell
      bare
      hookProps={withDomClass(styles.vectorField, DOM.vectorField)}
      label={
        label ? <span {...withDomClass(styles.fieldLabelBare, DOM.fieldLabel)}>{label}</span> : undefined
      }
    >
      <div {...stylex.props(styles.vectorInputs)}>
        {(['X', 'Y', 'Z'] as const).slice(0, value.length).map((axis, index) => (
          <ScrubAxisInput
            key={axis}
            axis={axis}
            componentIndex={index}
            value={value}
            step={step}
            disabled={disabled}
            positive={positive}
            onChange={onChange}
          />
        ))}
      </div>
    </FieldShell>
  );
}

/**
 * One axis of a vector row.
 *
 * The markup stays a `<label>` and a real `<input type="number">` on purpose: the browser gates
 * drive these fields through `.vector-field … input`, so replacing them with the `ScrubField`
 * readout would change the DOM contract to gain a gesture. Instead the *axis letter* is the drag
 * handle — the same affordance the reference puts on a field's label — and the input is left exactly
 * as it was for typing, arrow keys, and the gates.
 */
function ScrubAxisInput({
  axis,
  componentIndex,
  value,
  step,
  disabled,
  positive,
  onChange,
}: {
  axis: 'X' | 'Y' | 'Z';
  componentIndex: number;
  value: Vec2 | Vec3;
  step: number;
  disabled: boolean;
  positive?: boolean;
  onChange(value: Vec2 | Vec3): void;
}): JSX.Element {
  const setComponent = (next: number) => {
    const out: Vec2 | Vec3 = value.length === 2 ? [value[0], value[1]] : [value[0], value[1], value[2]];
    out[componentIndex] = positive ? Math.max(0.001, Math.abs(next)) : next;
    onChange(out);
  };
  const scrub = useScrub({
    value: value[componentIndex],
    onChange: setComponent,
    step,
    min: positive ? 0.001 : undefined,
    disabled,
  });

  return (
    <label {...stylex.props(styles.axis)}>
      <span
        {...stylex.props(styles.axisLabel, scrub.dragging && styles.axisLabelDragging)}
        onPointerDown={scrub.onPointerDown}
        title={`${axis} — drag to change, Shift for coarse, Alt for fine`}
      >
        {axis}
      </span>
      <input
        {...stylex.props(styles.axisInput)}
        type="number"
        step={step}
        disabled={disabled}
        aria-label={`${axis} component`}
        value={Number.isFinite(value[componentIndex]) ? String(value[componentIndex]) : ''}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (!Number.isFinite(parsed)) return;
          setComponent(parsed);
        }}
      />
    </label>
  );
}

/**
 * One axis of the rotation row.
 *
 * It is separate from `ScrubAxisInput` because rotation is stored as a quaternion and shown in
 * degrees: the scrub has to convert the whole triple back through Euler angles on every step, which
 * is a different write than setting one component of a stored vector.
 */
function ScrubRotationAxis({
  axis,
  componentIndex,
  degrees,
  disabled,
  onChange,
}: {
  axis: 'X' | 'Y' | 'Z';
  componentIndex: number;
  degrees: Vec3;
  disabled: boolean;
  onChange(value: Quat): void;
}): JSX.Element {
  const setComponent = (next: number) => {
    const out: Vec3 = [degrees[0], degrees[1], degrees[2]];
    out[componentIndex] = next;
    onChange(eulerDegreesToQuaternion(out));
  };
  const scrub = useScrub({
    value: degrees[componentIndex],
    onChange: setComponent,
    step: 1,
    disabled,
  });

  return (
    <label {...stylex.props(styles.axis)}>
      <span
        {...stylex.props(styles.axisLabel, scrub.dragging && styles.axisLabelDragging)}
        onPointerDown={scrub.onPointerDown}
        title={`${axis} — drag to change, Shift for coarse, Alt for fine`}
      >
        {axis}
      </span>
      <input
        {...stylex.props(styles.axisInput)}
        type="number"
        step={1}
        disabled={disabled}
        aria-label={`${axis} component`}
        value={Number.isFinite(degrees[componentIndex]) ? Number(degrees[componentIndex]!.toFixed(3)) : ''}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (!Number.isFinite(parsed)) return;
          setComponent(parsed);
        }}
      />
    </label>
  );
}

function RotationField({
  value,
  disabled,
  onChange,
}: {
  value: Quat;
  disabled: boolean;
  onChange(value: Quat): void;
}): JSX.Element {
  const degrees = quaternionToEulerDegrees(value);
  return (
    <FieldShell
      bare
      hookProps={withDomClass(styles.vectorField, DOM.vectorField)}
      label={
        <span {...withDomClass(styles.fieldLabelBare, DOM.fieldLabel)}>Rotation (°)</span>
      }
    >
      <div {...stylex.props(styles.vectorInputs)}>
        {(['X', 'Y', 'Z'] as const).map((axis, index) => (
          <ScrubRotationAxis
            key={axis}
            axis={axis}
            componentIndex={index}
            degrees={degrees}
            disabled={disabled}
            onChange={onChange}
          />
        ))}
      </div>
    </FieldShell>
  );
}

/**
 * A labelled picker: the field box, the label, and a Radix `Select`.
 *
 * The reference uses a real select for every enumerated property, which is what gives a long option
 * list a scroll affordance, keyboard traversal, and a typeahead. A native `<select>` cannot be styled
 * to match the field boxes around it — the popup is the platform's — so the field would have been the
 * one control in the panel that looked like the operating system rather than the editor.
 *
 * Radix renders this as a `[role="combobox"]` button plus a portalled listbox, so the browser gate
 * helper drives whichever of the two shapes it finds.
 */
function SelectField({
  label,
  value,
  options,
  onValueChange,
  disabled,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onValueChange(next: string): void;
  disabled: boolean;
}): JSX.Element {
  return (
    <FieldShell
      hookProps={withDomClass(styles.field, DOM.field)}
      label={<span {...withDomClass(styles.fieldLabel, DOM.fieldLabel)}>{label}</span>}
    >
      <Select
        label={label}
        value={value}
        options={options}
        disabled={disabled}
        onValueChange={onValueChange}
      />
    </FieldShell>
  );
}

function Section({
  title,
  subtitle,
  defaultOpen,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <section {...withDomClass(styles.section, DOM.section)}>
      <div {...stylex.props(styles.sectionHeaderRow)} role="presentation">
        <button
          {...stylex.props(styles.sectionHeader, styles.sectionHeaderToggle, open && styles.sectionHeaderOpen)}
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span {...withDomClass(styles.sectionTitle, DOM.sectionTitle)}>{title}</span>
          {subtitle && <span {...stylex.props(styles.sectionSubtitle)}>{subtitle}</span>}
          {/**
           * The disclosure sits after the subtitle, not before the title. A leading chevron indents
           * every heading by its own width, which breaks the left edge the labels below depend on;
           * trailing it keeps one alignment line down the whole panel.
           */}
          <span {...stylex.props(subtitle ? undefined : styles.chevronTrailing)}>
            <ChevronRight size={14} style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }} />
          </span>
        </button>
        {actions && <span {...stylex.props(styles.sectionAction)}>{actions}</span>}
      </div>
      {open && <div {...stylex.props(styles.sectionBody)}>{children}</div>}
    </section>
  );
}

export type { CreatableKind };
