# Implementation status

Tracks progress against the stage gates in `docs/threejs-game-studio-plan.md` §15.
Each stage records how to run it, the demonstrated result, the tests that back it, and the
gaps that are knowingly left open.

| Stage | State | Gate |
|---|---|---|
| 0. Compatibility probe | complete | `pnpm verify:stage0` — 14/14 checks |
| 1. End-to-end authoring loop | complete | `pnpm verify:stage1` — 11/11 checks |
| 2. Comfortable scene editing | complete | `pnpm verify:stage2` — 13/13 checks |
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

## Stage 2 — comfortable scene editing — **complete**

**Deliverable:** hierarchy/groups, assets, camera/light/material controls, snapping, clip
playback, pause/step, errors.

**Evidence required:** "Build and revise a small scene without editing code; missing asset and
unsupported import errors are understandable."

**Status:** demonstrated, 13/13 automated checks passing.

### How to run

```bash
pnpm dev               # then open http://127.0.0.1:5178/
pnpm verify:stage2     # typecheck, unit tests, build, and the asset/authoring gate
pnpm fixtures          # regenerate the binary test fixtures from code
```

### Demonstrated result

`tools/verify-stage2.ts` drives the real editor against a temporary workspace:

| Requirement | Observed |
|---|---|
| Declared asset subset | `.glb`/`.gltf` models, PNG/JPEG/WebP images, MP3/OGG/WAV audio import; `.fbx` is refused with "FBX is not supported in this version. Export a self-contained .glb…" |
| Compression detection | A GLB requiring `KHR_draco_mesh_compression` imports with that requirement recorded, and the asset list marks it "this version cannot decode it" |
| Import through the editor | Four files import through the UI and appear in the manifest with `sha256:` hashes |
| Model in the viewport | Choosing a model asset loads it into the viewport through the same loader the runtime uses |
| Clip discovery and playback | The animation component lists the model's clips (`Hop`, `Wave`) and the editor preview advances the chosen clip |
| Skinned instances | A skinned model loads, reports its clips, and clones per instance with independent skeletons |
| Property controls | Light intensity, camera field of view, and material colour all edit through the inspector into the authored document |
| Snapping | The snap toggle reaches the transform controls |
| Save/reopen | The scene with two model entities saves at revision 1 and reloads after a full page reload |
| Runtime animation | Play advances both clips inside the play world (≥2 animated entities, models loaded) |
| Missing asset | Deleting the file behind a manifest entry makes the entity report `failed` with a fetch error in the console instead of rendering nothing |
| Console | No unexpected page errors while building and revising the scene |

Screenshots: `docs/evidence/stage2/editor-with-assets.png`, `play-with-models.png`; raw
evidence in `docs/evidence/stage2/evidence.json`.

### What was built

- **Asset service** (`server/assets.ts`) — import with content hashes and stable ids, explicit
  replacement that preserves identity, archival of the replaced original instead of deletion,
  reference checking before removal, and codec detection read straight out of the GLB.
- **Runtime asset layer** (`src/runtime/assets/loader.ts`) — GLTFLoader composition, skeleton-aware
  instancing, per-instance materials, shared geometry, and errors that name the problem
  (`UnsupportedAssetError`, `MissingAssetError`).
- **Animation** (`src/runtime/animation.ts`) — one mixer per instance, clip/loop/speed, advanced on
  the fixed step so Pause and Step behave predictably.
- **Editor** — asset browser with drag-and-drop and per-asset usage, asset and clip pickers in
  the inspector, model previews in the viewport, and asset loading shared with Play through one
  cache.
- **Test fixtures** (`tools/write-fixtures.ts`) — a skinned limb with a clip, a crate with a
  transform clip, a codec-requiring GLB, a non-GLB, a PNG, and a WAV, all generated from code.

### Bugs this stage found (each fixed and covered by a test)

1. `fetch` stored on an instance and called later throws "Illegal invocation" in browsers; the
   adapter now binds the global explicitly. Node's fetch does not have this failure mode, which is
   why only the browser gate caught it.
2. Instance clones share geometry and textures with their source, so per-instance disposal must
   release only materials and skeletons — otherwise the first Stop would corrupt every other
   instance.
3. React's value tracker ignores a colour input whose value is assigned directly in tests; the
   gate now uses the native setter before dispatching.
4. Adding a Model component to an entity that still had a primitive produced an invalid document;
   the editor now replaces the primitive inside one undo step.

### Known gaps at this stage

- Audio components import and are referenced, but playback arrives with the gameplay layer (stage 3).
- `.gltf` files must be self-contained; the loader refuses external `.bin`/texture references with
  an explicit message rather than half-loading them.
- No texture assignment UI yet: imported images are stored and listed, and material colour is
  editable, but image-to-material binding is stage 3 work with the material component.
- Groups exist and reparenting preserves world transforms, but hierarchy drag-and-drop is still
  a button ("Group") rather than a gesture.

