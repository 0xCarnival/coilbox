# Ōmagatoki Circuit

A Wipeout-style anti-gravity combat racer built entirely from Coilbox scene data and the registered
`racer.*` behaviors. The raceway hangs above a cloud sea at *ōmagatoki* — the twilight hour when the
world turns strange — strung between torii gates, neon spires and drifting shrine islands.

The lap is 1363 m long: a start straight under the gantry, a rising right-hand sweep, the
Cliff Drop (a 40 m plunge with a gap jump), an S through the shrine islands, the climb to the Moon Hairpin and
the plunge home. Three laps against three AI rivals who rubber-band, drift, and shoot back.

## Controls

| Input | Action |
| --- | --- |
| `W` / `↑` | Thrust |
| `S` / `↓` | Brake / reverse |
| `A` `D` / `←` `→` | Steer |
| `Q` / `E` | Air brakes: one side drifts through the corner (and charges boost), both slam the brakes |
| `Shift` | Boost (burns the meter; boost pads and drifting refill it) |
| `Space` / `F` | Fire the loaded pickup |
| `1` `2` `3` | Choose a hull before the countdown ends |
| `R` | Restart |

## Hulls

| Hull | Character |
| --- | --- |
| **Kitsune** · speeder | Featherlight glass cannon: fastest, sharpest, 60 energy and takes extra damage — but its pulse hits hardest. |
| **Tengu** · interceptor | Agile all-rounder: balanced speed, grip and 100 energy. |
| **Oni** · bulwark | Heavy armour: 150 energy, shrugs off 30% of every hit, biggest boost — slow to turn and to spool up. |

## Pickups

- **Boost pad** (cyan floor plate): instant surge plus 35% meter.
- **Pulse cannon** (orange): a hitscan bolt at the craft ahead of you.
- **Shockwave** (pink): damages every craft within 20 m.
- **Shield** (lavender): five seconds of immunity when fired.
- **Energy** (cream): restores 40% of the hull.

## What to inspect

| Tuning | Where |
| --- | --- |
| Hover height, gravity, speed scale, starting boost | `Player` → Racer Craft |
| Rival skill, aggression, preferred lane, rubber banding | `Kaminari`, `Yurei`, `Daruma` → Racer Craft |
| Camera distance, bank amount, look-ahead, speed pull-back | `Chase Camera` → Racer Chase Camera |
| Pickup kind, radius, respawn time | `Pickup 01..15` → Racer Pickup |
| Laps, countdown, podium places | `Race Director` → Race Director |

Waypoints (`Waypoint 01..NN`) are the lap order every craft follows; 01 is the start line. The track
pieces, rails, gates and pickups are generated from one spline by `tools/write-racer.ts`
(`pnpm tsx tools/write-racer.ts`) so the circuit can be re-laid by editing its control points.

Run it with `pnpm dev`, or export it with `pnpm studio build omagatoki-circuit`.
