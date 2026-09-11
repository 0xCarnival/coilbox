import type { JSX, SVGProps } from 'react';

/**
 * The editor's icon set.
 *
 * Hand-written inline SVG rather than an icon package, for three reasons: the editor ships an
 * export pipeline and an icon dependency would be one more thing that graph has to avoid; every
 * glyph here is 16px on a 1.5px stroke, which is a specific enough house style that a generic pack
 * would need per-icon overrides anyway; and `currentColor` means an icon inherits the muted, text,
 * or accent colour of whatever row it sits in with no prop threading.
 *
 * Icons are decorative. Every one of them accompanies a visible text label or an element that
 * already carries `aria-label`/`title`, so the `aria-hidden` here is correct rather than a
 * shortcut — replacing a word with an icon is a decision that has to bring its own accessible name
 * with it, and none of these do it silently.
 *
 * The set is intentionally small. An icon earns its place by making something *findable* that text
 * makes slow: the type of an entity in a long tree, or a transport control you press repeatedly.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/** Shared frame: one 16px box, one stroke width, no fill. */
function Icon({ size = 14, children, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** A mesh: the default entity, and what the hierarchy uses when nothing more specific applies. */
export function IconMesh(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 1.75 14 5v6l-6 3.25L2 11V5z" />
      <path d="M2 5l6 3.25L14 5M8 8.25v6" />
    </Icon>
  );
}

/** A light. Distinguishes the entities that illuminate a scene from the ones that merely exist. */
export function IconLight(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
    </Icon>
  );
}

/** A camera. Without this the camera is just another row that is easy to delete by accident. */
export function IconCamera(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M1.75 5.25A1.5 1.5 0 0 1 3.25 3.75h5A1.5 1.5 0 0 1 9.75 5.25v5.5a1.5 1.5 0 0 1-1.5 1.5h-5a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M9.75 7 14.25 4.5v7L9.75 9z" />
    </Icon>
  );
}

/** A group. The chevron already says "this has children"; this says "this has no geometry of its own". */
export function IconGroup(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M1.75 5.5 8 2l6.25 3.5L8 9z" />
      <path d="M1.75 9.5 8 13l6.25-3.5" />
    </Icon>
  );
}

/** A trigger volume: a dashed boundary around nothing solid. */
export function IconTrigger(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M5.5 2.25H3.75A1.5 1.5 0 0 0 2.25 3.75V5.5M10.5 2.25h1.75a1.5 1.5 0 0 1 1.5 1.5V5.5M13.75 10.5v1.75a1.5 1.5 0 0 1-1.5 1.5H10.5M5.5 13.75H3.75a1.5 1.5 0 0 1-1.5-1.5V10.5" />
    </Icon>
  );
}

/** A behaviour/script attachment — the logic that runs on an entity. */
export function IconBehavior(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6 2.25 4.25 13.75M11.75 2.25 10 13.75M2.5 5.75h11M2 10.25h11" />
    </Icon>
  );
}

/** Undo/redo. `direction` flips the arrow instead of maintaining two near-identical paths. */
export function IconHistory({ direction, ...props }: IconProps & { direction: 'undo' | 'redo' }): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M2.75 7.5a5.25 5.25 0 1 1 1.6 3.78" />
      {direction === 'undo' ? <path d="M2.25 3.5v4h4" /> : <path d="M13.75 3.5v4h-4" />}
    </Icon>
  );
}

/** Transport controls. Filled, because these are the one place a solid glyph reads faster than a line. */
export function IconPlay(props: IconProps): JSX.Element {
  return (
    <Icon {...props} fill="currentColor" stroke="none">
      <path d="M4.5 2.9a.6.6 0 0 1 .92-.5l7.1 4.6a.6.6 0 0 1 0 1l-7.1 4.6a.6.6 0 0 1-.92-.5z" />
    </Icon>
  );
}

export function IconPause(props: IconProps): JSX.Element {
  return (
    <Icon {...props} fill="currentColor" stroke="none">
      <rect x="4" y="3" width="3" height="10" rx="1" />
      <rect x="9" y="3" width="3" height="10" rx="1" />
    </Icon>
  );
}

export function IconStop(props: IconProps): JSX.Element {
  return (
    <Icon {...props} fill="currentColor" stroke="none">
      <rect x="3.75" y="3.75" width="8.5" height="8.5" rx="1.5" />
    </Icon>
  );
}

