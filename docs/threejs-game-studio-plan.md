# Three.js Game Studio — implementation plan

**Prepared for the project owner · 11 September 2026**

## 1. Product decision

Build a small, open-source game editor around Three.js, not a replacement for every feature in Unreal or Godot.

The desired workflow is:

> Create or generate a game → open it in the studio → select and move things → change gameplay settings → press Play → save → export a standalone browser game.

The studio is for one creator working with coding agents. Agents implement gameplay and generate scene content; The owner controls placement, appearance, tuning, testing, and project management without editing code for those routine tasks.

**Version-one assumptions:** desktop browser authoring, ordinary local project folders, a small local workspace service, single-user editing, and standalone web-game output. Editing is browser-based but is not a hosted cloud service. The game export must not need the editor or local service. Roblox import/export is outside this plan.

Keep the earlier technical direction: imperative Three.js runtime, React for editor panels only, and Box3D through a narrow adapter. Do not switch to a different rendering engine or introduce a proprietary editor dependency.

This is a proposed implementation specification, not a claim that the implementation or its performance has been tested.

## 2. The first useful result

The first complete demonstration is a small collect-and-exit game. A player moves around a room, collects items, and reaches an exit. The owner can drag the exit to another wall, duplicate collectible objects, change player speed in the inspector, play the modified game, and export it.

The second demonstration is a physics target game: click or launch a simple object to knock over targets, count successful hits, and restart. It must use the same engine and editor, not a separate hard-coded application.

These two examples are the scope filter. Build a general feature only when it is needed for their shared authoring workflow. Game-specific rules belong in the games, not in the editor core.

A rotating cube in an attractive editor is not completion. A generated game whose objects cannot be edited is also not completion.

## 3. User interface

Use one fixed, resizable layout rather than implementing a window-management system.

| Area | Contents |
|---|---|
| Project home | Game cards, create, open, duplicate, rename, archive, import, and export source |
| Top toolbar | Project and scene name; Save; undo/redo; move/rotate/scale; snap; Play/Pause/Step/Stop; Export Game |
| Left panel | Scene hierarchy with search, selection, rename, visibility, lock, and grouping |
| Center | Large 3D viewport with grid, selection outline, transform handles, and optional camera preview |
| Right panel | Only the selected object's applicable properties and an Add Component menu |
| Bottom panel | Assets, scenes, and errors/console as tabs |

The viewport should occupy most of the screen. Use readable labels such as “Move speed,” “Collision shape,” and “Camera target.” Keep advanced rendering and physics fields collapsed.

Separate editor-only visibility/locking from whether an object is enabled in the actual game. Do not silently make a hidden editor helper into disabled gameplay content.

Essential interactions are click selection, orbit/pan/zoom, focus selection, drag to place, numeric transforms, duplicate, delete, and keyboard undo/redo. Use G/R/S (Blender-style; W/E remain aliases) for transform tools only while the viewport has authoring focus; text fields and Play mode must not trigger editor shortcuts. Include trackpad-friendly camera navigation.

Support single-object and multi-selection transforms. Parent/group movement provides a simple way to move assemblies, while multi-selection uses an editor-only centroid pivot and preserves authored local transforms.

### Example inspector

Selecting the player should show approximately:

```text
Player
  Position       X / Y / Z
  Rotation       X / Y / Z
  Scale          X / Y / Z

Character movement
  Move speed     5
  Jump strength  7

Camera follow
  Distance       8
  Height         5

Model
  Asset          player.glb
  Animation      Idle
```

These are examples of fields the implementation should expose, not existing engine APIs. Only show jump settings when the attached controller supports jumping.

## 4. Version-one scope

