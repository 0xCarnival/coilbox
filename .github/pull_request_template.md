## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## How it was verified

<!--
Every change is expected to come with evidence, not a claim. Paste the relevant output:

- `pnpm lint` and `pnpm typecheck` for code changes;
- `pnpm test` for behaviour in the runtime, schema, or service;
- `pnpm verify` (or the specific `pnpm verify:stageN`) for anything the browser gates cover;
- for gate changes: what the check would have caught that nothing else did.
-->

```
```

## Checklist

- [ ] The authored document is still the source of truth (no state that only exists in a running editor).
- [ ] One runtime: the editor, the player, and exports share the same code path.
- [ ] Vendor calls are still behind `src/runtime/physics/box3d-adapter.ts`.
- [ ] New behaviour is a registered behavior, not code in a document.
- [ ] `docs/status.md` (or the relevant doc) is updated if this changes what a stage demonstrates.
