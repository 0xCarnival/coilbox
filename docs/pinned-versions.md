# Pinned versions

Recorded when implementation began (plan §5: "Choose the current supported Node version
compatible with the pinned build tools when implementation begins; record the actual
versions").

| Component | Version | Notes |
|---|---|---|
| Node.js | 24.18.0 | `node -v` on the development machine |
| pnpm | 11.25.0 | package manager; one lockfile for the whole repository |
| three | 0.185.1 | pinned; `@types/three` 0.185.4 is the matching types release |
| box3d.js | 0.1.1 | Box3D WASM binding (`isaac-mason/box3d.js`), MIT, non-multithreaded build |
| Box3D engine | 0.1.0 | reported by `b3GetVersion()` at runtime; single precision (`b3IsDoublePrecision() === false`) |
| vite | 8.3.0 | build tool and dev server |
| @vitejs/plugin-react | 6.1.1 | React for editor panels only |
| react / react-dom | 19.3.0 | editor UI only; never owns per-frame object transforms |
| zod | 4.6.2 | schema validation |
| typescript | 5.9.3 | pinned to the 5.x line: the 7.x native port is not yet supported by the pinned toolchain |
| vitest | 5.0.0 | unit tests, run against the real Box3D WASM in Node |
| @playwright/test | 1.63.0 | browser checks; Chromium 153 (headless shell) with SwiftShader |
| oxlint | 1.82.0 | the linter; pinned to the exact matching `@oxlint/plugins` |
| @oxlint/plugins | 1.82.0 | plugin API for the vendored `anti-slop` and `coilbox` rules |
| tsx | 4.23.13 | runs the workspace service, CLI tools, and verification scripts |
| @stylexjs/stylex | 0.19.0 | editor UI styling; CSS compiler, not a runtime style engine |
| @stylexjs/unplugin | 0.19.0 | the build plugin that runs the StyleX Babel transform under Vite |
| unplugin | 3.3.0 | host abstraction the StyleX plugin is built on (see note below) |

## Pinned but not yet used

These arrive with later stages; they are listed here so the versions are decided once.

| Component | Stage | Notes |
|---|---|---|
| GLTFLoader / AnimationMixer | 2 | from `three/examples/jsm`; no new dependency |
| OrbitControls / TransformControls | 1–2 | from `three/examples/jsm`; no new dependency |

## Deliberate version decisions

- **three 0.185.1 rather than 0.186.0.** `@types/three` is published a step behind, and a
  types/runtime mismatch produces silent API drift. The two are pinned together.
- **TypeScript 5.9.3 rather than 7.0.2.** The native TypeScript port is not yet wired into
  the pinned Vite/Vitest/react plugin versions.
- **`box3d.js` non-multithreaded build.** The plan requires starting without thread-specific
  isolation headers so static hosting stays simple. Development and the production build are
  both verified with this build; the multithreaded entry points are untouched.
- **`@playwright/test` for browser checks.** Chromium runs headless with SwiftShader, which
  provides WebGL2 without a GPU, so the checks run in CI-like conditions.
- **oxlint and `@oxlint/plugins` are pinned to the same exact version.** The JavaScript-plugin API
  the vendored `anti-slop` and `coilbox` rules are built on is still labelled alpha upstream and is
  not stable across Oxlint releases, so the two must be upgraded together and never floated. See
  [`tools/oxlint/anti-slop/README.md`](../tools/oxlint/anti-slop/README.md).

## Updating a pin

Change the version in `package.json`, run `pnpm install`, then:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm verify:stage0
```

A renderer or physics upgrade must not change the saved project format (plan §5).

## Known peer-dependency warning

`pnpm install` reports one unmet peer:

```text
✕ unmet peer unplugin
  Installed: 3.3.0
  Wanted:    ^2.3.11:  @stylexjs/unplugin@0.19.0
```

This is deliberate. `@stylexjs/unplugin@0.19.0` declares `unplugin@^2.3.11`, but this repository
runs Vite 8, whose bundler is Rolldown rather than Rollup. The StyleX plugin only uses unplugin's
stable `createUnplugin` entry point, which is unchanged in 3.x, and `unplugin@3.3.0` is what the
build has actually been verified against — `pnpm build`, `pnpm verify:stage1` and the StyleX
migration checks all pass with it, and the atomic CSS is present in `dist/`.

Pinning `unplugin@2` would silence the warning but move off the version that Vite 8's pipeline was
tested with, which trades a visible advisory for an invisible risk. Revisit when
`@stylexjs/unplugin` widens its peer range.