| Capability | Implement | Deliberate limit |
|---|---|---|
| Projects | Create, open, rename, duplicate, archive, thumbnails, source backup | Local folders; no accounts or collaboration |
| Scenes | Create, duplicate, rename, start scene, basic scene transitions | No streaming worlds or scene inheritance |
| Object editing | Hierarchy, groups, transforms, snapping, duplicate/delete, undo/redo | No mesh modeling or linked prefabs |
| Objects | Empty group, box, sphere, plane, camera, light, imported model | A compact creation menu |
| Assets | Self-contained GLB models, PNG/JPEG/WebP images, tested audio formats | No FBX or Blender-file importer in v1 |
| Appearance | Basic material fields, one main shadow light, background and fog | No shader graph, path tracer, or material editor suite |
| Physics | Static/dynamic/kinematic bodies, primitive colliders, sensors, raycasts | No vehicle, ragdoll, or joint-authoring suite |
| Gameplay | One basic player mover, follow/fixed camera, input, interaction, triggers, score, restart | No visual programming language |
| Animation | Play imported clips; choose clip, loop, speed | No rigging, retargeting, or timeline authoring |
| Game UI | Small HTML/CSS HUD: label, counter, button, start/win/restart overlay | No drag-and-drop UI designer |
| Scripts | Registered TypeScript behaviors with editable properties | Existing IDE/agent workflow, not an embedded IDE |
| Generation | Documented agent contract, templates, validation, external-change handling | No in-editor AI API integration required for v1 |
| Export | Static playable web build and separate source-project archive | No native, console, or Roblox export |

GLTFLoader already loads glTF assets and exposes imported animation clips; AnimationMixer provides clip playback. The studio should compose those existing facilities rather than write new import or animation engines. [S3][S4]

## 5. Stack and reuse policy

Use **TypeScript, Vite, React, plain Three.js, Box3D WASM, Zod, and a small Node workspace service**. Keep one repository and one dependency lockfile initially. Choose the current supported Node version compatible with the pinned build tools when implementation begins; record the actual versions.

React owns toolbars and panels. The runtime owns objects, input, animation, physics, and rendering. Do not put per-frame object transforms into React state. Avoid using both React Three Fiber and imperative Three.js to own the same scene.

Start with Three.js WebGLRenderer and a WebGL2 capability check. WebGPU is not a v1 requirement. Renderer changes must not alter the saved project format. [S9]

Reuse OrbitControls, TransformControls, raycasting, loaders, cameras, lights, and animation playback. TransformControls already supplies translate/rotate/scale interaction and snapping-related facilities. [S2]

Use the official Three.js editor as a reference for selection, history, serialization, and authoring workflows. Its history implementation uses commands. Prefer selective reuse with retained notices over an automatic wholesale fork that would dictate the studio's architecture. Three.js is MIT-licensed. [S1]

The previously discussed `mrdoob/toys` is a useful interaction and Box3D integration reference, not a multi-project studio foundation. It demonstrates build/play and physics, but this project needs its own project document, runtime contract, and export pipeline. [S5]

### Physics choice

Keep **Box3D**, using `isaac-mason/box3d.js` as the initial binding to evaluate. Its documented interface provides TypeScript definitions and both ordinary WASM and inline browser builds. Start with the non-multithreaded build so deployment does not depend on thread-specific isolation headers. Verify the exact chosen build in both development and exported games before committing the dependency. [S6]

Do not silently mix code examples from `box3d.js` and `box3d-wasm`; they are different bindings. Put all vendor calls inside `runtime/physics/box3d-adapter.ts`. Record the binding version and upstream revision where available. No second physics backend is needed for v1.

## 6. Architecture: four responsibilities

| Responsibility | Owns | Must not own |
|---|---|---|
| Project documents | Authored entities, properties, scenes, settings, asset references | Live Three.js objects or running script instances |
| Editor | Selection, tools, inspectors, command history, authoring viewport | A second implementation of gameplay |
| Runtime/player | Scene construction, gameplay, input, physics, rendering, cleanup | Filesystem access or editor UI imports |
| Workspace service | Project discovery, safe file IO, validation, builds, change notifications | Arbitrary remote shell execution or public code hosting |

A suggested small repository layout is:

```text
src/
  schema/                 # Project/scene/component validation
  runtime/                # Reusable game runtime; no editor imports
    physics/
    behaviors/
    assets/
  player/                 # Standalone game entry point
  editor/                 # Panels, tools, command history
server/                   # Local workspace API
tools/                    # Validation/build/agent helpers
games/
  collect-room/
  physics-targets/
templates/                # Whole-project starter copies, not linked prefabs
docs/
tests/
```

One runtime must load the same scene format in both editor preview and exported games. The player build must exclude editor code and workspace credentials.

## 7. Project format and source of truth

Each game is an ordinary folder:

```text
my-game/
  game.json               # Project ID, versions, settings, start scene
  scenes/
    main.scene.json
  assets/
    manifest.json
    models/
    images/
    audio/
  scripts/
    registry.json         # Declarative behavior metadata
    player.ts
    rules.ts
  thumbnail.png
  README.md
```

`game.json` records the project schema version, engine compatibility version, scene list, start scene, and game-level settings. Keep the schema version distinct from document revision numbers used to detect concurrent edits.

A scene stores stable entity IDs, display names, parent IDs, local transforms, explicit sibling order, enabled state, and typed component records. A scene also identifies its active game camera. Store positions in meters, time in seconds, and rotations as normalized quaternions; present rotation controls in degrees. Use a documented Y-up coordinate convention throughout.

Components should remain a small typed union: renderable model/primitive, material override, camera, light, rigid body, collider, audio, animation, and behavior reference. A behavior stores its registered ID and serializable properties, not a function or arbitrary source-code string.

Do not serialize the live Three.js scene as the entire game format. Rendering objects are a projection of project data. Game rules, asset identity, compatibility, and exposed properties need their own stable representation.

Validation must check structure and relationships: unique IDs, existing parents and asset references, no parent cycles, valid camera references, finite transforms, supported components, valid behavior properties, and compatible schema versions. Zod provides the validation primitives; relationship checks remain application logic. [S7]

Unknown or newer schema versions must produce a recoverable error without rewriting the original file. Any migration creates a backup and has a fixture test.

**Decision:** only entities represented in these documents are persistent editable level content. Runtime-spawned effects and enemies are transient unless a later explicit authoring operation converts them to saved content.

## 8. Editing, history, and play-state separation

Every committed authored change goes through one command interface: add, delete, duplicate, rename, reparent, set transform, or set component property. The same validation applies to UI changes and proposed scene changes from agents.

A drag produces temporary viewport feedback and one history entry on release, not hundreds of entries. Escape cancels the drag. Inspector editing also coalesces sensible edit sessions. Reparenting must preserve the world transform when the result can be represented safely; reject unsupported shear rather than corrupting it.

Changing a property updates the document, updates the editor projection, marks the project dirty, and schedules a save. A displayed “Saved” indicator means the workspace service acknowledged the write, not merely that a local timer elapsed.

### Play lifecycle

On Play, snapshot the authored document and create a fresh runtime world from it. Do not simulate directly on the author's live scene and attempt to undo the physics afterward.

Use the same runtime code as export. Disable authoring operations during Play in v1. Pause stops simulation; Step advances exactly one fixed simulation tick while paused. Stop disposes gameplay state and restores the unchanged authored scene. Do not implement “apply play-mode changes” yet.

Use a fixed physics step, initially 1/60 second, with a capped accumulator and rendering interpolation. Clamp long delays and reset accumulated time after backgrounding. Variable frame rate must not mean one physics step per rendered frame. Record substep choices in the runtime settings and test them. This is not a promise of bitwise cross-browser determinism.

Physics owns dynamic-body transforms. Character and kinematic movement go through the physics adapter. The render loop must not fight the physics system by overwriting those transforms independently.

A preview frame or tab helps separate runtime lifecycle from editor UI, but is not a security or infinite-loop guarantee. Catch ordinary script errors, identify the responsible script/entity, and provide a restart path. Treat project scripts as trusted local code in v1; do not advertise execution of hostile uploaded games as safe.

## 9. Asset and physics rules that prevent common failures

Import self-contained GLB files first. Store immutable originals with stable asset IDs and content hashes. Moving or renaming an asset must not break every scene reference. Replacing an asset should preserve its identity only through an explicit replacement operation.

Select imported models as one scene entity by default, with their internal meshes collapsed. Preserve their hierarchy and original materials. Apply placement and unit adjustments through an instance root rather than rewriting the original model.

Implement skeleton-aware instance creation for skinned assets and independent animation playback per instance. Clone instance-specific material state so recoloring one object does not recolor every instance. Imported clips should be discoverable without implementing animation editing.

Support only a declared, tested asset subset. Detect required compression extensions and either bundle the matching decoder or display a useful unsupported-format error. Do not make unsupported imports appear to succeed. GLTFLoader documents decoder setup for compressed formats. [S3]

Provide a bounds-fitted box collider as the simple default, with editable size and offset. Do not describe it as an exact collision shape. Start with boxes, spheres, and capsules; complex mesh collision authoring can wait.

