# Project format

A game is an ordinary folder. Nothing in it requires the studio to be installed, and everything in
it is diffable text except the assets themselves.

```text
my-game/
  game.json               # manifest: schema version, scenes, start scene, settings, HUD, input
  scenes/
    main.scene.json       # the authored level
  assets/
    manifest.json         # asset identity: ids, kinds, paths, content hashes
    models/ images/ audio/
  scripts/
    registry.json         # which registered behaviors the project uses and their properties
  thumbnail.png           # optional
  README.md
  .coilbox/             # studio-owned: recovery copies, test builds, exports. Never edit.
```

## Conventions

- Distances are **metres**, time is **seconds**, rotations are **normalised quaternions**
  `[x, y, z, w]` (the inspector shows degrees).
- The world is **Y-up, right-handed**.
- An entity's **forward axis is local −Z**, matching cameras.
- Paths inside documents are **project-relative** with forward slashes, and may not escape the
  project folder.

## `scripts/registry.json`

Two optional top-level keys, both read from disk with nothing trusted:

- **`behaviors`** — the registered behaviors this project uses, with the property descriptors the
  inspector renders and the validator checks against. Executable behavior code lives in the runtime
  bundle, never here: editing a scene must not execute a behavior constructor. See
  [`engine-sdk.md`](engine-sdk.md).
- **`panels`** — which editor panels the left rail shows, and in what order. Omit it and every panel
  is shown, so an existing project is unaffected.

```json
{
  "schemaVersion": 1,
  "behaviors": [{ "id": "animation.play", "name": "Animation Playback", "properties": [] }],
  "panels": [{ "id": "objects" }, { "id": "assets", "label": "Files" }, { "id": "console" }]
}
```

A panel entry names a panel this build provides; `label` optionally overrides its name. An id the
build does not have is skipped, and a `panels` array where *nothing* resolves falls back to showing
every panel — an empty rail would leave no way to open anything, which matters more than honouring a
declaration that cannot be satisfied.

This is a configuration seam, not a plugin system: a declared panel selects among built-in surfaces
and cannot introduce a new one. [`extension-points.md`](extension-points.md) sets out what a real
plugin host would take and why it is not built.

## `game.json`

```json
{
  "schemaVersion": 1,
  "engineVersion": "0.1.0",
  "engineCompat": "0.1.0",
  "id": "collect-room",
  "name": "Collect Room",
  "description": "Walk around a room, collect every gem, and reach the exit.",
  "scenes": [{ "id": "main", "name": "Collect Room", "path": "scenes/main.scene.json" }],
  "startScene": "main",
  "assetManifest": "assets/manifest.json",
  "behaviorRegistry": "scripts/registry.json",
  "settings": {
    "physics": { "fixedTimeStep": 0.016666666666666666, "subStepCount": 4, "maxSubSteps": 5, "enableSleep": true, "hitEventThreshold": 1 },
    "render": { "antialias": true, "shadows": true, "pixelRatioCap": 2, "toneMapping": "aces", "exposure": 1 },
    "initialGameState": { "score": 0, "won": false },
    "hud": [],
    "inputBindings": { "moveForward": ["KeyW", "ArrowUp"], "jump": ["Space"] }
  }
}
```

- `schemaVersion` is the document format; `engineCompat` records the engine it was authored
  against. A newer `schemaVersion` is refused with an explanation rather than half-loaded.
- `revision` (in scene documents) is a separate counter used to detect concurrent edits.
- Actions are defined independently of keys: behaviors ask for `moveForward`, `jump`, `interact`,
  `restart`, and `primary`, so bindings can change — or a touch control can be added — without
  touching gameplay code.

### HUD elements

```json
{ "type": "counter", "id": "score-counter", "label": "Gems", "bind": "score", "target": 3,
  "position": "top-right", "color": "#ffffff", "size": 20 }
```

Types are `label` (`text`, `bind`, `position`, `color`, `size`), `counter` (`label`, `bind`,
`target`), `button` (`label`, `action`: `restart` | `nextScene` | `none`), and `overlay` (`kind`:
`start` | `win` | `lose` | `pause`, `title`, `message`, `actionLabel`, `action`). Positions are
`top-left`, `top-center`, `top-right`, `bottom-left`, `bottom-center`, `bottom-right`.

