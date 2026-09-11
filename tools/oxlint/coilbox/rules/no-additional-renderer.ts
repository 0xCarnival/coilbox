import { defineRule } from "@oxlint/plugins";

import { isRepoFile } from "../shared/paths.ts";

import type { ESTree } from "@oxlint/plugins";

/**
 * AGENTS.md: "One runtime. Editor preview, player, and exports all load the same scene format with
 * the same code. Do not add a second renderer, game loop, input system, or physics world."
 *
 * Exactly two WebGL contexts exist by design: the reusable runtime's viewport, and the editor's
 * imperative authoring viewport (which must not run the game loop). A third renderer means either a
 * duplicated render path or a leak of an unbounded GPU context — both are silent until they are
 * expensive. Adding one intentionally means editing this list on purpose.
 */
const ALLOWED_FILES = [
  "src/runtime/render/viewport.ts",
  "src/editor/viewport/viewport-controller.ts",
];

/** The constructor names that create a WebGL context in this codebase. */
const RENDERER_NAMES = new Set(["WebGLRenderer"]);

/** Recognize `WebGLRenderer` however it was reached: `THREE.WebGLRenderer` or a named import. */
function constructedRendererName(callee: ESTree.Expression): string | null {
  if (callee.type === "Identifier") {
    return RENDERER_NAMES.has(callee.name) ? callee.name : null;
  }

  if (callee.type !== "MemberExpression" || callee.computed) return null;

  const property = callee.property;
  if (property.type !== "Identifier") return null;
  if (!RENDERER_NAMES.has(property.name)) return null;

  const object = callee.object;
  const owner = object.type === "Identifier" ? object.name : null;
  return owner === "THREE" || owner === "three" ? `${owner}.${property.name}` : property.name;
}

/** Keep the number of WebGL contexts at the two the architecture documents. */
export const noAdditionalRendererRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow creating additional WebGL renderers outside the two allowed viewports.",
    },
    messages: {
      additionalRenderer:
        "Creating `{{renderer}}` adds a WebGL context. The editor and the runtime each own exactly one (`{{allowed}}`). Render through the existing viewport instead.",
    },
  },
  create(context) {
    const permitted = ALLOWED_FILES.some((file) => isRepoFile(context.filename, file));

    return {
      NewExpression(node) {
        if (permitted) return;
        const renderer = constructedRendererName(node.callee);
        if (renderer === null) return;
        context.report({
          node,
          messageId: "additionalRenderer",
          data: { renderer, allowed: ALLOWED_FILES.join("`, `") },
        });
      },
    };
  },
});
