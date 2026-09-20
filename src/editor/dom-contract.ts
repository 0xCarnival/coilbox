import type { StyleXStyles, Theme, VarGroup } from '@stylexjs/stylex';
import * as stylex from '@stylexjs/stylex';

/**
 * Stable DOM class names shared with the browser verification gates.
 *
 * `stylex.create` replaces a class name with generated atomic hashes, so a class the gates query
 * would simply stop existing in the DOM. These names are therefore applied as a plain `className`
 * *alongside* `stylex.props(...)` — see `withDomClass` — which keeps the stylesheet supplying the
 * pixels while this string supplies the stable handle.
 *
 * Keeping the handles out of the styling system is deliberate. The gates then assert on a contract
 * that survives a styling change, instead of on whatever the CSS compiler happened to emit; the
 * previous arrangement coupled `tools/verify-stage*.ts` to the exact text of `styles.css`.
 *
 * Every value here must appear in `tools/`, which `tests/unit/dom-contract.test.ts` enforces, so a
 * name cannot be added speculatively or left behind after the gate that used it is deleted.
 *
 * One subtlety this list exists to protect: `stylex.props()` returns its own `className`, and a JSX
 * `className` written *after* the spread replaces it rather than merging. StyleX's classes are lost
 * silently when that happens, and the element still renders — it just renders unstyled. `withDomClass`
 * is the only sanctioned way to combine the two.
 */
export const DOM = {
  /** Stage 1-5: `data-save-state` is read from this element, and its modifier classes are asserted. */
  saveIndicator: 'save-indicator',
  /** Stage 1, 5: the export status line is read from this element. */
  statusbar: 'statusbar',
  /** Stage 2, 5: row count and the first cell are asserted. */
  assetTable: 'asset-table',
  /** Stage 2: located by `aria-label`, then its active button is read. */
  toolbarGroup: 'toolbar-group',
  /** Stage 2: the snap checkbox is driven through this element. */
  snapToggle: 'snap-toggle',
  /** Stage 4: the external-change conflict banner must appear and disappear. */
  conflict: 'conflict',
  /** Stage 2, 5: the importable scene list is counted and clicked. */
  sceneList: 'scene-list',
  /** Stage 2, 5: tabs are switched by name. */
  tabs: 'tabs',
  /** Stage 2, 5: log entries are read after a build or a failed load. */
  logList: 'log-list',
  /** The undo history list; rows jump the document to that step. */
  historyList: 'history-list',
  /** Stage 1-5: the editor shell is asserted to exist before anything else is driven. */
  studio: 'studio',
  /**
   * The shell grid. Its tracks are inline (they come from the stored panel layout), so the class is
   * not needed to style it — it is kept as the readable handle for the element whose inline
   * `grid-template-*` is the thing most likely to be misread while debugging layout.
   */
  studioBody: 'studio-body',
  /** Stage 1-4: project cards are located by name to open a project. */
  card: 'card',
  /** Stage 1, 5: the project home is the "no project open" state. */
  home: 'home',
  /** Stage 2: the inspector is scoped before fields are read. */
  inspector: 'inspector',
  /**
   * Stage 2, 4, 5: the name field is located as `.inspector-title .name-field`, so both halves of
   * that selector have to exist.
   */
  inspectorTitle: 'inspector-title',
  nameField: 'name-field',
  /** Stage 2, 5: used both to locate a section by its heading and to scope a field lookup. */
  section: 'section',
  /** Stage 2, 5: the human-readable section heading text. */
  sectionTitle: 'section-title',
  /** Stage 2, 5: field rows and their labels are located inside a section by label text. */
  field: 'field',
  fieldLabel: 'field-label',
  /**
   * Stage 1, 2, 5: vector rows are counted and driven through `.vector-field` and its inputs, e.g.
   * `.section:has(.section-title:text-is("Transform")) .vector-field:has(.field-label…) input`.
   */
  vectorField: 'vector-field',
  /** Stage 2: the create-entity menu in the toolbar. */
  menu: 'menu',
  /**
   * Stage 2: the two floating overlays on the stage are measured against each other. They share the
   * top of the stage and the same `zIndex`, so the check is geometric — their boxes must not
   * intersect — and both boxes have to be locatable for that to be assertable.
   */
  hintCard: 'hint-card',
  viewGizmo: 'view-gizmo',
  /** The empty-scene card and its first-move actions. */
  starterCard: 'starter-card',
  /** A floating notification; `data-count` carries how many identical messages it stands for. */
  toast: 'toast',
  /** Stage 5: the play-mode badge proves the viewport switched modes. */
  viewportBadge: 'viewport-badge',
  /** Stage 1-5: the hierarchy row is clicked to select an object. */
  treeRow: 'tree-row',
  /** Stage 5: the row's label is read to confirm a rename or a selection. */
  treeName: 'tree-name',
  /** Stage 2: the `+ Add component` button lives inside this container. */
  addComponent: 'add-component',
  /** Stage 2: the component menu is opened from this element. */
  addMenu: 'add-menu',
  /** Stage 2: the file input for asset import is scoped through this toolbar. */
  assetToolbar: 'asset-toolbar',
  /** Empty-state text is asserted for scenes and assets. */
  panelEmpty: 'panel-empty',
  /**
   * The HUD host. Not a handle itself: `tools/verify-stage5.ts` scopes `.hud-overlay` through it,
   * and the runtime writes `.coilbox-hud` inside it, so the element has to keep a stable name even
   * though its own positioning is now atomic.
   */
  hudHost: 'hud-host',
  /**
   * Not a gate handle: the flex spacer is used by several panels at once, and as a `stylex.create`
   * style it would be duplicated per panel instead of defined once.
   */
  toolbarSpacer: 'toolbar-spacer',
} as const;