Require physics-body entities to be scene roots in v1. Their visual child models may have local offsets. Ordinary non-physics groups may be nested. Reject unsupported non-uniform/negative physics scaling and offer explicit collider sizing instead of silently producing incorrect collisions.

Show collision outlines and body type in debug mode. Verify sensors and collision events explicitly, including the binding's event flags. Do not assume the renderer's visible geometry and the physics shape automatically stay aligned.

Resource ownership is mandatory: stop input listeners and audio, cancel pending loads, dispose per-instance render resources when no longer referenced, and destroy physics worlds on teardown. Follow the selected binding's ownership rules. Box3D's binding documentation distinguishes world-owned objects from separately managed data. [S6]

## 10. Small gameplay layer

Use registered behaviors, not a large entity-component framework or visual scripting language. The runtime only needs predictable lifecycle hooks: creation/start, fixed update, frame update, event handling, and disposal.

Provide a narrow game-facing context for entity lookup, input actions, physics operations, audio, scene loading, and game state. Define actions such as move, jump, interact, and restart independently from keyboard bindings so touch controls can later target the same actions.

The first behavior library should cover a character mover, a follow/fixed camera, interactable objects, collectible/trigger logic, a score/win/restart loop, and animation/audio playback. A simple move-between-points behavior is reasonable once a sample needs it. Do not build every genre's controller at once.

Keep metadata separate from executable gameplay modules. `scripts/registry.json` declares behavior IDs and editable property descriptors using a restricted set: number, boolean, text, enum, entity reference, and asset reference. Derive inspector controls and property validation from those descriptors. Validate TypeScript registrations against the same contract during builds.

Editing a scene must not execute arbitrary behavior constructors. The player bundles the executable registry and creates behaviors only in Play or export.

A basic HUD is shared HTML/CSS code mounted by the runtime, with data bindings to a small game-state object. Expose useful labels, colors, and values; do not build a general UI layout editor.

## 11. How agents generate games

Make the studio agent-friendly before adding an in-editor chat assistant. The owner should use an existing coding-agent workflow to create games inside this format, then open them visually. No new model subscription, provider integration, or hosted inference system is necessary for this version.

Provide a root `AGENTS.md`, a short engine SDK guide, the project/scene schemas, two working examples, and behavior examples. Describe which files are generated, which can be edited, and how to validate/build a game.

The contract given to an agent is:

```text
Create this game using the studio's existing runtime and project format.
Put persistent level content in scene documents with stable entity IDs.
Implement game-specific logic as registered behaviors.
Expose settings I may adjust in the inspector.
Do not create a second renderer, game loop, or input system.
Do not modify engine/editor internals without a documented engine gap.
Use the provided assets or primitives; do not invent missing asset files.
Validate the project, run the bounded tests, and build a standalone export.
Report the files changed, exposed settings, and any unresolved failures.
```

Engineers should implement commands with the following intent; these names are a proposed CLI contract, not commands available today:

```text
studio create <game-id> --template <template-id>
studio validate <game-id>
studio build <game-id>
studio test <game-id>
```

A new scene generated by an agent should open with named selectable objects. Changing player speed must mean changing an exposed behavior property, not asking the agent to rewrite source code for every adjustment.

Watch external file changes. Debounce incomplete writes, validate before loading, and preserve the last known-good in-memory document if the new file is invalid. When local edits conflict with an external revision, show a conflict rather than silently overwriting either version.

Scene changes can be accepted as one undoable document transaction. Source-code changes require a separate checkpoint/version-control revert; do not pretend ordinary scene undo reverses arbitrary code changes. Restart the preview when scripts change rather than attempting complex live-state migration.

An integrated prompt panel can be added after the core workflow passes. It should produce the same validated project changes, not bypass the document format. Model-generated scene text does not automatically provide custom art, correct gameplay, or compatibility with the runtime.

## 12. Existing games and import limits

A compliant studio project is directly importable. A GLB is an asset, not a complete game. An arbitrary Three.js game source tree is not automatically an editable project.

For an existing game, the engineer must move authored placement into scene documents, adapt its rules into registered behaviors, and remove or integrate its independent renderer, loop, input, and asset-loading logic. Preserve only one owner for each subsystem.

