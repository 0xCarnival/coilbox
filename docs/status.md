# Implementation status

Tracks progress against the stage gates in `docs/threejs-game-studio-plan.md` §15.
Each stage records how to run it, the demonstrated result, the tests that back it, and the
gaps that are knowingly left open.

| Stage | State | Gate |
|---|---|---|
| 0. Compatibility probe | complete | `pnpm verify:stage0` — 14/14 checks |
| 1. End-to-end authoring loop | complete | `pnpm verify:stage1` — 11/11 checks |
| 2. Comfortable scene editing | complete | `pnpm verify:stage2` — 15/15 checks |
| 3. Actual games | complete | `pnpm verify:stage3` — 14/14 checks |
| 4. Agent and management workflow | complete | `pnpm verify:stage4` — 18/18 checks |
| 5. Reliability and release | complete | `pnpm verify:stage5` — 23/23 checks |

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
| Keyboard focus | Typing `wer` into the name field left the tool on Move and the entity alive: text fields own the keyboard, so W/E/R and Delete do not reach the editor's shortcuts |
| Drag cancellation | A real gizmo drag moved the projection to `[-0.5, 1, 0]` while the document stayed at `[0, 1, 0]`; Escape put the projection back, ended the drag, and left the undo label unchanged |
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
5. Escape during a transform drag recentred the camera and then committed the drag on release, so
   the "drag cancellation" promised in the viewport header did not exist. Escape now cancels the
   drag in progress: the projection returns to the authored transform, the interaction ends, and
   the release records no command.

### Known gaps at this stage

- Audio components import and are referenced, but playback arrives with the gameplay layer (stage 3).
- `.gltf` files must be self-contained; the loader refuses external `.bin`/texture references with
  an explicit message rather than half-loading them.
- No texture assignment UI yet: imported images are stored and listed, and material colour is
  editable, but image-to-material binding is stage 3 work with the material component.
- Groups exist and reparenting preserves world transforms, but hierarchy drag-and-drop is still
  a button ("Group") rather than a gesture.


## Stage 3 — actual games — **complete**

Two demonstration games run on the shared runtime, and their level layout and tuning values are
editable in the inspector.

### How to run

```bash
pnpm games                 # regenerate games/ and the matching templates from code
pnpm verify:stage3         # the gate, with browser evidence
pnpm studio test collect-room      # validate + export + play one game, bounded
```

### Demonstrated result

`tools/verify-stage3.ts` plays both games headlessly through the exported player:

| Requirement | Observed |
|---|---|
| Behaviors registered | `collect-room`: 7 instances across `player.mover`, `game.collectible`, `game.exit-zone`, `camera.follow`, `game.rules` |
| Player input | The player walked 5.54 m from `(0, -6.0)` to `(0, -0.5)` under simulated key input |
| Triggers and score | Visiting three gems left `score 3`, `collectiblesRemaining 0` |
| Win condition | `won=true`, the objective text updated, and the win overlay became visible |
| Restart | After restart the player is back at its spawn and `score=0`, `won=false` |
| Wall contact | Walking into a wall at `z=7.75` stopped the character at `z=7.400` (the face minus its 0.35 m capsule radius), it did not creep in over the next 1.5 s, and walking forward plus right slid it 2.80 m along the wall while staying pinned at `z=7.400` |
| Physics game | `physics-targets`: 5 targets knocked down by 8 launches, `score 5` |
| Editable tuning | Move speed is exposed in the inspector; raising it to 12 made the player cover 10.86 m in 1.2 s instead of about 5 m |
| Console | No page errors during either session |

Screenshots: `docs/evidence/stage3/collect-room-win.png`, `physics-targets.png`,
`studio-play-collect-room.png`; raw evidence in `docs/evidence/stage3/evidence.json`.

### What was built

- **Physics components** (`rigidBody`, `collider`) on the document, with the Box3D adapter as the
  only file that touches the vendor binding.
- **Registered behaviors** (`src/runtime/behaviors/library.ts`): `player.mover`, `game.collectible`,
  `game.exit-zone`, `camera.follow`, `game.rules`, `physics.launcher`, `physics.knockdown`, with
  declarative metadata that drives the inspector.
- **Player layer**: action-based input, HUD (counters, labels, overlays), game state with
  `initialGameState`, scene transitions, and a player entry point that shares the editor's runtime.
