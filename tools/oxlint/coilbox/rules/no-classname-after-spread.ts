import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * AGENTS.md: "**Never write `className` after a `stylex.props()` spread.** They are the same JSX
 * attribute, so the literal string replaces the generated classes and the element silently renders
 * unstyled. Use `withDomClass(...)` from `src/editor/dom-contract.ts` to combine a style with a gate
 * hook."
 *
 * This rule exists because the failure is invisible. JSX permits the duplicate attribute, React
 * renders the element, the DOM looks right, and the only symptom is missing pixels — which is
 * precisely the kind of break that reaches a browser gate as a mysterious layout timeout rather than
 * as a stack trace. During the StyleX migration this exact mistake was made and caught four separate
 * times, in four different files, always looking correct on the page.
 *
 * `withDomClass` merges the two class lists in one place, so the rule points at it rather than
 * banning the combination outright.
 */
const MERGE_HELPERS = ["withDomClass"];

/**
 * What each kind of spread can supply.
 *
 * `withDomClass` composes `className` only — it forwards `style` from StyleX untouched — so an
 * element may legitimately carry its own inline `style` beside it. `stylex.props(...)` can return a
 * `style` object (StyleX moves some values out of the class list), so there an explicit `style` is a
 * genuine collision.
 */
const HELPER_SUPPLIES = ["className"];
const RAW_SUPPLIES = ["className", "style"];

/**
 * Whether a spread is `stylex.props(...)`, spelled as a call on the namespace import.
 *
 * The call form is how the styles are actually written, and it needs its own check: the argument is a
 * `CallExpression` whose callee is a `MemberExpression`, so the generic name extraction below would
 * report only `props` and lose the fact that it came from StyleX.
 */
function isStylexPropsCall(argument: ESTree.Node): boolean {
  if (argument.type !== "CallExpression") return false;
  const callee = argument.callee;
  if (callee.type !== "MemberExpression") return false;
  if (callee.object.type !== "Identifier") return false;
  return callee.object.name === "stylex" && callee.property.type === "Identifier" && callee.property.name === "props";
}

/**
 * The spread attribute's own name, e.g. `props` in `{...props}`.
 *
 * A namespace call is reported as `stylex.props` so the diagnostic names the construct the author
 * actually wrote.
 */
function spreadName(attribute: ESTree.JSXSpreadAttribute): string | null {
  const argument = attribute.argument;
  if (isStylexPropsCall(argument)) return "stylex.props";
  if (argument.type === "Identifier") return argument.name;
  if (argument.type === "MemberExpression" && argument.property.type === "Identifier") {
    return argument.property.name;
  }
  if (argument.type === "CallExpression" && argument.callee.type === "Identifier") {
    return argument.callee.name;
  }
  return null;
}

/** Whether the spread is one that supplies a `className`, and so can be silently overwritten. */
function suppliesClassName(name: string | null): boolean {
  if (name === null) return false;
  if (MERGE_HELPERS.includes(name)) return true;
  return name === "props" || name === "stylexProps";
}

/** True when the element already carries its own attribute of this name. */
function hasExplicitAttribute(opening: ESTree.JSXOpeningElement, name: string): boolean {
  return opening.attributes.some(
    (attribute) => attribute.type === "JSXAttribute" && attribute.name.type === "JSXIdentifier" && attribute.name.name === name,
  );
}

/**
 * Disallow an explicit `className`/`style` on an element that also spreads StyleX output.
 *
 * Only the combination that actually loses data is reported: an explicit `className` written
 * *before* the spread would be overwritten by the spread instead, which is equally wrong but shows
 * up as a missing hook rather than missing styles. Both are reported, because both mean the author
 * wanted the two combined and reached for the wrong tool.
 */
export const noClassnameAfterSpreadRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow an explicit className/style next to a StyleX props spread; the literal replaces the generated classes.",
    },
    messages: {
      classnameOverwritesSpread:
        "`{{attribute}}` is set explicitly on an element that also spreads `{{spread}}`, so one of them silently wins and the other is dropped. Combine them with `withDomClass(...)` from `src/editor/dom-contract.ts` instead.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(opening) {

        const spreads = opening.attributes.filter(
          (attribute): attribute is ESTree.JSXSpreadAttribute => attribute.type === "JSXSpreadAttribute",
        );
        if (spreads.length === 0) return;

        const styleXSpreads = spreads.filter((spread) => suppliesClassName(spreadName(spread)));
        if (styleXSpreads.length === 0) return;

        const isHelper = styleXSpreads.every((spread) => MERGE_HELPERS.includes(spreadName(spread) ?? ""));
        const supplied = isHelper ? HELPER_SUPPLIES : RAW_SUPPLIES;

        for (const name of supplied) {
          if (!hasExplicitAttribute(opening, name)) continue;
          context.report({
            node: opening,
            messageId: "classnameOverwritesSpread",
            data: { attribute: name, spread: styleXSpreads.map((spread) => spreadName(spread)).join(", ") },
          });
        }
      },
    };
  },
});