A temporary “external game” card could link to an unconverted project, but must be labeled as a launcher entry, not full editor support. Do not prioritize that convenience over making the studio's own format useful.

## 13. Local project service and saving

Run the editor and workspace service from one development command after initial setup. Project discovery should scan the configured workspace directory. Do not require a database for folder metadata.

The service exposes only the operations needed for project listing, validated reads/writes, asset import, notifications, validation, and fixed build commands. Bind to loopback by default, validate Host/Origin, authenticate writes with a per-session token, and constrain all paths to the selected workspace. Reject path traversal and escaping symlinks. Never accept arbitrary shell commands from the browser.

Save scene documents atomically using temporary files and rename. Include a revision/hash in write requests so concurrent editor tabs or an agent cannot silently replace newer content. Keep bounded recovery copies outside the playable export. Browser storage may remember panel sizes and recent projects; it is not the authoritative project store.

Archive projects into a recoverable location rather than immediately deleting their assets. Source-project import validates archive paths and size limits, checks schema compatibility, and never automatically installs dependencies or executes project code.

Keep source scripts under version control. The studio need not implement a Git client.

## 14. Export pipeline

Provide two different operations:

**Export Game** builds a standalone web player containing compiled game logic, scene documents, assets, the selected runtime, and the required WASM/decoder files.

**Export Project** produces an editable source archive containing the project manifest, scenes, scripts, assets, compatibility metadata, and a README. Exclude caches, credentials, temporary files, and generated build directories.

Use Vite for the player build. Generate the selected game's entry/behavior registry during the build rather than shipping every game's scripts. Include all assets reachable by scene or behavior references and explicitly declared dynamic dependencies. Fail on missing files rather than generating a broken archive.

Vite supports configurable and relative public base paths, but application-created asset URLs must also obey the chosen base. Test the finished game under a nested path, not only at a host's root. Serve exported games over HTTP/HTTPS; do not promise that double-clicking `index.html` is supported. [S8]

A clean export must run without the editor, local project service, source folders, or external development URLs. Include third-party notices for bundled dependencies and imported assets as applicable.

## 15. Implementation sequence and gates

| Stage | Deliverable | Required evidence before proceeding |
|---|---|---|
| 0. Compatibility probe | Pinned Three.js/Box3D/Vite setup; blank runtime; simple falling box | Box renders, physics runs, Stop cleans up, production build loads its WASM on a static server |
| 1. End-to-end authoring loop | Minimal project list/create, scene schema, one viewport, transform inspector, save/load, undo, Play/Stop, crude export | Move a box, save/reopen it, simulate a fresh copy, stop without changing authoring state, and run the export independently |
| 2. Comfortable scene editing | Hierarchy/groups, assets, camera/light/material controls, snapping, clip playback, pause/step, errors | Build and revise a small scene without editing code; missing asset and unsupported import errors are understandable |
| 3. Actual games | Physics components, registered behaviors, player input/camera, HUD, game rules, transitions | Both demonstration games are playable using the shared runtime; level layout and key tuning values are editable |
| 4. Agent and management workflow | Templates, agent docs, validate/build/test CLI, file-change conflict handling, project duplicate/archive, source import/export | An agent creates a third compliant game without rewriting the engine; the owner edits it; two projects remain independent |
| 5. Reliability and release | Compatibility fixtures, resource cleanup, performance measurement, usable startup and recovery documentation | All release checks below pass with recorded evidence and no hidden development dependencies |

Do not spend Stage 0 comparing many engines or implementing multiple backends. Investigate a failing dependency with a bounded reproducible test and record the blocker. Do not silently replace Box3D or declare success because an unrelated fallback renders a cube.

At each stage, provide the commit, run instructions, demonstrated result, relevant tests, and known gaps. Automated test commands must terminate with a success/failure exit status and have timeouts. Avoid unattended infinite “fix and retry” loops.

## 16. Release acceptance tests

### Authoring and data integrity

Create two projects and verify there is no leakage of scenes, assets, histories, or settings. Save/reopen representative scenes and compare canonical authored data. Test duplicate, delete/undo, reparent, inspector changes, drag cancellation, keyboard focus, and independent model-material instances.

An interrupted save must leave a recoverable valid document. Invalid JSON, unsupported schema versions, missing assets, duplicate IDs, parent cycles, and concurrent external edits must never destroy the last valid authoring state.

