# Physics Targets

A compact physics shooting gallery: click to launch a ball, knock five targets over,
count the hits, and restart.

It uses the same engine and editor as NEON YOMI, with launch impulse and target physics exposed for editing.

| What | Where |
| --- | --- |
| Launch impulse, upward bias | `Ball` → Projectile Launcher |
| Tip angle that counts as a knock-down | `Target 1..5` → Knock-down Target |
| Score target and time limit | `Game Rules` |

Run it with `pnpm dev`, or export it with `pnpm studio build physics-targets`.
