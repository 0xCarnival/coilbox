import { useState } from 'react';
import type { JSX } from 'react';
import type { AssetEntry, Component, ComponentType, Entity, JsonValue, Vec3 } from '@schema/index.js';
import { COMPONENT_TYPES, COMPONENT_LABELS } from '@schema/index.js';
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

/**
 * Inspector (plan §3): only the selected object's applicable properties, with readable
 * labels and advanced fields collapsed. Every edit goes through a command, so it is
 * validated and undoable like any other authored change.
 */

export function Inspector({ locked }: { locked: boolean }): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const scene = session.scene;
  const entity = scene?.entities.find((candidate) => candidate.id === snapshot.primarySelection) ?? null;
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  if (!entity || !scene) {
    return (
      <div className="inspector">
        <div className="panel-empty">Select an object to see its properties</div>
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
    <div className="inspector">
      <div className="inspector-title">
        <input
          className="name-field"
          value={entity.name}
          disabled={locked}
          aria-label="Object name"
          onChange={(event) => session.execute({ kind: 'renameEntity', entityId: entity.id, name: event.target.value }, { coalesceKey: `name:${entity.id}` })}
        />
        <label className="enabled-toggle" title="Whether this object exists in the game">
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
          onChange={(value) => setTransform({ position: value as Vec3 })}
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
          onChange={(value) => setTransform({ scale: value as Vec3 })}
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

      <div className="add-component">
        <button type="button" disabled={locked} onClick={() => setAddMenuOpen((open) => !open)}>
          + Add component
        </button>
        {addMenuOpen && (
          <div className="add-menu">
            {COMPONENT_TYPES.filter((type) => isAddable(entity, type))
              .map((type) => ({ type, component: defaultComponent(type, snapshot.assets) }))
              .filter((entry): entry is { type: ComponentType; component: Component } => entry.component !== null)
              .map(({ type, component }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    setAddMenuOpen(false);
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
                </button>
              ))}
            {snapshot.assets.filter((asset) => asset.kind === 'model').length === 0 && (
              <span className="menu-hint">Import a .glb in the Assets tab to add a Model component.</span>
            )}
          </div>
        )}
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
      return componentsFor('box')[0] as Component;
    case 'camera':
      return componentsFor('camera')[0] as Component;
    case 'light':
      return componentsFor('directionalLight')[0] as Component;
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
      return { type: 'material', color: '#cccccc', roughness: 0.8, metalness: 0, emissive: '#000000', emissiveIntensity: 1, opacity: 1, transparent: false, doubleSided: false, flatShading: false, visible: true };
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
  const properties = component.properties as Record<string, JsonValue>;
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
    <Section title={descriptor?.name ?? component.behaviorId} subtitle={component.behaviorId} defaultOpen>
      {!descriptor && (
        <p className="warn">
          “{component.behaviorId}” is not declared in scripts/registry.json, so its properties cannot be edited here.
        </p>
      )}
      {descriptor?.description && <p className="muted">{descriptor.description}</p>}
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
        <div className="advanced">
          <button type="button" onClick={() => setAdvancedOpen((open) => !open)}>
            {advancedOpen ? '− Hide advanced' : `+ ${advanced.length} advanced`}
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
      <div className="component-actions">
        <button type="button" disabled={locked} onClick={() => session.execute({ kind: 'removeComponent', entityId: entity.id, componentType: 'behavior' })}>
          Remove
        </button>
      </div>
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
  const values = component as unknown as Record<string, JsonValue>;

  return (
    <Section title={componentLabel(component)} subtitle={descriptor.summary(component)} defaultOpen>
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
        <div className="advanced">
          <button type="button" onClick={() => setAdvancedOpen((open) => !open)}>
            {advancedOpen ? '− Hide advanced' : `+ ${advanced.length} advanced`}
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
      <div className="component-actions">
        <button
          type="button"
          disabled={locked}
          onClick={() => session.execute({ kind: 'removeComponent', entityId: entity.id, componentType: component.type })}
        >
          Remove
        </button>
      </div>
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
      return (
        <label className="field checkbox">
          <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
          <span>{field.label}</span>
        </label>
      );
    case 'color':
      return (
        <label className="field">
          <span className="field-label">{field.label}</span>
          <input
            type="color"
            value={typeof value === 'string' ? value : '#ffffff'}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      );
    case 'enum':
      return (
        <label className="field">
          <span className="field-label">{field.label}</span>
          <select value={String(value ?? '')} disabled={disabled} onChange={(event) => onChange(coerceEnum(field, event.target.value))}>
            {(field.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      );
    case 'vec3':
    case 'positive-vec3':
      return (
        <div className="field">
          <span className="field-label">{field.label}</span>
          <VectorField
            label=""
            value={(Array.isArray(value) ? value : [0, 0, 0]) as number[]}
            step={field.step ?? 0.1}
            disabled={disabled}
            positive={field.kind === 'positive-vec3'}
            onChange={(next) => onChange(next as unknown as JsonValue)}
          />
        </div>
      );
    case 'quaternion-degrees':
      return (
        <div className="field">
          <span className="field-label">{field.label}</span>
          <RotationField
            value={(Array.isArray(value) ? value : [0, 0, 0, 1]) as [number, number, number, number]}
            disabled={disabled}
            onChange={(next) => onChange(next as unknown as JsonValue)}
          />
        </div>
      );
    case 'asset-reference': {
      const kind = field.key === 'assetId' && entity.components.some((component) => component.type === 'audio') ? 'audio' : 'model';
      const options = snapshot.assets.filter((asset) => asset.kind === kind);
      return (
        <label className="field">
          <span className="field-label">{field.label}</span>
          <select value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
            <option value="">None</option>
            {options.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.id}
              </option>
            ))}
            {typeof value === 'string' && value.length > 0 && !options.some((asset) => asset.id === value) && (
              <option value={value}>{value} (missing)</option>
            )}
          </select>
        </label>
      );
    }
    case 'clip-reference': {
      const clips = snapshot.modelClips[entity.id] ?? [];
      return (
        <label className="field">
          <span className="field-label">{field.label}</span>
          <select
            value={typeof value === 'string' ? value : ''}
            disabled={disabled || clips.length === 0}
            onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">{clips.length === 0 ? 'No clips loaded' : 'First clip'}</option>
            {clips.map((clip) => (
              <option key={clip} value={clip}>
                {clip}
              </option>
            ))}
          </select>
        </label>
      );
    }
    case 'entity-reference':
      return (
        <label className="field">
          <span className="field-label">{field.label}</span>
          <select value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(event) => onChange(event.target.value || null)}>
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
      return (
        <label className="field">
          <span className="field-label">{field.label}</span>
          <input
            type="number"
            value={typeof value === 'number' && Number.isFinite(value) ? value : ''}
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
        </label>
      );
    case 'text':
    default:
      return (
        <label className="field">
          <span className="field-label">{field.label}</span>
          <input
            type="text"
            value={value === null || value === undefined ? '' : String(value)}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value === '' && field.key === 'clip' ? null : event.target.value)}
          />
        </label>
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
  value: readonly number[];
  step: number;
  disabled: boolean;
  positive?: boolean;
  onChange(value: [number, number, number] | number[]): void;
}): JSX.Element {
  return (
    <div className="vector-field">
      {label && <span className="field-label">{label}</span>}
      <div className="vector-inputs">
        {(['X', 'Y', 'Z'] as const).map((axis, index) => (
          <label key={axis} className="axis">
            <span>{axis}</span>
            <input
              type="number"
              step={step}
              disabled={disabled}
              value={Number.isFinite(value[index]) ? String(value[index]) : ''}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                if (!Number.isFinite(parsed)) return;
                const next = [...value];
                next[index] = positive ? Math.max(0.001, Math.abs(parsed)) : parsed;
                onChange(next);
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function RotationField({
  value,
  disabled,
  onChange,
}: {
  value: readonly number[];
  disabled: boolean;
  onChange(value: [number, number, number, number]): void;
}): JSX.Element {
  const degrees = quaternionToEulerDegrees(value);
  return (
    <div className="vector-field">
      <span className="field-label">Rotation (°)</span>
      <div className="vector-inputs">
        {(['X', 'Y', 'Z'] as const).map((axis, index) => (
          <label key={axis} className="axis">
            <span>{axis}</span>
            <input
              type="number"
              step={1}
              disabled={disabled}
              value={Number.isFinite(degrees[index]) ? Number(degrees[index]!.toFixed(3)) : ''}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                if (!Number.isFinite(parsed)) return;
                const next = [...degrees];
                next[index] = parsed;
                onChange(eulerDegreesToQuaternion(next));
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  defaultOpen,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <section className="section">
      <button type="button" className="section-header" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="section-caret">{open ? '▾' : '▸'}</span>
        <span className="section-title">{title}</span>
        {subtitle && <span className="section-subtitle">{subtitle}</span>}
      </button>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

export type { CreatableKind };