### Runtime and physics

Run Play/Stop repeatedly and confirm the authored document is unchanged. Pause/Step must advance only the intended tick. Test rendering at different frame rates, tab backgrounding, collision/sensor events, character-wall contact, and reset/restart. Ensure a simple imported animated model can be instantiated twice without shared skeleton or animation-state errors.

After a warm-up, repeat at least 20 Play/Stop cycles and inspect ownership counts, event listeners, renderer resources, and physics handles for continuing growth. Do not require WASM's allocated memory buffer to shrink; the important check is that owned resources are released or reused without unbounded growth.

### Generation and exports

Have an agent create a game through the documented contract. Confirm its persistent objects are visible in the hierarchy and that speed, score target, and another game-specific parameter are inspector-editable. Validate and export it without manual repairs hidden outside the instructions.

Build from a clean checkout with a frozen dependency lockfile. Serve the export on a separate static server under a nested path with the editor service shut down. Check network requests for missing assets, dev-server URLs, incorrect MIME types, and missing WASM/decoders. Verify complete gameplay, restart, and audio activation after user interaction.

### Performance and usability

Use a declared reference scene rather than claiming a general object limit. An initial target is approximately 60 FPS on the reference machine (an M1 Pro) in a desktop browser with a 1080p viewport, device-pixel ratio capped for the test, 200 simple visible objects, 25 active primitive bodies, and one modest shadow light. These are proposed test conditions, not measured results or promises for arbitrary GLB assets.

Record actual frame times, physics time, draw calls, asset sizes, and startup behavior. Test the standalone sample at a narrow viewport and on an actual phone before claiming mobile support. A viewport aspect-ratio preset alone is not a device test.

The user acceptance session is: open a project, move five objects, replace a model, change a gameplay value, undo one mistake, play, stop, reopen, and export without touching code.

## 17. Explicitly deferred

Do not build multiplayer, account systems, cloud sync, collaboration, marketplace, plugin marketplace, native packaging, a visual scripting graph, shader graph, terrain sculptor, mesh editor, animation timeline, retargeting, linked prefabs, scene inheritance, or an embedded coding assistant in v1.

Also defer advanced joint/vehicle tools and free-form physics assemblies until a particular game requires them. Keeping Box3D isolated preserves the route to that work without making every simple game pay the authoring complexity.

The release should feel like a small game studio, not a technology demo and not a half-finished general-purpose engine.

## 18. Engineer handoff objective

> Deliver a browser-based, local-first Three.js game studio in which one person can manage multiple independent games, receive agent-generated projects in an agreed format, visually edit persistent objects and exposed gameplay properties, test using the same runtime as production, and export self-contained browser games. Prove the complete workflow before adding advanced features. Preserve open source, ordinary files, a standalone imperative runtime, Box3D behind an adapter, undoable authoring commands, and strict separation of authored and runtime state.

## Technical references

The sources below establish existing library capabilities. Architecture, scope, targets, and milestone gates above are recommendations for this project rather than claims made by these sources. Documentation was checked on 11 September 2026; implementations must pin and test their actual versions.

**[S1] Three.js editor source, history implementation, and license**

```text
https://github.com/mrdoob/three.js/tree/dev/editor
https://raw.githubusercontent.com/mrdoob/three.js/dev/editor/js/History.js
https://raw.githubusercontent.com/mrdoob/three.js/dev/LICENSE
```

**[S2] Three.js TransformControls**

```text
https://threejs.org/docs/pages/TransformControls.html
```

**[S3] Three.js GLTFLoader**

```text
https://threejs.org/docs/pages/GLTFLoader.html
```

**[S4] Three.js AnimationMixer**

```text
https://threejs.org/docs/pages/AnimationMixer.html
```

**[S5] mrdoob/toys**

```text
https://github.com/mrdoob/toys
```

**[S6] Box3D and the selected initial binding**

```text
https://github.com/erincatto/box3d
https://github.com/isaac-mason/box3d.js
```

**[S7] Zod validation basics**

```text
https://zod.dev/basics
```

**[S8] Vite production build and public base paths**

```text
https://vite.dev/guide/build.html
```

**[S9] Three.js WebGLRenderer**

```text
https://threejs.org/docs/pages/WebGLRenderer.html
```
