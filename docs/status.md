# Implementation status

Tracks progress against the stage gates in `docs/threejs-game-studio-plan.md` §15.
Each stage records how to run it, the demonstrated result, the tests that back it, and the
gaps that are knowingly left open.

| Stage | State | Gate |
|---|---|---|
| 0. Compatibility probe | complete | `pnpm verify:stage0` — 14/14 checks |
| 1. End-to-end authoring loop | complete | `pnpm verify:stage1` — 11/11 checks |
| 2. Comfortable scene editing | not started | — |
| 3. Actual games | not started | — |
| 4. Agent and management workflow | not started | — |
| 5. Reliability and release | not started | — |

## Stage 0 — compatibility probe — **complete**

**Deliverable:** pinned Three.js/Box3D/Vite setup, blank runtime, simple falling box.

**Evidence required:** box renders, physics runs, Stop cleans up, production build loads its
WASM on a static server.

**Status:** all four demonstrated, 14/14 automated checks passing.

### How to run

```bash
pnpm install
pnpm verify:stage0        # typecheck, unit tests, production build, browser + static-server checks
pnpm dev                  # dev server: /probe.html for the probe, /player.html for the player
```

`pnpm verify:stage0 --skip-build` reuses the existing `dist/`; `--headed` shows the browser.

### Demonstrated result

| Requirement | Observed |
|---|---|
| Box renders | 59.9% of a 1280×640 frame differs from the background, 110 distinct colours, mean luminance 51.4 — see `docs/evidence/stage0/probe.png` |
| Physics runs | The box falls from its authored y=4 and rests at y=0.463 … 0.500 on the ground; 52 fixed steps executed; Box3D reports 2 bodies, 1 contact |
| Stop cleans up | After Stop: live physics worlds 0, event listeners 0, renderer geometries 0, canvas WebGL2 context still usable by the next world |
| Repeated Play/Stop | Five cycles, world count returns to 0 each time, no growth in WASM-owned worlds |
| Production build loads WASM | `dist/assets/box3d-*.wasm` (818 KiB) served from a nested path (`/nested/coilbox/`) as `application/wasm`, HTTP 200, no 404s, no dev-server URLs |
| Same runtime in the player | `player.html?project=./probe-project/` loads `game.json`, the scene document, and the asset manifest from plain files and runs the identical runtime |

Raw evidence: `docs/evidence/stage0/evidence.json`, screenshots `probe.png` and `player.png`.

### Tests

- `tests/unit/physics.test.ts` — the real Box3D WASM in Node: resting height, offset hull
  colliders, sensor touch events, raycasts, kinematic movement, world disposal, 20
  create/dispose cycles without leaking a live world.
- `tests/unit/loop.test.ts` — fixed-step behaviour: steps per frame, clamping, backlog drop,
  backgrounding reset, interpolation factor, single-step while paused.
- `tests/unit/schema.test.ts` — schema defaults, non-finite transforms, editor-state vs
  gameplay-state separation, duplicate ids, parent cycles, missing assets, behavior property
  types.
- `tests/unit/scene-graph.test.ts` — document → Three.js projection, disabled subtrees,
  editor helpers, sibling order, orphan handling, unsupported components.
- `tools/verify-stage0.ts` — the gate itself: typecheck, unit tests, build, static server on a
  nested path, headless Chromium checks, and the evidence file.

### Engine quirks found and recorded

These were measured, not assumed; each is recorded in the adapter or the code it affects.

1. `box3d.js@0.1.1` `b3CreateBoxShape` has no offset/rotation parameter, so an offset or
   rotated box collider is built as a transformed hull (`runtime/physics/box3d-adapter.ts`).
2. Sensor touch events require `enableSensorEvents` on **both** the sensor shape and the
   visiting shape; otherwise zero events are delivered.
3. `b3World_CastRayClosest` takes a displacement vector, not a direction; a normalised
   direction would search only one metre.
4. `Object3D.lookAt` aims a plain object's **+Z** at the target but a camera's **-Z**. Using
   the wrong one produced a camera facing 180° away: physics ran, draw calls happened, and the
   frame contained only the background. The engine convention is now "forward is local −Z" for
   cameras and lights, with a regression test.
5. three's `DirectionalLight`/`SpotLight` default to a local `(0, 1, 0)` offset, which would
   put an entity's light one metre from the entity origin; lights are moved to the origin and
   aim along the entity's −Z axis.
6. `WebGLRenderer.forceContextLoss()` makes a canvas unusable for the next world, so Stop
   disposes resources without losing the context (`releaseContext` is opt-in).
7. `PCFSoftShadowMap` is deprecated in three r185; PCF is used.

### Known gaps at this stage

