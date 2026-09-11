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
pnpm studio build my-game                     # standalone web build in .coilbox/export

# Project management
pnpm studio duplicate my-game --as my-game-2 --name "My Game 2"
pnpm studio archive my-game --reason "superseded"
pnpm studio archives
pnpm studio restore <archive-name>
pnpm studio export-source my-game --out my-game.tar.gz
pnpm studio import my-game.tar.gz --as my-game-imported

# Engine work (only when a documented engine gap requires it)
pnpm typecheck
pnpm test                   # unit tests, including the real Box3D WASM in Node
pnpm build                  # builds the editor, player, and probe pages
pnpm verify:stage0 .. :stage3   # the per-stage gates with browser evidence
pnpm games                  # regenerate games/ and their templates from code
pnpm fixtures               # regenerate the binary test fixtures from code
```

Every automated command is bounded, prints why it failed, and exits non-zero on failure.

## Layout

```text
src/
  schema/     project, scene, and component documents (Zod + relationship validation)
  runtime/    the reusable game runtime; never imports editor code
    physics/  Box3D adapter — the only file allowed to import the vendor binding
    behaviors/ registered behaviors, their declarative metadata, and the runtime that runs them
    assets/   GLTF loading, instancing, and asset resolution
    hud/      shared HTML/CSS HUD
    input/    action-based input
  editor/     editor shell, panels, imperative viewport, command history
  player/     standalone game entry point (what an export runs)
server/       local workspace service: project storage, assets, management, build, test
tools/        gates, generators, static server, verification scripts
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
  code. Do not add a second renderer, game loop, input system, or physics world.
- **Vendor calls live in one file** (`src/runtime/physics/box3d-adapter.ts`). Nothing else may
  import `box3d.js`.
- **Registered behaviors, not scripts in data.** A behavior stores a registered id and serialisable
  properties — never a function or a source string.
- **Physics owns dynamic transforms.** The render loop interpolates; it never overwrites them.
- **Play builds a fresh world from a snapshot.** Stop discards it, which is why the authored scene
  cannot be left modified by a simulation.
- **Failures are loud.** Unsupported imports, missing assets, unregistered behaviors, and invalid
  documents produce an explicit message; nothing silently does nothing.
- **Do not edit engine or editor internals to finish a game.** If a game genuinely needs engine
  work, add a registered behavior to `src/runtime/behaviors/library.ts` following
  [`docs/engine-sdk.md`](docs/engine-sdk.md), and say so in your report.

## Environment

- Node.js 24.x, pnpm 11.x. Physics is `box3d.js@0.1.1` (WASM) behind the adapter.
- The workspace root defaults to `games/`; override with `--workspace` or `COILBOX_WORKSPACE`.
- Browser checks run headless Chromium with SwiftShader, so WebGL2 works without a GPU.
