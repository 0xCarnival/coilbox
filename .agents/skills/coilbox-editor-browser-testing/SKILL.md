---
name: coilbox-browser-testing
description: Run isolated Coilbox editor browser tests with asset and environment fixtures, runtime parity, and visual evidence.
---

# Coilbox browser testing

- Activate Node 24 in each shell: `source ~/.nvm/nvm.sh && nvm use 24`.
- After branch dependency changes, run `pnpm install --frozen-lockfile`; `pnpm exec playwright install chromium --only-shell` provides the matching headless runtime binary.
- For environment tests, deselect with Alt+A, then use the inspector's Background/Source/Fog comboboxes. Numeric fog fields are named `Start (m)` and `End (m)`.
- Use viewport-focused Numpad0 to view through the active game camera before comparing editor and Play. A chrome sphere, diffuse sphere, and distant towers distinguish IBL from fill lights and fog; no authored lights isolates the IBL contribution.
- Test real label scrubs with the mouse held throughout an intermediate pause, then require one undo for the entire gesture. A continuous-only scrub can miss time-window coalescing problems.
- For passive GPU smoke measurements, install an EventTarget as `window.__THREE_DEVTOOLS__` before navigation and collect `observe` events whose detail has `isWebGLRenderer`; compare read-only `info.memory` and program counts at equivalent mode states. Do not mutate renderer or scene state.
- `pnpm studio test` requires at least one behavior instance even for valid static scenes; distinguish this fixture assumption from its rendering, request, and console checks.

- Dependencies include `@playwright/test`; import Chromium from that package.
- Create with `pnpm studio create <name> --template blank --workspace <dir>` and start `pnpm dev --workspace <dir>`. Use the printed editor URL: port 5178 can be occupied and Vite then chooses another. The editor proxies the dynamically allocated API port.
- On Windows, if `pnpm dev` exits immediately without service output, the CLI direct-run path check may not match the Windows invocation. Retry with `COILBOX_CLI_FORCE=1` in the process environment; confirm both the workspace API and Vite print listening addresses.
- Create a blank project through the UI before destructive replacement/deletion tests.
- Use PNG, WAV and GLB fixtures from `tests/fixtures`; contrasting checkerboard images make texture refresh and repeat changes visible.
- Open the bottom Assets panel; scroll rows into view. Do not assume its upper edge is a resize handle, since dragging the canvas orbits the camera.
- If native HTML5 dragging is unreliable, connect Playwright over the available browser CDP endpoint. Dispatch the asset row's `dragstart` with a shared `DataTransfer`, then target `dragover` and `drop` with viewport-relative client coordinates. Rows use `[data-asset-id]`; hierarchy rows use `[data-entity-id]`.
- Asset drag MIME is `application/x-coilbox-asset`, with JSON `{assetId, kind}`. Prefer calling the row handler rather than fabricating behavior.
- Read-only `window.__STUDIO__.session.scene` can corroborate authored state; never mutate it. Verify rendering with screenshots, not only document values.
- Test replacement before and after reload, in both editor and Play, to detect stale texture caches independently of thumbnail refresh.
- Clear old console/toast history or reload before retesting warning fixes.

## Compressed models and nested exports

- Use the genuinely compressed `draco-crate.glb` and `meshopt-crate.glb` fixtures, not a file that only declares the required extension. Use a real meshopt/KTX2 model to prove texture transcoding visually.
- Inspect source model bounds before placing it alongside metre-scale fixtures; large models may need small inspector scale values.
- `Look along the +Z axis` presents the positive-Z-lit front in the blank template. If opposite-axis gizmo buttons overlap, first choose a perpendicular axis, then the desired axis.
- The Play stop button's accessible name is `Stop and discard the simulation`.
- Export with `pnpm studio build <project> --workspace <workspace>`. Serve the workspace with `python3 -m http.server <port> --bind 127.0.0.1 --directory <workspace>` and browse `/<project>/.coilbox/export/` to test a genuinely nested URL.
- Capture network responses before navigation; require successful Draco wrapper/wasm and Basis transcoder JS/wasm requests under the nested export path. Meshopt is bundled and does not need a separate request.
- Corroborate Play with read-only `window.__STUDIO__.viewport().playStats()` and export with `window.__PLAYER__.state()`, but use screenshots for actual geometry/textures. Distinguish decode failures from warnings about static models having no animation clips.

## Empty scenes and notifications

- Blank templates can contain a starter set. For genuinely empty-state checks, focus the viewport, press A then X, and confirm zero authored entities before testing the starter card.
- After project navigation, wait for a non-null `session.scene` and `!session.snapshot().loading`; the canvas can mount before the document finishes loading.
- Asset layout is a segmented control: use its exact visible `Flat` text rather than assuming a button role. Console tab names can include unread counts; use a starts-with match.
- To trigger truly identical log entries, repeatedly import the same unsupported filename via the Assets file picker. Saves can include changing revision numbers and therefore are not necessarily identical notifications.
- Start isolated toast scenarios by dismissing existing toasts. A notification logged while Console is active may appear when returning to Assets; test active suppression separately from return behavior.
- Capture timer mutations with a passive DOM observer. Repeat near the end of the original lifetime, verify the toast survives its original deadline, then measure expiry from the repeat.
- Measure toasts against the canvas, inspector, footer, and bottom Tools toolbar at representative desktop/laptop widths. Being inside the stage does not by itself ensure authoring tools remain unobstructed.

## Packaged downloads

- CDP-connected Playwright may redirect downloads into temporary GUID-named storage on each connection. For browser-directory evidence, set `Page.setDownloadBehavior` on a page-scoped CDP session to `{behavior: 'allow', downloadPath: '<absolute directory>'}` after connecting. Check the actual file and archive contents; a download event alone does not prove completion.
- Do not mix a custom Chrome download destination with Playwright's GUID-based `download.path()`/completion lookup. Alternatively keep Playwright's default behavior and use `download.saveAs()` while the connection remains open.
- Radix menus hide background controls from accessibility role queries. While a menu is open, inspect toolbar disabled properties with their `[aria-label]` locator, or close the menu before clicking toolbar controls.
- Prove portability by extracting the downloaded ZIP outside the workspace, stopping the disposable workspace service, and serving the extracted project folder with Python's static server. Require visible rendering and real keyboard movement, as well as a clean player state and requests confined to the static origin.

## Devin Secrets Needed

None for the local editor and disposable workspace.