- **Character movement** (`context.moveCharacter` + `PhysicsWorldHandle.castMover`): the character
  capsule is swept against the world one horizontal axis at a time, so walls stop it and diagonal
  input slides along them. Vertical movement stays with the mover's own ground probe.
- **Games as documents** (`tools/write-games.ts`): `collect-room` and `physics-targets` are
  generated from code, so the committed scenes can always be reproduced.

### Bugs this stage found (each fixed and covered by a test)

1. The character sank through the floor until the mover applied its spawn height and ground probe
   correctly.
2. Trigger behaviors fired on sensor-*end* events; they now fire on sensor-begin only.
3. The follow camera did not turn with the character, and an object authored facing `+Z` rendered
   backwards.
4. The character walked straight through walls: the mover wrote a teleported kinematic transform
   every tick without ever asking the world what was in the way. Characters now move with a swept
   mover cast (`context.moveCharacter`), which stops them at the contact and slides them along a
   wall. The sweep passes through sensors, so triggers still work, and ignoring the caster's own
   collider is what keeps a character from colliding with itself.

### Known gaps at this stage

- No scripting escape hatch by design: new gameplay needs a registered behavior, not project code.
- One active scene at a time; there is no additive streaming or open world support.

## Stage 4 — agent and management workflow — **complete**

An agent can create a third game from the documented contract, a person can then edit it, and two
projects stay independent.

### How to run

```bash
pnpm studio create my-game --template blank   # templates: blank, collect-room, physics-targets
pnpm studio validate my-game
pnpm studio test my-game
pnpm studio build my-game
pnpm verify:stage4
```

### Demonstrated result

`tools/verify-stage4.ts` drives the CLI and the editor against a temporary workspace:

| Requirement | Observed |
|---|---|
| Contract documents | `AGENTS.md`, `docs/agent-contract.md`, `docs/project-format.md`, `docs/engine-sdk.md` all present and linked |
| Templates | `blank`, `collect-room`, `physics-targets` |
| Agent-built game | `games/gem-rush` validates and `studio test` reports 9/9 checks |
| Editable gameplay | The agent's game exposes `moveSpeed`; a person changed it to 9 in the inspector and it persisted to disk |
| External change | An edit made outside the editor raises the "file changed on disk" banner with *Reload from disk* / *Keep my version* |
| Project independence | Opening `collect-room` afterwards shows its own player, move speed 5, 14 entities, and a fresh history |
| Management | Duplicate, source export/import round trip (6 files), archive, and restore |
| Demo games | `collect-room` and `physics-targets` still pass their bounded tests |

Screenshot: `docs/evidence/stage4/editor-agent-game.png`; raw evidence in
`docs/evidence/stage4/evidence.json`.

### What was built

- **CLI** (`server/cli.ts`): `list`, `create`, `validate`, `test`, `build`, `duplicate`, `archive`,
  `archives`, `restore`, `export-source`, `import`, and `api`/`dev`.
- **Management** (`server/management.ts`, `server/archive.ts`): dependency-free `tar.gz` source
  archives, duplicate with a new id, archive/restore, and reference-safe deletion.
- **Conflict handling** (`server/watcher.ts`): debounced external-change events over SSE, and saves
  refused when the revision moved on.
- **Agent contract** (`docs/agent-contract.md`): the create → validate → test → report loop a game
  agent follows, including the behavior registry it may use without touching engine code.

### Bugs this stage found (each fixed and covered by a test)

1. `studio validate` did not check behavior ids or property types against the project's registry;
   it now loads `scripts/registry.json` and reports unknown ids and mistyped properties.
2. A time-limited round counted wall-clock time, so a backgrounded tab lost the round; the clock now
   counts fixed simulation steps and waits for the start overlay.
3. A loss could overwrite an already-won round; a win is now final.

### Known gaps at this stage

- Archives are local directories under `<workspace>/.archive/`; there is no remote storage.
- `studio test` runs one project at a time.

## Stage 5 — reliability and release — **complete**

Compatibility fixtures, resource ownership, measured performance, and the startup/recovery
documentation, with every release acceptance test recorded.

### How to run

```bash
pnpm verify:stage5                 # typecheck, unit tests, clean-checkout build, browser + export checks
pnpm verify:stage5 --skip-build --skip-clean-clone   # reuse dist/ and the working tree
pnpm verify                        # every gate in order
```

### Demonstrated result

