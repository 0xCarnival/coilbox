# Physics Targets

The second demonstration game: click to launch a physics object, knock the targets over,
count the hits, and restart.

It uses the same engine and editor as Collect Room — no separate hard-coded application.

| What | Where |
| --- | --- |
| Launch impulse, upward bias | `Ball` → Projectile Launcher |
| Tip angle that counts as a knock-down | `Target 1..5` → Knock-down Target |
| Score target and time limit | `Game Rules` |

Run it with `pnpm dev`, or export it with `pnpm studio build physics-targets`.