- Model, animation, audio, and behavior components raise an explicit "not implemented in this
  build" error rather than being ignored. They arrive in stages 2 and 3.
- Camera `follow`/`fixed` modes fall back to the authored transform with a warning recorded in
  `world.warnings`; camera behaviours arrive with the gameplay layer.
- No editor shell yet: `index.html` is a landing page. Stage 1 builds it.
- `dist/assets/schema-*.js` is ~700 kB (unminified three.js chunk). Performance work is
  stage 5; the number is recorded here so it is not a surprise later.

## Stage 1 — end-to-end authoring loop — **complete**

**Deliverable:** minimal project list/create, scene schema, one viewport, transform
inspector, save/load, undo, Play/Stop, crude export.

**Evidence required:** move a box, save/reopen it, simulate a fresh copy, stop without
changing authoring state, and run the export independently.

**Status:** all five demonstrated, 11/11 automated checks passing.

### How to run

```bash
pnpm install
pnpm dev               # workspace service + editor dev server, then open http://127.0.0.1:5178/
pnpm verify:stage1     # typecheck, unit tests, build, and the full authoring-loop gate
pnpm studio create my-game && pnpm studio validate my-game   # agent-facing CLI
pnpm studio build my-game                                    # Export Game from a terminal
```

### Demonstrated result

`tools/verify-stage1.ts` drives the real editor in a headless browser against a temporary
workspace, using the same commands the UI uses:

| Requirement | Observed |
|---|---|
| Project create + open | The editor creates `stage1-room` from the blank template and lists Ground, Player, Game Camera, Sun |
| Move a box | Setting the Player's X to 3 in the inspector changes the authored document, and the projected object follows (`[3, 1, 0]`) |
| Undo/redo | `Ctrl+Z` returns the position to 0, `Ctrl+Shift+Z` restores 3 |
| Save | `PUT` reaches the workspace service, the file on disk is at revision 1 with the moved object, and the indicator only reads "Saved" after the write is acknowledged |
| Reopen | Reloading the page and reopening the project loads the saved scene (x = 3) |
| Simulate a fresh copy | Play builds a runtime world on its own canvas: 799 distinct colours rendered, 60+ fixed steps, physics bodies present |
| Stop without changing authoring state | Authored x is 3 before Play and 3 after Stop |
| Export independently | Export Game writes `index.html`, the compiled player, the WASM binary, and `project/`; served on a separate static server with the workspace service shut down, it runs (37.9% of the frame rendered, 0 failed requests) |

Screenshots: `docs/evidence/stage1/editor.png`, `play-mode.png`, `export.png`; raw evidence
in `docs/evidence/stage1/evidence.json`.

### What was built

- **Editing core** (`src/editor/document/`) — one command interface for add, delete,
  duplicate, rename, reparent, transform, component property, enable, and editor state; each
  command is planned with its inverse and validated with the same relationship checks the
  loader uses; transactions roll back entirely; consecutive edits coalesce into one undo
  entry; reparenting preserves the world transform and refuses shear.
- **Workspace service** (`server/`) — project discovery and creation from whole-project
  templates, validated reads, atomic writes with a revision check and bounded recovery
  copies, loopback binding, Host/Origin validation, a per-session write token, and
  workspace-confined paths.
- **Editor shell** (`src/editor/`) — project home, toolbar, hierarchy, inspector, viewport,
  and a bottom panel with assets/scenes/console. React renders panels only; the viewport is
  imperative and never puts per-frame transforms into React state.
- **Export pipeline** (`server/build.ts`) — a fixed build (no shell, no browser-supplied
  arguments) that compiles the player, copies project documents, and writes third-party
  notices.
- **Templates** (`templates/blank/`) generated from code so the starter scene and the
  creation menu cannot drift.

### Tests

77 unit tests across schema, document/commands/history, scene-graph projection, the
physics adapter, and the workspace service — including the plan's data-integrity list
(stale revisions, invalid documents, parent cycles, interrupted saves leaving no temp files,
path traversal, symlink escape, DNS rebinding).

### Known gaps at this stage

- The Assets tab is a placeholder: image/audio/glTF import is stage 2.
- Groups exist as entities and the reparent path is tested, but there is no drag-and-drop in
  the hierarchy yet.
- Camera `follow`/`fixed` modes are authored but not driven; camera behaviours arrive with
  the gameplay layer in stage 3.
- Model, animation, audio, and behavior components show a placeholder in the viewport and
  raise a clear error at Play rather than pretending to work.
- Export is single-project and does not yet generate a per-game behaviour registry (stage 4,
  when behaviours exist).

## Stage 2 — comfortable scene editing — not started

Deliverable: hierarchy/groups, assets, camera/light/material controls, snapping, clip
playback, pause/step, errors.

