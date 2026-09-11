import type { BehaviorDefinition, BehaviorEntry, BehaviorPropertyDescriptor, BehaviorPropertyType } from './types.js';

/**
 * Behavior registry.
 *
 * Metadata is separate from executable gameplay modules (plan §10): `scripts/registry.json`
 * declares IDs and editable property descriptors, the player bundles the executable
 * registry, and behaviors are only constructed in Play or export — never while editing a
 * scene. This class holds the in-memory join of both and validates registrations against
 * the same restricted property-type set.
 */

const ALLOWED_PROPERTY_TYPES: ReadonlySet<string> = new Set<BehaviorPropertyType>([
  'number',
  'boolean',
  'text',
  'enum',
  'entity',
  'asset',
]);

export class BehaviorRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BehaviorRegistrationError';
  }
}

export function validateBehaviorDefinition(definition: BehaviorDefinition): string[] {
  const issues: string[] = [];
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(definition.id)) {
    issues.push(`behavior id "${definition.id}" must be lowercase and may contain a-z, 0-9, ".", "_", "-"`);
  }
  if (!definition.name) issues.push(`behavior "${definition.id}" needs a display name`);
  const seen = new Set<string>();
  for (const property of definition.properties) {
    if (seen.has(property.key)) issues.push(`behavior "${definition.id}" declares property "${property.key}" twice`);
    seen.add(property.key);
    if (!ALLOWED_PROPERTY_TYPES.has(property.type)) {
      issues.push(`property "${property.key}" of "${definition.id}" uses unsupported type "${property.type}"`);
    }
    if (property.type === 'enum' && (!property.options || property.options.length === 0)) {
      issues.push(`enum property "${property.key}" of "${definition.id}" needs at least one option`);
    }
    if (
      (property.type === 'number') &&
      typeof property.default === 'number' &&
      property.min !== undefined &&
      property.default < property.min
    ) {
      issues.push(`default of "${property.key}" is below its minimum`);
    }
  }
  if (typeof definition.create !== 'function') {
    issues.push(`behavior "${definition.id}" is missing a create() factory`);
  }
  return issues;
}

export class BehaviorRegistry {
  private readonly entries = new Map<string, BehaviorEntry>();

  static fromDefinitions(definitions: BehaviorDefinition[]): BehaviorRegistry {
    const registry = new BehaviorRegistry();
    for (const definition of definitions) registry.register(definition);
    return registry;
  }

  register(definition: BehaviorDefinition, source?: string): void {
    const issues = validateBehaviorDefinition(definition);
    if (issues.length > 0) {
      throw new BehaviorRegistrationError(`invalid behavior registration:\n${issues.join('\n')}`);
    }
    if (this.entries.has(definition.id)) {
      throw new BehaviorRegistrationError(`behavior "${definition.id}" is already registered`);
    }
    this.entries.set(definition.id, {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      properties: definition.properties,
      definition,
      source,
    });
  }

  /** Register metadata without executable code (editor-side validation). */
  registerMetadata(entry: Omit<BehaviorEntry, 'definition'>): void {
    if (this.entries.has(entry.id)) {
      throw new BehaviorRegistrationError(`behavior "${entry.id}" is already registered`);
    }
    this.entries.set(entry.id, { ...entry });
  }

  get(id: string): BehaviorEntry | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): BehaviorEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Property descriptors keyed by behavior id then property key. */
  propertyDescriptors(): Map<string, Map<string, BehaviorPropertyType>> {
    const result = new Map<string, Map<string, BehaviorPropertyType>>();
    for (const entry of this.entries.values()) {
      result.set(entry.id, new Map(entry.properties.map((property) => [property.key, property.type])));
    }
    return result;
  }

  /** Default property values for a behavior, used by the inspector and by templates. */
  defaults(id: string): Record<string, unknown> {
    const entry = this.entries.get(id);
    if (!entry) return {};
    return Object.fromEntries(entry.properties.map((property: BehaviorPropertyDescriptor) => [property.key, property.default]));
  }

  /** The declarative registry document written to `scripts/registry.json`. */
  toJSON(): { schemaVersion: number; behaviors: Array<Omit<BehaviorEntry, 'definition' | 'source'>> } {
    return {
      schemaVersion: 1,
      behaviors: this.list().map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        properties: entry.properties,
      })),
    };
  }
}
