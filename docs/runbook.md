# Runbook — starting, using, and recovering the studio

Everything here is local: one repository, one workspace folder, one loopback service. Nothing
requires an account, a network service, or a cloud dependency.

## Requirements

- Node.js 24.x and pnpm 11.x (see `docs/pinned-versions.md` for the exact pins).
- A Chromium-based browser for the editor. Headless Chromium with a software rasteriser is used by
  the verification gates, so no GPU is required to run them.

```bash
pnpm install --frozen-lockfile
```

## Starting

```bash
pnpm dev
```

This starts two things and prints both addresses:

- the **editor** at `http://127.0.0.1:5178/` (Vite dev server),
- the **workspace service** on a loopback port, proxied at `/api` so the browser sees one origin.

Stop it with `Ctrl+C`; both processes shut down. The workspace service ends open change streams
first, so an editor tab left open cannot block shutdown.

Useful variants:

```bash
pnpm studio api --port 5179        # workspace service only (prints the session token)
COILBOX_WORKSPACE=~/games pnpm dev   # use a different workspace folder
pnpm studio list --workspace ~/games   # every project command accepts --workspace
```

## Where things live

| What | Where | Backed up? |
| --- | --- | --- |
| Projects | `<workspace>/<project-id>/` (default `games/`) | They are ordinary files: use git |
| Scene recovery copies | `<project>/.coilbox/recovery/` | Bounded, newest kept |
| Archives | `<workspace>/.archive/<project>-<timestamp>/` | Until restored |
| Exports | `<project>/.coilbox/export/` | Disposable; rebuild any time |
| Panel sizes, recent view | browser local storage | Not authoritative |

The workspace service never writes outside the workspace folder, and it refuses paths that escape
it, including symlinks.

## Everyday recovery

**A scene will not open, or the editor says the file changed on disk.**
The editor keeps its last known-good document and shows a banner. Choose *Reload from disk* to take
the file, or *Keep my version* to overwrite it with what is on screen. Either way nothing is lost
silently: the previous document is in `.coilbox/recovery/`.

**A save was refused.** The document on disk moved on (another tab, or an agent). Reload, or keep
your version; the refusal message names the revision it expected.

**An edit went wrong.** `Ctrl/Cmd+Z` undoes authored scene changes. Undo does **not** reverse
source-code changes: those are yours to revert with version control.

**A project is broken beyond the editor.** Restore the newest recovery copy:

```bash
ls games/my-game/.coilbox/recovery/
cp games/my-game/.coilbox/recovery/<stamp>__scenes__main.scene.json \
   games/my-game/scenes/main.scene.json
pnpm studio validate my-game
```

**A project disappeared.** Check the archive:

```bash
pnpm studio archives
pnpm studio restore <archive-name>
```

**A project will not validate.** Read the errors, they name the path and the rule:

```
ERROR entities[3].parentId: parent "ghost" of "Crate" does not exist (missing-parent)
```

Nothing is rewritten while a document is invalid; fix the reported field and validate again.

**A project from a newer studio.** Validate refuses it with
`this project was written with schema version N; this build supports up to M`. Open it with the
build that wrote it, or export its source and migrate deliberately. The file is left untouched.

**The service will not start.** Check the port and the workspace folder:

```bash
lsof -nP -iTCP:5178 -sTCP:LISTEN     # something already on the editor port
lsof -nP -iTCP:5179 -sTCP:LISTEN     # something already on the service port
ls -ld "$COILBOX_WORKSPACE"        # the workspace must exist and be writable
```

The service binds to loopback only and rejects requests whose `Host` or `Origin` is not loopback.
That is deliberate: a web page you visit cannot reach it.

## Running a game

- **In the editor:** open the project and press **Play**. Play builds a fresh world from a snapshot;
  **Stop** discards it, so the authored scene is never left modified. **Pause** stops the simulation
  and **Step** advances exactly one fixed tick.
- **As a player:** `pnpm dev`, then open
  `http://127.0.0.1:5178/player.html?project=./games/<project-id>/`.
- **As an export:** `pnpm studio build <project-id>`, then serve
  `<project>/.coilbox/export/` over HTTP. Opening `index.html` from the filesystem is not
  supported — browsers block module and WASM loading from `file://`.

```bash
pnpm studio build my-game
npx --yes serve games/my-game/.coilbox/export    # or any static server
```

Exported games need no editor, no workspace service, and no development server.

## Checking your work

```bash
pnpm lint             # architectural + low-evidence rules; also the first gate in `pnpm verify`
pnpm typecheck        # types
pnpm test             # unit tests, including the real physics WASM
pnpm studio validate <game>   # one project: structure, relationships, behaviors, assets
pnpm studio test <game>       # one project: validate + export + play headlessly

pnpm verify:stage0 … verify:stage5   # the gates, each writing evidence to docs/evidence/
pnpm verify                          # every gate in order
```

Every command is bounded by a timeout, prints why it failed, and exits non-zero on failure.

The same gates run in CI on every push to `main` and every pull request
(`.github/workflows/verify.yml`), so a red badge means the commands above failed somewhere other
than your machine — which is the point: they are written to measure the engine and not the
computer, and a check that only passes on a fast laptop is a check that lies. When a run fails it
uploads `docs/evidence/` as an artifact, because the screenshots and the recorded numbers are what
explain the failure after the log has scrolled away.

## Assets

Supported today: self-contained `.glb` models, PNG/JPEG/WebP images, MP3/OGG/WAV audio. Anything
else is refused at import with a message saying what to do instead — `.fbx`, `.blend`, `.obj`,
`.ktx2`, `.flac`, and zipped glTF included. A `.glb` that requires Draco, meshopt, or Basis
compression imports with that requirement recorded and is refused at load with the same explanation.

Import through the editor's **Assets** tab (drag files in, or use *Import files*). Replacing an
asset keeps its id, so scenes that reference it are untouched; the previous file moves to
`.coilbox/assets/`.

## Portability

- Source archives (`pnpm studio export-source <game>`) contain the manifest, scenes, scripts,
  assets, and a `COMPATIBILITY.json`; caches and build output are excluded.
- Import validates archive paths, sizes, schemas, and every scene before writing anything, and never
  installs dependencies or runs project code.
- The repository builds from a clean checkout with `pnpm install --frozen-lockfile`; no
  development-only service is required at runtime by an exported game.

## Limits worth knowing

- One user, one machine. There is no collaboration, no accounts, and no cloud sync.
- A project is data, not code: scenes reference registered behavior ids, and `scripts/registry.json`
  is metadata describing their properties. Executable behavior code is compiled into the player, so
  opening a project, playing it, or exporting it never runs code that a project supplied.
- Performance numbers are only meaningful for the declared reference scene; see
  `docs/evidence/stage5/evidence.json` for the recorded measurements and the conditions they were
  taken under.
- Mobile support is **not** claimed. A narrow viewport is tested; a real phone is not.
