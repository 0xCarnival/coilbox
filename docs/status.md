# Implementation status

Tracks progress against the stage gates in `docs/threejs-game-studio-plan.md` §15.
Each stage records the commit, how to run it, the demonstrated result, the tests that back
it, and the gaps that are knowingly left open.

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

## Stage 1 — end-to-end authoring loop — not started

Deliverable: minimal project list/create, scene schema, one viewport, transform inspector,
save/load, undo, Play/Stop, crude export.