`tools/verify-stage5.ts` passes 23/23 checks (22 with `--skip-clean-clone`, which drops the
clean-checkout check). `pnpm verify` runs every gate in order and reports 6/6 passing:
`14/14`, `11/11`, `15/15`, `14/14`, `18/18`, `23/23`. The measured and observed results:

| Requirement | Observed |
|---|---|
| Compatibility fixtures | `tests/fixtures/projects/{compat-current,compat-future,compat-invalid}`: the current version loads, a newer `schemaVersion` is refused with an explicit message, an invalid document is refused |
| Clean checkout | A fresh `git clone` of the committed tree installs from the frozen lockfile, typechecks, tests, and builds |
| Resource ownership | 20 Play/Stop cycles on `collect-room`: geometries 10→10, textures 3→3, listeners 2→2, physics bodies 10→10, HUD elements 4→4 |
| Reference scene | 203 entities, 26 physics bodies, 401 draw calls, 4812 triangles; median frame 36.3 ms, p95 37.8 ms, physics 0.03 ms under SwiftShader |
| Frame-rate independence | A 400 ms stall produced 20 steps with 0.183 s dropped and 0.117 s clamped, and a 1.2 s wait produced about the 72 steps a 60 Hz loop owes |
| Narrow viewport | 390×844: 60.7% of pixels rendered, 76 steps — a viewport test, not a phone test |
| User acceptance session | Open `gem-rush`; move five objects to x=1.25; replace a model (`spinning-crate` → `animated-limb`, both loaded in the viewport); set move speed 7, undo to 6, redo to 7; Play 66 steps with 9 behaviors; Stop; reopen with every edit intact; export from the editor |
| Export independence | The export runs from `/releases/2026/gem-rush/` on a separate static server with the workspace service shut down: 8 requests, 0 failures, 1 WASM served as `application/wasm`, no dev URLs, 78 steps of gameplay, audio activated by a user gesture, and restart returning the run to its authored initial state (`score 2 → 0`, collectibles `3 → 5`, new world) |
| Bounded project tests | `collect-room`, `physics-targets`, and `gem-rush` each pass 9/9 checks |
| Console | No page errors in the studio, the games, or the export |

Screenshots: `docs/evidence/stage5/acceptance-play.png`, `narrow-viewport.png`; raw measurements in
`docs/evidence/stage5/evidence.json`.

### What was built

- **Compatibility fixtures and tests** (`tests/fixtures/projects/`, `tests/unit/compatibility.test.ts`):
  older/current, newer, and invalid documents, pinned by version.
- **Version refusal**: `parseScene`/`parseGame` report `unsupported-schema-version`, and the readers
  refuse to load instead of silently accepting a document from a newer studio.
- **Audio activation** (`src/runtime/world.ts`): the world arms a one-shot gesture listener on
  start, so the editor, the player, and an export get working audio without the host remembering.
- **Play/Stop ownership**: the player handle exposes live `session`/`game`/`scene` getters rather
  than a frozen snapshot, which the 20-cycle audit depends on.
- **Mover casts** (`PhysicsWorldHandle.castMover`): the vendored `b3World_CastMover` sweep, with
  sensors excluded and the caster's own body filtered out, covered by a Node test alongside the
  real WASM.
- **Release documentation**: `docs/runbook.md` (start, recovery, exports, limits) plus this status.

### Bugs this stage found (each fixed and covered by a test)

1. The workspace service hung on shutdown while an editor tab held an event stream open; closing now
   ends the streams and closes lingering connections.
2. The verification static server buffered proxied responses, so SSE never reached the browser; the
   proxy now streams.
3. Concurrent atomic writes could collide on a temporary file name; the name now includes a random
   suffix.
4. A corrupt `game.json` was reported as "project not found"; the parse error is now surfaced.
5. A newer `schemaVersion` was accepted silently; it is now refused with the version it saw.
6. Audio never activated in the player or an export because nothing armed a gesture listener.
7. The stage gate itself reused a `.coilbox` export copied from the working tree, so it verified a
   stale bundle; it now strips build output from the workspace copy and always builds the export it
   tests.

### Known gaps at this stage

- Performance is measured under a software rasteriser in headless Chromium, not on the M1 Pro
  reference machine; the numbers are recorded as conditions, not as a promise for arbitrary content.
- Mobile support is **not** claimed. A narrow viewport is tested; a real device is not.
- The reference scene is the only performance contract: a declared 200 objects, 25 dynamic bodies,
  and one shadow light. Other content is not characterised.
