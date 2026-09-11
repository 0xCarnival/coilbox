# Coilbox

A local-first, open-source game studio built around Three.js: create or generate a game,
open it in the studio, select and move things, change gameplay settings, press Play, save,
and export a standalone browser game.

This repository implements `docs/threejs-game-studio-plan.md`. Progress against the plan's
stage gates is tracked in `docs/status.md`.

## Status

**Stages 0–3 are complete and verified.** The studio can create and open projects, edit a scene
in a viewport with a transform inspector, import models/images/audio, place models and play
their animation clips, undo/redo, save through the workspace service, play the scene with the
same runtime an export uses, stop without disturbing the authored document, and export a
standalone playable web build. Two complete games — `games/collect-room` and
`games/physics-targets` — run on that shared runtime with registered behaviors, input, a HUD,
and game rules.

- `pnpm verify:stage0` — 14/14 checks (runtime, physics, teardown, WASM delivery)
- `pnpm verify:stage1` — 11/11 checks (authoring loop end to end)
- `pnpm verify:stage2` — 13/13 checks (assets, clips, property controls, understandable errors)
- `pnpm verify:stage3` — 13/13 checks (both demo games played end to end, tuning editable)

See `docs/status.md` for the per-stage detail and `docs/evidence/` for the raw results.

## Requirements

- Node.js 24.x (pinned toolchain; see `docs/pinned-versions.md`)
- pnpm 11.x

## Commands

```bash
pnpm install

pnpm dev              # workspace service + editor dev server (http://127.0.0.1:5178/)
pnpm verify:stage0    # stage 0 gate: runtime, physics, teardown, WASM delivery
pnpm verify:stage1    # stage 1 gate: the whole authoring loop in a headless browser
pnpm typecheck        # tsc --noEmit
pnpm test             # unit tests (including the real Box3D WASM in Node)
pnpm build            # production build into dist/

pnpm studio list                  # projects in the workspace
pnpm studio create my-game        # create from a template
pnpm studio validate my-game      # validate a project on disk
pnpm studio build my-game         # export a standalone playable build

pnpm verify:stage2    # stage 2 gate: assets, model instancing, clip playback
pnpm verify:stage3    # stage 3 gate: plays both demo games in a headless browser
pnpm fixtures         # regenerate the binary test fixtures from code
pnpm games            # regenerate the two demo games from code
```

Pages:

- `/index.html` — the editor
- `/probe.html` — stage 0 runtime probe: falling box with Play/Pause/Step/Stop
- `/player.html?project=./probe-project/` — standalone game entry point loading a project
  from plain files, exactly as an exported game does

## Layout

```text
src/
  schema/     project/scene/component validation (Zod plus relationship checks)
  runtime/    reusable game runtime; never imports editor code
    physics/  Box3D adapter — the only module allowed to import the vendor binding
    behaviors/ registered behaviors and their declarative metadata
    assets/   asset identity and resolution
    project/  project loading and validation from files
    probe/    stage 0 probe scene, defined in code so tests and pages share it
  player/     standalone game entry point
  probe/      stage 0 probe page
server/       local workspace service (stage 1+)
tools/        verification, static server, CLI helpers
tests/        unit tests and the stage 0 check suite
docs/         plan, status, pinned versions, evidence
public/       static assets served verbatim (probe project, later templates)
```

## Principles this code follows

- The authored document is the source of truth; Three.js objects are a projection of it.
- One runtime loads the same scene format in editor preview and exported games.
- Every vendor call lives behind `runtime/physics/box3d-adapter.ts`.
- Physics owns dynamic transforms; the render loop interpolates and never fights it.
- Play builds a fresh world from a snapshot, so Stop simply discards it.
- Editor-only visibility and locking never change whether content is enabled in the game.

## Licence

MIT. Third-party notices for bundled dependencies are added with the export pipeline.
