# Gem Rush

A timed collect-and-escape game built with Coilbox's registered behaviors only.

Five gems are scattered around an 18 × 18 m room. Collect all five and reach the blue exit gate on
the south wall before the 45-second clock runs out. Running out of time shows the lose overlay;
arriving at the gate with all five gems shows the win overlay.

## Layout

- `game.json` — manifest: scene list, settings, HUD, input bindings.
- `scenes/main.scene.json` — the single `main` level: floor, four walls, player, five gems, exit
  gate, camera, sun, fill light, and the rules entity.
- `assets/manifest.json` — asset identity (this game uses primitives only, so it is empty).
- `scripts/registry.json` — the five behaviors this project uses and their property descriptors.

## How the rules are wired

| Behaviour | Entity | What it does here |
| --- | --- | --- |
| `player.mover` | `player` | Walks the kinematic capsule with WASD/arrows, gravity, jumping. |
| `camera.follow` | `game-camera` | Fixed world offset above/behind the player; `camera` component does the rendering. |
| `game.collectible` | `gem-1` … `gem-5` | Adds 1 to `score` per gem (sensor event, with a radius fallback). |
| `game.exit-zone` | `exit-zone` | Wins when the player reaches the gate with `requiredScore` (5). |
| `game.rules` | `rules` | Owns the 45-second clock, the overlay flow, and restart. |

`game.rules.scoreTarget` is deliberately **0** (its documented "disabled" value). With a non-zero
target the rules behavior shows the win overlay the moment the score reaches the target, which
would end the round without the player ever reaching the exit gate. The exit gate's
`requiredScore` is therefore the effective score target: **5**.

## Tuning

Everything a designer would adjust lives in behavior properties, not in code:

| Property | Entity | Value | Controls |
| --- | --- | --- | --- |
| `player.mover.moveSpeed` | `player` | 6 | Walk speed in m/s. |
| `player.mover.jumpStrength` | `player` | 6.5 | Jump impulse (0 disables jumping). |
| `player.mover.gravity` | `player` | 20 | Downward acceleration in m/s². |
| `player.mover.turnSpeed` | `player` | 14 | How fast the capsule turns to face its heading. |
| `player.mover.acceleration` | `player` | 45 | How quickly the character reaches full speed. |
| `player.mover.groundCheckDistance` | `player` | 0.35 | Ground probe length. |
| `player.mover.spawnHeight` | `player` | 1 | Height above the authored position the run starts at. |
| `camera.follow.distance` | `game-camera` | 8 | Camera distance from the player. |
| `camera.follow.height` | `game-camera` | 6.5 | Camera height above the player. |
| `camera.follow.damping` | `game-camera` | 0.15 | Camera smoothing half-life. |
| `camera.follow.lookHeight` | `game-camera` | 1 | Height above the player the camera aims at. |
| `camera.follow.fixed` | `game-camera` | true | Fixed world offset instead of swinging behind. |
| `game.collectible.value` | `gem-1` … `gem-5` | 1 | Score per gem. |
| `game.collectible.pickupRadius` | `gem-1` … `gem-5` | 1.4 | Distance at which a gem is collected even without a sensor event. |
| `game.collectible.hideOnCollect` | `gem-1` … `gem-5` | true | Gems disappear when taken. |
| `game.exit-zone.requiredScore` | `exit-zone` | 5 | Score needed for the gate to open. |
| `game.exit-zone.triggerRadius` | `exit-zone` | 1.8 | Distance at which the gate counts as reached. |
| `game.exit-zone.winMessage` | `exit-zone` | — | Text written to `objective` on the win. |
| `game.rules.scoreTarget` | `rules` | 0 | Score-only win target; 0 keeps the win at the gate. |
| `game.rules.timeLimit` | `rules` | 45 | Round length in seconds; 0 disables the clock. |
| `game.rules.showStartOverlay` | `rules` | true | Show the start overlay when the run begins. |
| `game.rules.allowRestartKey` | `rules` | true | R restarts the run. |

The HUD's gem counter target (5) is a `settings.hud` value; the matching gameplay value is the
exit gate's `requiredScore`.

## Commands

```bash
pnpm studio validate gem-rush
pnpm studio test gem-rush
pnpm studio build gem-rush
```
