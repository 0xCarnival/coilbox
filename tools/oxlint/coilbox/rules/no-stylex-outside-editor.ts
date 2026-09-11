import { defineRule } from "@oxlint/plugins";

import { isRepoDirectory } from "../shared/paths.ts";

import type { ESTree } from "@oxlint/plugins";

/**
 * AGENTS.md: "**One runtime.** Editor preview, player, and exports all load the same scene format
 * with the same code."
 *
 * Styling is the newest way that invariant can be broken quietly. `@stylexjs/stylex` is an editor
 * dependency: `vite.config.ts` compiles it at build time, and what an export ships is
 * `player.html` plus `src/runtime/`. A single import of `stylex.create` below the runtime boundary
 * would pull the editor's styling toolchain into every exported game, and — because the transform
 * is applied by a build plugin rather than at runtime — the failure would appear as missing styles
 * in a built export, never in the editor where the code already runs.
 *
 * The HUD is the deliberate exception that proves the rule: `src/runtime/hud/hud.ts` injects its own
 * `<style>` element from a template string, so it stays styling-dependency-free and works in an
 * export with no build step of its own.
 */
const EDITOR_DIR = "src/editor";

/** Packages that belong to the editor's styling toolchain, and nowhere else. */
const STYLING_PACKAGES = ["@stylexjs/stylex", "@stylexjs/unplugin", "@stylexjs/babel-plugin"];

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

/** Which styling package a specifier names, or `null` for anything else. */
function stylingPackage(specifier: string | null): string | null {
  if (specifier === null) return null;
  for (const candidate of STYLING_PACKAGES) {
    if (specifier === candidate || specifier.startsWith(`${candidate}/`)) return candidate;
  }
  return null;
}

/**
 * Keep StyleX confined to the editor.
 *
 * This is checked from the *importing* side rather than by naming `src/runtime`, because a strict
 * reading of "one runtime" covers more than the runtime directory: `src/player/` is the export entry
 * point, and `server/` builds exports, so neither may depend on the editor's compiler either.
 */
export const noStylexOutsideEditorRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the editor's styling toolchain outside src/editor; exports must not depend on it.",
    },
    messages: {
      stylexOutsideEditor:
        "`{{specifier}}` is part of the editor's styling toolchain and cannot be used outside `{{editor}}`. An export ships the runtime and the player, so this would make a built game depend on the editor's CSS compiler. Style runtime UI with the injected stylesheet in `src/runtime/hud/hud.ts` instead.",
    },
  },
  create(context) {
    /**
     * The editor owns the toolchain, and the build config that installs the plugin is the other
     * legitimate caller. Everything else — runtime, player, server, tools, tests — is a violation.
     */
    if (isRepoDirectory(context.filename, EDITOR_DIR)) return {};

    const report = (node: ESTree.Node, specifier: string | null): void => {
      const matched = stylingPackage(specifier);
      if (matched === null) return;

      context.report({
        node,
        messageId: "stylexOutsideEditor",
        data: { specifier: matched, editor: EDITOR_DIR },
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
