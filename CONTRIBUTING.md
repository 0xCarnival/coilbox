# Contributing to Coilbox

Thanks for looking. This is a small, deliberately-scoped project: a local-first game studio where
the authored document is the source of truth, one runtime serves the editor, the player, and an
export, and every claim is backed by a runnable check. Contributions that respect those three
ideas are easy to accept.

## Getting set up

```bash
pnpm install --frozen-lockfile
pnpm dev            # editor at http://127.0.0.1:5178/
pnpm verify         # lint, typecheck, unit tests, and the six browser gates
```

Node 24.x and pnpm 11.x — the exact pins are in [`docs/pinned-versions.md`](docs/pinned-versions.md).

## What runs before a change is accepted

| Command | What it proves |
|---|---|
| `pnpm lint` | The architectural rules hold: one vendor boundary, one renderer, runtime never imports editor, styling stays in the editor, and no low-evidence assertions |
| `pnpm typecheck` | Types |
| `pnpm test` | Behaviour in the schema, runtime, workspace service, and tools, against the real Box3D WASM |
| `pnpm verify` | Everything above, plus the six stage gates with browser evidence |
| `pnpm studio test <game>` | A game validates, exports, and plays headlessly |

`pnpm lint` is a gate, not advice, and it is strict on purpose: it rejects widening a value and
asserting it back, `unknown` leaking through an internal contract, and ad-hoc `typeof` narrowing
where a parse belongs. If a rule makes a change genuinely worse rather than better, argue with the
rule in the pull request — the vendored rules in `tools/oxlint/` are ours to edit, and
`tools/oxlint/anti-slop/README.md` records what was already dropped and why.

## Working on a game rather than the engine

You probably want [`docs/agent-contract.md`](docs/agent-contract.md), which is the loop for
creating or changing a project: create from a template, validate, test, and report. Games are data —
scenes, a manifest, and a behavior registry — and they never need engine code.

## What a pull request should contain

- **Evidence, not a claim.** Paste the output of the command that shows the change works. For a
  change to a gate, say what the new check would have caught that nothing else did.
- **The smallest change that does the job.** The plan's §17 lists what is explicitly deferred;
  features that need one of those are a conversation about the plan first.
- **A note in the right doc.** `docs/status.md` records what each stage demonstrates and which gaps
  are knowingly left open; add to it when you change either.
- **No personal data.** The repository ships without names, email addresses, machine paths, or
  credentials in files, evidence, or commit metadata.

## Reporting a bug

Use the issue template. For anything in the studio, a runtime behaviour, or an export, the fastest
path is usually `pnpm studio test <project>` or `pnpm verify` output: those commands print what
they checked and exit non-zero on failure.

## Licence

By contributing you agree that your work is licensed under the [MIT licence](LICENSE).