## Scene documents

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "id": "main",
  "name": "Collect Room",
  "activeCameraId": "game-camera",
  "environment": {
    "background": { "type": "color", "color": "#181d29" },
    "fog": { "type": "linear", "color": "#181d29", "near": 26, "far": 60 },
    "gravity": [0, -20, 0]
  },
  "entities": []
}
```

Each entity:

```json
{
  "id": "player",
  "name": "Player",
  "parentId": null,
  "order": 5,
  "enabled": true,
  "transform": { "position": [0, 1, -6], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },
  "components": [],
  "editor": { "visible": true, "locked": false, "color": null, "helper": false }
}
```

- `id` is stable and referenced by behaviors, parents, and the active camera. `name` is the label
  the human sees and can change freely.
- `enabled` is gameplay: a disabled entity and its subtree are not in the game.
- `editor.visible` and `editor.locked` are **editor-only**. Hiding a helper never disables gameplay
  content, and vice versa.
- `order` sets sibling order explicitly.

### Validation

`pnpm studio validate <game>` runs structural validation (Zod) plus relationship checks that a
schema cannot express: unique ids, existing parents, no parent cycles, valid camera references,
finite transforms, supported components, behavior ids that exist in `scripts/registry.json`,
behavior property names and types, asset references that exist, and compatible schema versions.
Invalid documents are never written and never loaded.

`pnpm studio test <game>` goes further: it exports the game and plays it headlessly, which is what
catches a behavior that is registered but cannot run. Both commands exit non-zero on failure.

## Components

| Component | Purpose | Key fields |
| --- | --- | --- |
| `primitive` | box, sphere, plane, capsule, or cylinder | `shape`, `size` (full extents in metres), `castShadow`, `receiveShadow` |
| `model` | an imported `.glb` | `assetId`, shadows |
| `material` | colour, surface, and primitive textures | `color`, `roughness`, `metalness`, `opacity`, `emissive`, `map`, `normalMap`, `emissiveMap`, `textureRepeat`, `textureOffset` |
| `camera` | the game camera | `mode` (`free`/`follow`/`fixed`), `fov`, `near`, `far`, `targetId`, `distance`, `height` |
| `light` | directional, ambient, hemisphere, point, spot | `kind`, `color`, `intensity`, `castShadow`, `shadowMapSize`, `shadowExtent` |
| `rigidBody` | physics participation | `bodyType` (`static`/`dynamic`/`kinematic`), `gravityScale`, `lockRotation`, `mass` |
| `collider` | collision shape | `shape` (`box`/`sphere`/`capsule`), `size`, `offset`, `isSensor`, `friction`, `restitution`, `density` |
| `animation` | clip playback | `clip`, `loop`, `speed`, `playing`, `autoplay` |
| `audio` | a sound asset | `assetId`, `volume`, `loop`, `autoplay`, `spatial` |
| `behavior` | game logic | `behaviorId`, `properties` |

Rules the runtime enforces:

- **Physics bodies must be scene roots** (`parentId: null`). Give the visual mesh its offset through
  the collider instead of nesting the entity.
- A `collider` needs a `rigidBody`; without one the scene is rejected with that message.
- Non-uniform or negative scale on a physics body is refused rather than silently producing wrong
  collisions.
- Box colliders are **bounds-fitted boxes**, not exact shapes.

## Assets

`assets/manifest.json` records identity, not paths:

```json
{
  "schemaVersion": 1,
  "assets": [
    {
      "id": "spinning-crate",
      "kind": "model",
      "path": "assets/models/spinning-crate-0945d0dd.glb",
      "hash": "sha256:0945d0dd…",
      "bytes": 3016,
      "requires": [],
      "note": "",
      "meta": {}
    }
  ]
}
```

- Scenes and behaviors reference `assetId`. Stored file names carry a content hash, so replacing an
  asset never changes the reference and moving a file never breaks a scene.
- `requires` lists glTF extensions the file declares. A model that needs a codec this build does not
  bundle (Draco, meshopt, Basis) is recorded at import and refused at load with an explanation.
- Supported today: self-contained `.glb` models, PNG/JPEG/WebP images, MP3/OGG/WAV audio. Images are
  referenced by material texture slots on primitive entities. Everything
  else is refused at import with a message that says what to do instead.

## `scripts/registry.json`

```json
{
  "schemaVersion": 1,
  "behaviors": [
    {
      "id": "player.mover",
      "name": "Character Mover",
      "description": "Moves a kinematic body with WASD/arrow input, gravity, and optional jumping.",
      "properties": [
        { "key": "moveSpeed", "label": "Move speed", "type": "number", "default": 5, "min": 0, "max": 40, "step": 0.5 }
      ]
    }
  ]
}
```

The registry is metadata. Executable behavior code is compiled into the player bundle; editing a
scene never executes a behavior constructor. If the registry and the build disagree, the editor says
so explicitly — a declared-but-unimplemented behavior is an error, an implemented-but-undeclared one
is a warning.
