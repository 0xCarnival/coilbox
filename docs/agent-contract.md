# The contract an agent follows to build a game

This is the document to read first when you are asked to create or change a game in this studio.
It describes the workflow, the rules, and how to prove your work. The format details live in
[`project-format.md`](project-format.md) and the behavior SDK in [`engine-sdk.md`](engine-sdk.md).

## The contract

> Create this game using the studio's existing runtime and project format.
> Put persistent level content in scene documents with stable entity IDs.
> Implement game-specific logic as registered behaviors.
> Expose settings I may adjust in the inspector.
> Do not create a second renderer, game loop, or input system.
> Do not modify engine/editor internals without a documented engine gap.
> Use the provided assets or primitives; do not invent missing asset files.
> Validate the project, run the bounded tests, and build a standalone export.
> Report the files changed, exposed settings, and any unresolved failures.

## Workflow

```bash
# 1. Start from a template — blank, collect-room, or physics-targets.
pnpm studio create tide-pool --template blank --name "Tide Pool"

# 2. Edit the scene documents and scripts/registry.json (see the format guide).
#    Persistent level content goes in scenes/*.scene.json. Game logic goes in behaviors.

# 3. Validate. Fix every error before continuing.
pnpm studio validate tide-pool

# 4. Run the bounded test: it validates, exports, then plays the game headlessly and
#    checks that it loads, registers behaviors, simulates, renders, and logs no errors.
pnpm studio test tide-pool

# 5. Build the standalone export.
pnpm studio build tide-pool
```

Every command exits non-zero on failure and prints what went wrong. Do not report a game as done
while any of them fails.

## What is generated, what is yours to edit

| Path | Who owns it | Notes |
| --- | --- | --- |
| `game.json` | **you** | manifest: scenes, start scene, settings, HUD, input bindings |
| `scenes/*.scene.json` | **you** | the level: entities, transforms, components |
| `scripts/registry.json` | **you** | which behaviors the project uses and their property descriptors |
| `assets/` | **the studio** | imported through the editor or the API; the manifest records identity and hashes |
| `.coilbox/` | **the studio** | recovery copies, test builds, exports — never edit, never ship |

Anything the studio writes under `.coilbox/` is disposable. Source archives and exports exclude
it automatically.

## Rules

1. **One runtime.** Do not add a second renderer, game loop, input system, or physics world. The
   player, the editor preview, and every export run the same code on the same scene format.
2. **Registered behaviors only.** A behavior component stores `behaviorId` plus serialisable
   properties. Never a function, never a source string, never executable text in a document.
3. **Stable entity ids.** Ids are referenced by behaviors (`target`, `playerName`), by the active
   camera, and by other entities' parents. Renaming an id breaks references; renaming the display
   name does not.
4. **Physics bodies are scene roots.** An entity with a `rigidBody` component must have
   `"parentId": null`. Visual offsets live on the collider, not in a nested transform.
5. **Expose tuning as behavior properties.** Anything the human should be able to adjust — speed,
   score target, distances, time limits — belongs in a behavior's `properties`, with a descriptor
   in `scripts/registry.json`. Never ask for source edits to tune a value.
6. **Use real assets.** Reference only assets that exist in `assets/manifest.json`. Do not invent
   file names; if a model is missing, use primitives or ask for the asset.
7. **Do not edit engine internals to finish a game.** The one sanctioned extension point is adding
   a behavior to `src/runtime/behaviors/library.ts` (then run `pnpm games` if the templates should
   carry the updated registry). If you do that, say so explicitly in your report and explain which
   engine gap required it.
8. **Respect concurrent edits.** Scene documents carry a `revision`. The workspace service refuses a
   write whose expected revision is stale, and the editor shows a conflict instead of overwriting.
   If you change a file the editor has open, expect the human to be told the file changed on disk.
   Undo in the editor reverses *authored scene changes*; it does not reverse source-code changes.
   Those are yours to revert with version control, and the studio does not pretend otherwise.
   Changing `scripts/registry.json` reloads behavior metadata but does not hot-swap behavior code —
   rebuilding the studio restarts the preview with the new behaviors.

## Two rules worth knowing before you wire up a win condition

- **`game.rules.scoreTarget` wins on score alone.** A non-zero `scoreTarget` ends the round the
  moment the score reaches it, without the player reaching anything. When the level should require
  *collecting and then escaping*, set `scoreTarget: 0` (which disables it) and put the real
  requirement on `game.exit-zone.requiredScore`.
- **The time limit counts fixed simulation steps, and only after the round starts.** With
  `waitForStart: true` (the default when a start overlay is shown) the clock does not run down
  behind the overlay; pausing the game stops it, and `Step` advances it by exactly one tick. A win
  is final — a clock expiring afterwards cannot turn a win into a loss.

## What "done" looks like

- `pnpm studio validate <game>` prints `valid`.
- `pnpm studio test <game>` passes every check.
- `pnpm studio build <game>` produces an export that runs with the editor and the workspace service
  switched off.
- The scene opens in the studio with named, selectable objects, and the tuning values you exposed
  appear in the inspector.
- Your report lists the files changed, the exposed settings, and anything you could not resolve.

## Report template

```text
Game: <project id>
Files changed: <paths>
Exposed settings: <behavior property → what it controls>
Tests: pnpm studio validate / test / build — pass or fail, with the exact output for failures
Engine gaps: none, or what you added and why
Unresolved: none, or the specific failure and what you tried
```

## Available behaviors

The studio ships a fixed behavior library; `scripts/registry.json` declares which of them a project
uses and what their properties are. The current set:

| Behavior id | What it does | Key properties |
| --- | --- | --- |
| `player.mover` | walks a kinematic body with input, gravity, and jumping | `moveSpeed`, `jumpStrength`, `gravity`, `turnSpeed` |
| `camera.follow` | keeps a camera behind/above a target, or at a fixed world offset | `target`, `distance`, `height`, `damping`, `fixed`, `lookHeight` |
| `game.collectible` | adds to the score when the player reaches it | `value`, `playerName`, `hideOnCollect`, `pickupRadius` |
| `game.exit-zone` | wins the level when the player arrives with enough score | `playerName`, `requiredScore`, `winMessage`, `triggerRadius` |
| `game.rules` | score target, time limit, win/lose overlays, restart | `scoreTarget`, `timeLimit`, `initialObjective`, `nextScene`, `showStartOverlay`, `waitForStart` |
| `game.launcher` | launches a body on click | `impulse`, `upward`, `resetAfterLaunch` |
| `game.target` | counts a knock-down when a body tips or is hit hard | `tipAngle`, `minImpactSpeed`, `value` |
| `animation.play` | plays model clips, optionally switching on game state | `clip`, `loop`, `speed`, `switchStateKey` |
| `audio.cue` | plays the entity's audio asset when a state key changes | `stateKey`, `volume` |

Game-specific rules that these cannot express are written as a new behavior — see
[`engine-sdk.md`](engine-sdk.md).
