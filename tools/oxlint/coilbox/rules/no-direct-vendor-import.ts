import { defineRule } from "@oxlint/plugins";

import { isRepoFile } from "../shared/paths.ts";

import type { ESTree } from "@oxlint/plugins";

/**
 * AGENTS.md: "Vendor calls live in one file (`src/runtime/physics/box3d-adapter.ts`). Nothing else
 * may import `box3d.js`."
 *
 * The physics binding is the sharpest edge in this repository: it is WASM, it owns dynamic
 * transforms, and it is the only dependency whose types cannot be trusted at the call site. Every
 * call belongs behind the adapter's narrow interface so the rest of the runtime can be reasoned
 * about — and tested — without it.
 */
const ADAPTER = "src/runtime/physics/box3d-adapter.ts";

const VENDOR_PACKAGE = "box3d.js";

/** Reads the literal source of an import/export declaration, ignoring computed specifiers. */
function declarationSource(node: ESTree.Node): string | null {
  if (
    node.type !== "ImportDeclaration" &&
    node.type !== "ExportNamedDeclaration" &&
    node.type !== "ExportAllDeclaration"
  ) {
    return null;
  }

  const source = node.source;
  if (source === null || source === undefined) return null;
  return source.type === "Literal" && typeof source.value === "string" ? source.value : null;
}

/** Reads the literal source of a dynamic `import("...")`, ignoring computed arguments. */
function dynamicImportSource(node: ESTree.Node): string | null {
  if (node.type !== "ImportExpression") return null;

  const source = node.source;
  return source.type === "Literal" && typeof source.value === "string" ? source.value : null;
}

/** Keep the vendor binding reachable only through the adapter that documents and narrows it. */
export const noDirectVendorImportRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing the box3d.js vendor binding outside src/runtime/physics/box3d-adapter.ts.",
    },
    messages: {
      directVendorImport:
        "Import the physics adapter instead of `{{vendor}}`. Vendor calls live in `{{adapter}}` only, so the rest of the runtime never sees a raw binding id.",
    },
  },
  create(context) {
    const report = (node: ESTree.Node, source: string | null): void => {
      if (source !== VENDOR_PACKAGE) return;
      if (isRepoFile(context.filename, ADAPTER)) return;
      context.report({ node, messageId: "directVendorImport", data: { vendor: VENDOR_PACKAGE, adapter: ADAPTER } });
    };

    return {
      ImportDeclaration(node) {
        report(node, declarationSource(node));
      },
      ExportNamedDeclaration(node) {
        report(node, declarationSource(node));
      },
      ExportAllDeclaration(node) {
        report(node, declarationSource(node));
      },
      ImportExpression(node) {
        report(node, dynamicImportSource(node));
      },
    };
  },
});
