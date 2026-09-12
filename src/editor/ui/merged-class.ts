import * as stylex from '@stylexjs/stylex';

/**
 * The class list for a Radix part, as a plain string.
 *
 * Radix's parts take a `className` and merge it themselves, and that merge **replaces** the classes
 * StyleX generated rather than adding to them — verified against the installed version, not assumed.
 * So for a part this code owns, the atomic classes have to be handed over as the part's own
 * `className`; there is no second slot for them.
 *
 * `stylex.props()` is the only thing that may produce that string. The editor's
 * `coilbox/no-classname-after-spread` rule exists to stop `className` being written beside a
 * *component's* spread, where it silently wins; a wrapper that *is* the merge is the different,
 * deliberate case, and naming it here is what makes the difference legible in review.
 */
export function mergedClass(...styles: stylex.StyleXStyles[]): string {
  return stylex.props(...styles).className ?? '';
}
