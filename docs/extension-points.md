# Extension points

What "a plugin host" would mean in this repository, how much of one already exists, and what the
next step should be. This is a design note, not a specification: it exists so the decision can be
made with the code in front of it rather than from the phrase "plugin system", which means very
different things at different scopes.

## What already exists

Coilbox has one extension seam, and it is not a UI one.

**Behaviors.** A project declares them in `scripts/registry.json`: an id, a name, a description, and
a list of property descriptors that the inspector renders and validates against. The runtime holds a
`BehaviorRegistry` that is "metadata-only: it drives the inspector and validation, never execution" —
a behavior stores a *registered* id and serialisable properties, never a function or a source string.

That is a plugin API already, with a deliberately narrow surface, and
[`docs/engine-sdk.md`](engine-sdk.md) is its reference. `docs/agent-contract.md` states the
consequence plainly: if a game needs engine work, add a registered behavior to
`src/runtime/behaviors/library.ts`.

**Panels.** `src/editor/ui/rail-registry.ts` holds the rail's panel list and exposes
`registerRailPanel`, so a panel can be contributed rather than the component edited. It is a code
seam: a contributor is TypeScript in this repository, compiled into this build. It is explicitly
*not* a capability boundary, and the file says so.

So the shape of the gap is narrower than "we have no plugins". Game logic is already extensible by
data. Editor chrome is extensible only by code.

## What a plugin host is, in the reference

Worth stating, because it sets the ceiling. In `pascalorg/editor`, a plugin adds **new kinds of
objects to a scene**, not just UI:

```ts
export const gardenPlugin: Plugin = {
  id: "acme:garden",
  apiVersion: 1,
  nodes: [plantDefinition],
};
```

Each node definition carries a Zod schema, defaults, `capabilities` (selectable, duplicable,
deletable), and presentation — and the plugin can then supply that node's 3D renderer, its floor-plan
renderer, its inspector, and a sidebar panel. That is why their examples are features rather than
widgets: Bones is an engineering X-ray, Nature is procedural vegetation, Boots is a first-person mode.

Two of their constraints are the interesting ones:

**There is no runtime sandbox.** Their docs are direct about it: a host "must review and bundle a
plugin before it can be enabled", and the Plugins panel "toggles bundled code for one project; it
does not download code from GitHub or npm". Runtime installation is planned, not shipped.

**The registry must be shared.** `@pascal-app/*` packages are required as *peer* dependencies, because
"bundling another copy of `@pascal-app/core` creates a separate registry and the plugin will not load
correctly." The hard part of a plugin host is not loading code; it is agreeing on one registry.

## Three scopes

### A. Workspace-declared panels — recommended

A project's `scripts/registry.json` gains an optional `panels` array. At project open, the editor
seeds the rail registry from it.

- **What it buys:** a project can add an editor panel without a change to editor internals, which is
  the actual benefit people mean by "plugins" in a single-user tool.
- **What it costs:** a schema addition and a read at project open. The rail registry already exists.
- **What it does not do:** it does not run third-party code, add node kinds, or cross a trust
  boundary. A panel is still built from this repository's components.
- **Honest limitation:** a declared panel needs *something to render*. Without a contribution format
  richer than a title, a declared panel can only host built-in surfaces. The value is in projects
  choosing which panels exist and in what order, not in new behaviour.

### B. Third-party node kinds

A plugin registers a new component type: schema, defaults, 3D rendering, inspector fields.

- **What it buys:** genuinely new kinds of object — the thing that makes the reference's plugin
  gallery possible.
- **What it costs:** the scene schema is a closed Zod union, the renderer is a closed switch, and
  the inspector is descriptor-driven from `field-schema.ts`. All three would need to accept
  registered contributions, and `validate` would need a story for a component type it does not know.
- **The consequence to decide first:** a saved scene could then stop loading on a machine without
  the plugin. The reference answers this with `apiVersion` plus human review. Coilbox's answer would
  have to be a validation rule, and it should be decided *before* the mechanism is built rather than
  after.

### C. Sandboxed runtime install

Downloading and executing third-party code with a capability boundary and a review process.

- This is the largest piece by an order of magnitude, and it is the one thing every layer above can
  be built without. The reference does not ship it either.
- **Recommendation: do not build it.** It exists to protect users from code they did not write. For a
  local-first studio whose plugins would be TypeScript in the user's own workspace, the envelope buys
  very little and costs a great deal.

## Recommendation

**Build A. Defer B until someone asks for it by name. Do not build C.**

The reasoning is that A closes a real gap for a small cost, B is a large architectural change whose
first question — what happens to a scene naming a missing component — is a product decision rather
than an engineering one, and C protects against a threat this deployment does not have.

There is also a simpler argument: **B and C are both easier to build on top of A than instead of it.**
A manifest format and a registry read have to exist either way, so building them at the narrow scope
first means the wider scopes start from something working.

## Open questions a real host would have to answer

Recorded so they are not rediscovered later:

1. **What does `validate` say about a component type it does not recognise?** Today: a hard failure.
   With third-party node kinds it would have to distinguish "corrupt" from "not installed here".
2. **Is a panel project-scoped or workspace-scoped?** Behaviors are per project, so panels following
   them is consistent — but a panel that reflects the workspace rather than one game has no home.
3. **Does a declared panel get to request data?** A panel with no data is a static surface. Anything
   richer needs a declared, narrow contract in the shape behaviors already use.
4. **What is the version-compatibility story?** Behaviors carry `schemaVersion` on the registry. A
   panel or node contribution would need the same, and a policy for what happens on a mismatch.
5. **Where does the trust boundary sit if B ships?** Imported projects are already a vector: a
   `.tar.gz` can carry a `registry.json`, and B would let it carry behaviour.
