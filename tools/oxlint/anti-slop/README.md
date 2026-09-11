# anti-slop (vendored)

Opinionated Oxlint rules that reject low-evidence TypeScript patterns, vendored into Coilbox on
purpose rather than installed as a dependency — upstream publishes no npm package and asks to be
copied so the copy can be edited to match local standards.

## Provenance

| | |
|---|---|
| Upstream | https://github.com/dmmulroy/anti-slop |
| Revision | `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` |
| License | MIT — see `LICENSE` (Copyright © Dillon Mulroy) |
| Vendored | `src/rules/**` and `src/shared/**` into `rules/**` and `shared/**` |

`oxlint` and `@oxlint/plugins` are pinned to the **same exact version** in `package.json`; upstream
requires this because the plugin API is not stable across Oxlint releases. Upgrade both together.

## What Coilbox removed, and why

Two generic rules and the whole opt-in Effect group were dropped. These are deliberate local
policy decisions, not oversights — upstream expects them.

### `no-shape-in-symbol-names` — removed

Upstream rejects the substring `shape` in locally owned symbol names because `UserShape` is usually
a worse name than `UserSchema`. In this repository the word is domain vocabulary, not a naming tic:
collision **shapes** are a first-class physics concept, and the rule flagged correct code across the
engine —

    ColliderShapeSpec, b3ShapeId, shapeKeyOf, primitiveShape, colliderShape, sensorShapes

Adopting it would have forced a rename of accurate domain terms in the physics layer to satisfy a
rule about naming schemas. The rule source was deleted rather than left disabled so nobody has to
wonder why it is off; re-apply it from upstream if a schema-naming problem ever appears.

### `require-readable-spacing` — removed

It inserts blank lines between declarations. Coilbox has no formatter, this rule is half a
formatter, and measurement showed it firing **2,077 times** across the tree — a diff that size buys
nothing and would fight anyone's editor. Formatting is a separate decision to be made on its own
merits (Oxfmt or Prettier), not smuggled in through a lint rule. This also let us drop the vendored
ESLint Stylistic padding-line engine (`src/vendor/eslint-stylistic/**`, ~1,000 lines) that existed
only to serve it.

### `effect/**` and the five Effect rules — not vendored

Coilbox does not use Effect. Upstream already splits these into a separate plugin for exactly this
reason.

## What Coilbox configured

- `no-runtime-typeof` runs with `{ allowInTypeGuards: true }`. A game runtime must feature-detect
  its host (`typeof document === 'undefined'`, `typeof requestAnimationFrame === 'function'`), and
  isolating that in a type predicate is the honest way to keep it. Ad-hoc narrowing still fails.
- `no-chained-type-assertions` applies everywhere, including `tools/`.
- `require-safety-comment-for-type-assertion` applies to shipped code (`src/`, `server/`) and is
  **off** for `tools/**` and `tests/**`. The verify gates drive Playwright across a process
  boundary that cannot be typed from this side, and the fixture builders construct values whose only
  purpose is to be rejected — a justification comment there would restate the obvious. See
  `oxlint.config.ts`.

## Updating from upstream

Upstream asks that updates preserve local customizations. Because this directory is edited in place,
upstream's bundled install skill cannot three-way merge it directly: fetch the new revision, diff it
against the table above, and port only the rules Coilbox still carries. Any rule that is added
upstream should be evaluated against this repository before being enabled — several of the generic
rules assume a schema-first codebase, which this mostly is, and a physics engine, which it also is.

The `coilbox/*` rules are **not** from upstream. They live in `../coilbox/` and mechanize this
repository's own `AGENTS.md` invariants.

## Two setup requirements that are easy to miss

Both were discovered the hard way while installing this; changing either one silently breaks the
plugin or the typecheck.

1. **`allowImportingTsExtensions` must be on in `tsconfig.json`.** Oxlint loads JS plugins from
   TypeScript source, and these rules import each other with explicit `.ts` extensions (upstream's
   convention, and its own tsconfig sets this flag). Without it `tsc --noEmit` reports dozens of
   `TS5097` errors from inside the vendored code. It is safe here because `noEmit` is also set: the
   build is Vite's job, not `tsc`'s.
2. **The plugin's `context.filename` is only available in `create`, not `createOnce`.** Rules that
   branch on which file they are linting — like all three `coilbox/*` rules — must use `create`,
   which runs per file. `createOnce` runs a single time at plugin registration and throws
   `Cannot access 'context.filename' in 'createOnce'` if you touch it there.

`pnpm lint` also passes `--deny-warnings`, so a rule configured as `warn` still fails the gate.
