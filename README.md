# Coilbox

A local-first, open-source game studio built around Three.js: create or generate a game,
open it in the studio, select and move things, change gameplay settings, press Play, save,
and export a standalone browser game.

This repository implements `docs/threejs-game-studio-plan.md`. Progress against the plan's
stage gates is tracked in `docs/status.md`.

## Status

**Stage 0 (compatibility probe) is complete and verified**: pinned Three.js/Box3D/Vite
setup, a blank runtime with a falling box, physics that runs, teardown that releases what it
owns, and a production build that loads its WASM from a static server under a nested path.
See `docs/evidence/stage0/`.

The editor shell arrives with stage 1. `index.html` is currently a landing page.

## Requirements

- Node.js 24.x (pinned toolchain; see `docs/pinned-versions.md`)
- pnpm 11.x

## Commands

```bash
pnpm install

pnpm dev              # development server (editor shell, probe, player)
pnpm verify:stage0    # full stage 0 gate: typecheck, tests, build, browser + static-server checks
pnpm typecheck        # tsc --noEmit
pnpm test             # unit tests (run the real Box3D WASM in Node)
pnpm build            # production build into dist/
```

Development pages:

- `/index.html` — landing page (editor shell in stage 1)
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
