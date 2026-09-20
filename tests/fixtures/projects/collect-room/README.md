# Collect Room

The first demonstration game from the implementation plan: a player moves around a room,
collects items, and reaches an exit.

Everything here is authored content: the level is a scene document, the rules are
registered behaviors, and the tuning values below are editable in the inspector without
touching code.

| What | Where |
| --- | --- |
| Player speed, jump, gravity | `Player` → Character Mover |
| Camera distance and height | `Game Camera` → Camera Follow |
| Number of gems required | `Game Rules` → Score target, and `Exit` → Required score |
| HUD labels and overlays | `game.json` → settings.hud |

Run it with `pnpm dev`, open the project in the studio, and press Play. Or export it with
`pnpm studio build collect-room`.
