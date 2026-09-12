# Third-party notices

This repository contains code and design work derived from other projects. Each entry names what was
used, where it came from, and the licence it carries.

---

## pascalorg/editor

**Source:** <https://github.com/pascalorg/editor>
**Licence:** MIT
**Copyright:** Copyright (c) 2026 Pascal Group Inc.

### What was taken

The editor UI in `src/editor/**` is a port of that project's design system and interface patterns.
Specifically:

- **Design tokens** (`src/editor/styles/tokens.stylex.ts`, the `:root` block in
  `src/editor/styles.css`). The dark-theme palette, the radius scale, the type scale, and the control
  geometry are that project's values, converted from their `oklch` notation to sRGB hex because the
  StyleX compiler rejects some modern colour functions. Three properties of their system are load
  bearing and are the reason their chrome reads the way it does: strictly neutral (zero-chroma)
  surfaces, near-white rather than grey foreground text, and translucent-white borders
  (`white/10%`, `white/15%`) that composite against whatever surface they sit on.
- **Component shapes and behaviour** (`src/editor/ui/**`). The button variants and sizes, the menu
  and popover surfaces, the menu row, and the separator are ports of their `components/ui`
  primitives. The drag-to-scrub number field in `src/editor/ui/ScrubField.tsx` is a port of their
  `NumberInput`: dragging the label scrubs the value, `Shift` is coarse, `Alt` is fine, and clicking
  the value opens a text editor over it.
- **Layout structure** (`src/editor/App.tsx`, `src/editor/panels/Toolbar.tsx`). The flush bordered
  panel columns meeting at hard 1px edges, the single 48px top bar holding document identity and
  tools, and the icon-only controls in that bar are their arrangement.
- **Icon set.** All UI glyphs come from [`lucide-react`](https://lucide.dev), which is the icon
  library that project uses. lucide is ISC licensed; see below.

### What was *not* taken

No 3D, scene, geometry, node, plugin, CLI, or MCP code was copied. This repository's runtime,
schema, physics, export pipeline, and editor state management are its own. The port is confined to
presentation.

### Their licence

```text
MIT License

Copyright (c) 2026 Pascal Group Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Barlow

**Source:** <https://github.com/jpt/barlow> (packaged as
[`@fontsource/barlow`](https://github.com/fontsource/fontsource))
**Licence:** SIL Open Font License 1.1

The editor's interface typeface, self-hosted rather than fetched from Google Fonts. Only the 400 and
500 weights and only the `latin` and `latin-ext` subsets are imported, in `src/editor/main.tsx`;
every additional weight or subset is a file in the build. `src/editor/styles.css` asks for Barlow
first and falls back to the system UI stack, so a failure to load degrades rather than breaks.

The import lives in the editor's entry point and not the runtime's, because an exported game ships
the player and the HUD, neither of which has a styling dependency on the editor.

---

## lucide

**Source:** <https://github.com/lucide-icons/lucide>
**Licence:** ISC
**Copyright:** Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Used as a runtime dependency for every UI icon. Not vendored or modified.

---

## Radix UI

**Source:** <https://github.com/radix-ui/primitives>
**Licence:** MIT
**Copyright:** Copyright (c) 2022 WorkOS, Inc.

Used as a runtime dependency for the accessible menu, popover, select, switch, separator, and
tooltip primitives. Not vendored or modified.

### A note on composing Radix with StyleX

Radix's parts accept a `className` and merge it themselves, and that merge **replaces** the classes
StyleX generates rather than adding to them — an element that spreads `stylex.props()` into a Radix
part renders with no styles at all. This was verified against the installed version rather than
assumed. `src/editor/ui/Menu.tsx` documents the two shapes that work: an `asChild` trigger whose
styled element *becomes* the part, and a part this code owns whose `className` is the merged class
list and whose styled children live inside it.
