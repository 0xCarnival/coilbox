import { defineRule } from "@oxlint/plugins";

import { isRepoDirectory, resolveRelativeSpecifier } from "../shared/paths.ts";

import type { ESTree } from "@oxlint/plugins";

/**
 * AGENTS.md: "`src/runtime/` — the reusable game runtime; never imports editor code."
 *
 * The runtime is what an export ships. Editor code pulls in the document store, panels, command
 * history, and the dev API, so a single import in the wrong direction is enough to make an exported
 * game depend on the editing environment — and it tends to appear as a runtime failure only in a
 * built export, not in the editor preview where the code is already loaded.
 */
const RUNTIME_DIR = "src/runtime";
const EDITOR_DIR = "src/editor";

/**
 * The `@editor` alias from `vite.config.ts` and `tsconfig.json` resolves to `src/editor`, so a
 * runtime file could reach the editor without ever writing a relative path. Checking only relative
 * specifiers would leave that door open.
 */
const EDITOR_ALIAS_PREFIX = "@editor/";

/** Read the literal source of a static import or re-export, ignoring computed specifiers. */
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

/** Read the literal source of a dynamic `import("...")`, ignoring computed arguments. */
function dynamicImportSource(node: ESTree.Node): string | null {
  if (node.type !== "ImportExpression") return null;

  const source = node.source;
  return source.type === "Literal" && typeof source.value === "string" ? source.value : null;
}

/** True when a specifier names the editor, whether by alias or by a resolved relative path. */
function reachesEditor(importer: string, specifier: string): boolean {
  if (specifier === "@editor" || specifier.startsWith(EDITOR_ALIAS_PREFIX)) return true;

  const resolved = resolveRelativeSpecifier(importer, specifier);
  return resolved !== null && isRepoDirectory(resolved, EDITOR_DIR);
}

/** Keep the reusable runtime free of any dependency on the editor. */
export const noRuntimeImportsEditorRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow src/runtime from importing src/editor; the runtime must stay exportable.",
    },
    messages: {
      runtimeImportsEditor:
        "`{{specifier}}` reaches into `{{editor}}`. The runtime is what an export ships and must not depend on the editor. Move the shared piece into `{{runtime}}`, or invert the dependency.",
    },
  },
  create(context) {
    const inRuntime = isRepoDirectory(context.filename, RUNTIME_DIR);

    const report = (node: ESTree.Node, specifier: string | null): void => {
      if (!inRuntime || specifier === null) return;
      if (!reachesEditor(context.filename, specifier)) return;

      context.report({
        node,
        messageId: "runtimeImportsEditor",
        data: { specifier, editor: EDITOR_DIR, runtime: RUNTIME_DIR },
      });
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
