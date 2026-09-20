# AGENTS.md — working in this repository

Coilbox is a local-first game studio: an editor, a reusable Three.js runtime, a local workspace
service, and an export pipeline that produces standalone browser games.

If you are an agent asked to **create or modify a game**, read
[`docs/agent-contract.md`](docs/agent-contract.md) first — it is the contract you are expected to
follow and it links to everything else you need. You rarely need to touch this repository's engine
code to build a game.

## Commands

```bash
pnpm install

pnpm dev                    # workspace service + editor dev server (http://127.0.0.1:5178/)

# Project work (the commands an agent uses)
pnpm studio list                              # projects in the workspace
pnpm studio create my-game --template blank   # templates: blank, collect-room, physics-targets
pnpm studio validate my-game                  # structural and relationship validation
pnpm studio test my-game                      # validate + export + play headlessly, with exit status
pnpm studio build my-game                     # standalone web build in .coilbox/export (--zip file.zip to package it)

# Project management
pnpm studio duplicate my-game --as my-game-2 --name "My Game 2"
pnpm studio archive my-game --reason "superseded"
pnpm studio archives
pnpm studio restore <archive-name>
pnpm studio export-source my-game --out my-game.tar.gz
pnpm studio import my-game.tar.gz --as my-game-imported

# Engine work (only when a documented engine gap requires it)
pnpm lint                   # architectural + low-evidence rules (vendored anti-slop + coilbox)
pnpm typecheck
pnpm test                   # unit tests, including the real Box3D WASM in Node
pnpm build                  # builds the editor, player, and probe pages
pnpm verify:stage0 .. :stage5   # the per-stage gates with browser evidence
pnpm verify                 # every gate in order, with one exit status
pnpm games                  # regenerate games/ and their templates from code
pnpm fixtures               # regenerate the binary test fixtures from code
```

Every automated command is bounded, prints why it failed, and exits non-zero on failure.

## Layout

```text
src/
  schema/     project, scene, and component documents (Zod + relationship validation)
  runtime/    the reusable game runtime; never imports editor code (checked by
              `coilbox/no-runtime-imports-editor`)
    physics/  Box3D adapter — the only file allowed to import the vendor binding
    behaviors/ registered behaviors, their declarative metadata, and the runtime that runs them
    assets/   GLTF loading, instancing, and asset resolution
    hud/      shared HTML/CSS HUD
    input/    action-based input
  editor/     editor shell, panels, imperative viewport, command history
    styles/   design tokens (StyleX) and the shrinking base stylesheet
    dom-contract.ts  class names the browser gates query, plus `withDomClass`
  player/     standalone game entry point (what an export runs)
server/       local workspace service: project storage, assets, management, build, test
tools/        gates, generators, static server, verification scripts
  oxlint/     vendored anti-slop rules and the coilbox architectural rules
games/        the demonstration games (also the default workspace root)
templates/    whole-project starter copies
docs/         the plan, the engine SDK, the project format, and the agent contract
tests/        unit tests and fixtures
```

## Rules that matter

- **The authored document is the source of truth.** Three.js objects are a projection of it. Never
  edit a scene document by hand-editing a running editor's memory or by rewriting a file the
  editor has open without checking the revision.
- **One runtime.** Editor preview, player, and exports all load the same scene format with the same
  code. Do not add a second renderer, game loop, input system, or physics world. (Checked by
  `coilbox/no-additional-renderer`.)
- **Vendor calls live in one file** (`src/runtime/physics/box3d-adapter.ts`). Nothing else may
  import `box3d.js`. (Checked by `coilbox/no-direct-vendor-import`.)
- **Registered behaviors, not scripts in data.** A behavior stores a registered id and serialisable
  properties — never a function or a source string.
- **Physics owns dynamic transforms.** The render loop interpolates; it never overwrites them.
- **Play builds a fresh world from a snapshot.** Stop discards it, which is why the authored scene
  cannot be left modified by a simulation.
- **Failures are loud.** Unsupported imports, missing assets, unregistered behaviors, and invalid
  documents produce an explicit message; nothing silently does nothing.
- **Styling belongs to the editor, and only the editor.** Editor UI is styled with
  [StyleX](https://stylexjs.com) (`stylex.create` in each panel). `src/runtime/**`, `src/player/**`
  and `server/**` must not import `@stylexjs/*` — an export ships the runtime, and a styling
  compiler in that graph would break it only in a built game. Checked by
  `coilbox/no-stylex-outside-editor`. The runtime HUD injects its own `<style>` element instead,
  which is why it works in a standalone export with no build step of its own.
- **Never write `className` after a `stylex.props()` spread.** They are the same JSX attribute, so
  the literal string replaces the generated classes and the element silently renders unstyled. Use
  `withDomClass(...)` from `src/editor/dom-contract.ts` to combine a style with a gate hook.
- **The gate hook classes are a contract.** `src/editor/dom-contract.ts` lists the class names
  `tools/verify-stage*.ts` selects on. They stay as real classes alongside the atomic ones;
  `tests/unit/dom-contract.test.ts` fails if a gate selects a class no panel renders.
- **Lint is a gate, not advice.** `pnpm lint` runs the vendored `anti-slop` rules plus the
  `coilbox/*` architectural rules, and `pnpm verify` fails if it fails. In `src/` and `server/`
  every non-`const` type assertion states the invariant that makes it sound in a `// SAFETY:`
  comment — if you cannot write that sentence, the assertion is hiding a missing parse. See
  [`oxlint.config.ts`](oxlint.config.ts) and
  [`tools/oxlint/anti-slop/README.md`](tools/oxlint/anti-slop/README.md) for what we kept and what
  we deliberately dropped.
- **Do not edit engine or editor internals to finish a game.** If a game genuinely needs engine
  work, add a registered behavior to `src/runtime/behaviors/library.ts` following
  [`docs/engine-sdk.md`](docs/engine-sdk.md), and say so in your report.

## Environment

- Node.js 24.x, pnpm 11.x. Physics is `box3d.js@0.1.1` (WASM) behind the adapter.
- The workspace root defaults to `games/`; override with `--workspace` or `COILBOX_WORKSPACE`.
- Browser checks run headless Chromium with SwiftShader, so WebGL2 works without a GPU.