/** The element ids the browser gates reach for directly. */
export const DOM_ID = {
  editorCanvas: 'editor-canvas',
  playCanvas: 'play-canvas',
  gameCanvas: 'game-canvas',
} as const;

/**
 * Modifier class names that travel with the handles above.
 *
 * These are state, not layout: `.active` is both a gate selector (`button.active`) and the visual
 * "this is the current tab/tool" state, so it has to exist as a real class even though the style it
 * carries is now atomic.
 */
export const DOM_STATE = {
  active: 'active',
  selected: 'selected',
} as const;

/**
 * The `data-save-state` values read by stages 1-5.
 *
 * The attribute transitions are the observable behaviour: `clean` means the document on disk matches
 * the editor. Declared as a union so a typo in a panel is a type error rather than a gate that times
 * out comparing against a string that never appears.
 */
export const SAVE_STATE = {
  clean: 'clean',
  dirty: 'dirty',
  error: 'error',
} as const;

/**
 * What `withDomClass` hands back to JSX: exactly `stylex.props()`'s shape, so it spreads onto an
 * element the same way. Derived from the runtime function rather than restated, so a change in
 * StyleX's own return shape cannot leave this contract quietly out of date.
 */
export type DomClassProps = ReturnType<typeof stylex.props>;

/** A style or a `createTheme` class: everything `stylex.props` accepts other than a hook name. */
export type DomClassStyle = StyleXStyles | Theme<VarGroup<{}>>;

/** A single `withDomClass` argument: a style, or a hook class name, or a conditional `false`. */
export type DomClassPart = DomClassStyle | string | false | null | undefined;

/**
 * Narrow a `withDomClass` argument to a hook class name.
 *
 * A style is always an object (or `false`/`null`/`undefined` when conditional), so a string is
 * unambiguously a hook. Written as a type predicate instead of an inline `typeof` so the
 * discrimination is a named, testable contract rather than a local trick.
 */
function isHookName(part: DomClassPart): part is string {
  return typeof part === 'string';
}

/**
 * Combine `stylex.props()` output with the stable hook classes above.
 *
 * Spreading `stylex.props(...)` and then writing a `className` replaces StyleX's generated class
 * list instead of merging with it, because they are the same JSX attribute. This helper does the
 * merge once, in one place, so the failure mode is not available to reintroduce.
 *
 * Arguments are classified by type rather than by position: a string is a hook class, anything else
 * is a style (including a conditional `false`). That keeps a call site reading as one flat list —
 * `withDomClass(styles.row, selected && styles.selected, DOM.treeRow, selected && DOM_STATE.selected)`
 * — instead of requiring two separately-ordered groups.
 *
 * The `style` and `data-style-src` keys are passed through untouched; only `className` is composed.
 */
export function withDomClass(...parts: readonly DomClassPart[]): DomClassProps {
  const styles: DomClassStyle[] = [];
  const hooks: string[] = [];
  for (const part of parts) {
    if (isHookName(part)) hooks.push(part);
    else styles.push(part);
  }

  const compiled = stylex.props(styles);
  if (hooks.length === 0) return compiled;

  const names: string[] = [];
  if (compiled.className) names.push(compiled.className);
  names.push(...hooks.filter((hook) => hook.length > 0));
  return { ...compiled, className: names.join(' ') };
}
