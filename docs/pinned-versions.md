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
| tsx | 4.23.13 | runs the workspace service, CLI tools, and verification scripts |

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

## Updating a pin

Change the version in `package.json`, run `pnpm install`, then:

```bash
pnpm typecheck && pnpm test && pnpm verify:stage0
```

A renderer or physics upgrade must not change the saved project format (plan §5).
