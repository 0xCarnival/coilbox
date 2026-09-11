import { defineConfig } from "oxlint";

/**
 * Coilbox's lint configuration.
 *
 * Two plugin groups, both vendored and both ours to edit:
 *
 * - `anti-slop` (from https://github.com/dmmulroy/anti-slop, MIT) rejects low-evidence patterns —
 *   assertions that assert instead of proving, `unknown` leaking through internal contracts, and
 *   ad-hoc `typeof` narrowing where a parse belongs. See `tools/oxlint/anti-slop/README.md` for
 *   the rules Coilbox removed and why.
 * - `coilbox` mechanizes this repository's own architectural invariants from `AGENTS.md`: the single
 *   vendor boundary, the renderer budget, the runtime-to-editor layering direction, and the
 *   editor-only styling toolchain.
 *
 * Run it with `pnpm lint`. It is also the `lint` gate inside `pnpm verify`.
 */
export default defineConfig({
  ignorePatterns: [
    // Vendored lint code is not written to our style and must never lint itself.
    "tools/oxlint/anti-slop/**",
    "tools/oxlint/coilbox/**",
    // Build output, dependency stores, and scratch clones.
    "node_modules/**",
    ".pnpm-store/**",
    ".scratch/**",
    "dist/**",
    "games/**/.coilbox/**",
    "games/*/dist/**",
    "templates/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "coilbox", specifier: "./tools/oxlint/coilbox/index.ts" },
  ],
  rules: {
    // Accumulating spreads inside reducers/loops: the one upstream rule that lives in Oxc itself.
    "oxc/no-accumulating-spread": "error",

    // Coilbox architectural invariants (this repository's own rules).
    "coilbox/no-additional-renderer": "error",
    "coilbox/no-classname-after-spread": "error",
    "coilbox/no-direct-vendor-import": "error",
    "coilbox/no-runtime-imports-editor": "error",
    "coilbox/no-stylex-outside-editor": "error",

    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",

    // A game runtime must feature-detect its own host, so `typeof` is allowed where it is the
    // documented job of a type predicate. Ad-hoc narrowing elsewhere still fails.
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],

    // Every non-const assertion in shipped code states the invariant that makes it sound.
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
  overrides: [
    {
      // The verify gates drive a real browser through Playwright, and the fixtures build values
      // that exist only to be rejected. Assertions there reach across a process boundary that
      // cannot be typed from this side, so a justification comment would restate the obvious.
      files: ["tools/**", "tests/**"],
      rules: {
        "anti-slop/require-safety-comment-for-type-assertion": "off",
      },
    },
  ],
});