/** Step one frame. */
export function IconStep(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 3.5 10 8l-6 4.5z" fill="currentColor" stroke="none" />
      <path d="M12.25 3.5v9" />
    </Icon>
  );
}

/** Save/export: an arrow leaving a tray. */
export function IconExport(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 10V2.5M5.25 5.25 8 2.5l2.75 2.75" />
      <path d="M2.5 10.5v1.75a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5V10.5" />
    </Icon>
  );
}

/** A picture: set the project thumbnail from the current view. */
export function IconCameraCapture(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="1.75" y="4.25" width="12.5" height="8.5" rx="1.5" />
      <circle cx="8" cy="8.5" r="2.25" />
      <path d="M5.75 4.25 6.5 2.5h3l.75 1.75" />
    </Icon>
  );
}

export function IconPlus(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </Icon>
  );
}

/** A magnifier for the search fields, which otherwise read as empty text inputs. */
export function IconSearch(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="7.25" cy="7.25" r="4.5" />
      <path d="m10.75 10.75 2.5 2.5" />
    </Icon>
  );
}

/** Trailing chevron for a disclosure. Rotates with `open` rather than swapping glyphs. */
export function IconChevron({ open, ...props }: IconProps & { open: boolean }): JSX.Element {
  /**
   * The rotation is an SVG `transform` attribute on an inner group rather than an inline `style`.
   * The style form collides with the `{...props}` spread on the frame — `style` and the spread are
   * the same attribute, which `coilbox/no-classname-after-spread` correctly refuses to allow.
   */
  return (
    <Icon {...props}>
      <g
        transform={open ? 'rotate(90 8 8)' : undefined}
        style={{ transition: 'transform 120ms ease', transformOrigin: '8px 8px' }}
      >
        <path d="m6 3.5 4.5 4.5L6 12.5" />
      </g>
    </Icon>
  );
}

/** The overflow affordance. Three dots, no circle — a circled variant reads as a status light. */
export function IconMore(props: IconProps): JSX.Element {
  return (
    <Icon {...props} fill="currentColor" stroke="none">
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </Icon>
  );
}

/** Visibility toggle: an open eye, and the same eye struck through. */
export function IconEye({ hidden, ...props }: IconProps & { hidden?: boolean }): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z" />
      <circle cx="8" cy="8" r="1.75" />
      {hidden && <path d="M2.5 2.5l11 11" />}
    </Icon>
  );
}

/** Lock: a closed shackle, and an open one. */
export function IconLock({ open, ...props }: IconProps & { open?: boolean }): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="3.5" y="7" width="9" height="6.25" rx="1.25" />
      {open ? <path d="M5.75 7V4.75a2.25 2.25 0 0 1 4.4-.65" /> : <path d="M5.75 7V4.75a2.25 2.25 0 0 1 4.5 0V7" />}
    </Icon>
  );
}

/** A folder, for the asset browser and the project cards. */
export function IconFolder(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M1.75 4.5A1.5 1.5 0 0 1 3.25 3h2.4a1.5 1.5 0 0 1 1.2.6l.7.9h5.2a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5z" />
    </Icon>
  );
}

/** A file, for asset rows. */
export function IconFile(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9 1.75H4.75a1.5 1.5 0 0 0-1.5 1.5v9.5a1.5 1.5 0 0 0 1.5 1.5h6.5a1.5 1.5 0 0 0 1.5-1.5V5.5z" />
      <path d="M9 1.75V5.5h3.75" />
    </Icon>
  );
}

/** A back arrow, for leaving a project for the project list. */
export function IconBack(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M13 8H3M7 3.5 2.5 8 7 12.5" />
    </Icon>
  );
}

/** Copy, for duplicating a project. Two offset rounded rectangles. */
export function IconCopy(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.5" />
      <path d="M10.25 5.75v-2.5a1.5 1.5 0 0 0-1.5-1.5h-5.5a1.5 1.5 0 0 0-1.5 1.5v5.5a1.5 1.5 0 0 0 1.5 1.5h2.5" />
    </Icon>
  );
}

/** An archive box: a lid over a container. */
export function IconArchive(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <rect x="2" y="2.75" width="12" height="3.5" rx="1" />
      <path d="M3.25 6.25v6.5a1.5 1.5 0 0 0 1.5 1.5h6.5a1.5 1.5 0 0 0 1.5-1.5v-6.5" />
      <path d="M6.5 9.25h3" />
    </Icon>
  );
}

/** A close/remove cross. */
export function IconClose(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  );
}
