/**
 * Unit conversion for the editor's numeric fields.
 *
 * ## The document is always metres
 *
 * Nothing here is stored. A scene's coordinates, sizes, and distances are metres in the document and
 * in the runtime; this module exists so a person who thinks in feet can *read and type* feet. That
 * boundary is the whole design: converting on write would mean a scene authored in one unit and
 * opened in another disagrees with itself, and a physics solver that works in metres would be handed
 * feet.
 *
 * ## Why it is one module
 *
 * Every conversion in the editor goes through `toDisplay` and `toMetres`. The alternative — each
 * field multiplying by 3.28084 inline — is how a codebase ends up with three slightly different
 * conversion factors and one field that rounds differently from its neighbour. The field layer asks
 * this module what to show and what a typed value means, and does no arithmetic of its own.
 */

/** The unit systems the editor offers. */
export type UnitSystem = 'metric' | 'imperial';

/** What a field's value means, which decides whether it converts at all. */
export type Quantity = 'length' | 'angle' | 'scalar';

const METRES_PER_FOOT = 0.3048;
const FEET_PER_METRE = 1 / METRES_PER_FOOT;

/** The suffix shown after a value, for the unit system and quantity in play. */
export function unitSuffix(system: UnitSystem, quantity: Quantity): string {
  if (quantity === 'angle') return '°';
  if (quantity === 'scalar') return '';
  return system === 'imperial' ? 'ft' : 'm';
}

/**
 * A stored value, as the number to show.
 *
 * Only lengths convert. An angle is degrees in both systems, and a scalar — a gravity multiplier, a
 * roughness — is unitless, so converting them would be inventing a relationship that does not exist.
 */
export function toDisplay(metres: number, system: UnitSystem, quantity: Quantity): number {
  if (quantity !== 'length' || system === 'metric') return metres;
  return metres * FEET_PER_METRE;
}

/** A number the user typed, as the value to store. The inverse of `toDisplay`. */
export function toMetres(value: number, system: UnitSystem, quantity: Quantity): number {
  if (quantity !== 'length' || system === 'metric') return value;
  return value * METRES_PER_FOOT;
}

/**
 * How many decimal places to show.
 *
 * Imperial needs one more than metric for the same precision, because a foot is shorter than a
 * metre: two decimals of metres is centimetres, and two decimals of feet is about 3 mm. Showing both
 * at two places would make every imperial field look coarser than its metric twin.
 */
export function precisionFor(system: UnitSystem, quantity: Quantity): number {
  if (quantity === 'scalar') return 3;
  if (quantity === 'angle') return 1;
  return system === 'imperial' ? 3 : 2;
}

/** A value with its suffix, for a readout. */
export function format(value: number, system: UnitSystem, quantity: Quantity): string {
  const shown = toDisplay(value, system, quantity);
  const suffix = unitSuffix(system, quantity);
  const text = shown.toFixed(precisionFor(system, quantity));
  return suffix.length > 0 ? `${text} ${suffix}` : text;
}

/** The label for a unit-system choice, for a settings row. */
export const UNIT_LABELS: Readonly<Record<UnitSystem, string>> = {
  metric: 'Metric',
  imperial: 'Imperial',
};
