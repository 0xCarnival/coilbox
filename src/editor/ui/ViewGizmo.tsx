import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Layers } from 'lucide-react';
import { GIZMO_SIZE, color, fontSize, overlay, space } from '../styles/tokens.stylex.js';
import { DOM, withDomClass } from '../dom-contract.js';
import type { ViewFace } from '../viewport/viewport-controller.js';
import type { ViewportHandle } from '../panels/Viewport.js';
import { BOOKMARK_SLOTS, type BookmarkSlot, type CameraBookmarks } from '../state/camera-bookmarks.js';
import { IconButton } from './Button.js';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './Menu.js';

/**
 * The view gizmo.
 *
 * This replaces the Display panel. The panel's view-mode switch, its projection switch, and the 2D
 * and Split views behind them are all gone: orientation is something you point at directly, and
 * clicking an axis to square up to that face is how you get the flat, parallel-edged view that the 2D
 * mode existed to provide. Blender is the model — an axis ball in the corner of the stage, drag it to
 * tumble, click a handle to look along that axis.
 *
 * ## Why the handles are positioned outside React
 *
 * Every handle's position is a function of the camera's orientation, and the camera changes on every
 * frame of an orbit. Putting that through React state would re-render this component sixty times a
 * second to move six elements, and the render would still be a frame behind the canvas it describes.
 * The elements are rendered once and their transforms are written straight to the nodes on an
 * animation frame. The measurement overlay next door can afford to poll through state because it only
 * runs while something is selected; this one is mounted the whole time the editor is open, so its loop
 * has to be cheap enough to be permanent.
 *
 * ## Why the basis is not a projection
 *
 * The handles show *directions*, so they are placed from the camera's rotation alone rather than from
 * a perspective projection of six points in space. Projecting would make the ball's shape depend on
 * the field of view, and would put the "toward you" and "away from you" handles at different distances
 * from the centre for no reason a user could act on.
 */

/** Three's own transform-gizmo colours, so both gizmos in one scene agree about which axis is which. */
const AXIS_COLOR = { x: '#ff3653', y: '#8adb00', z: '#2c8fff' } as const;

/**
 * The six handles, in draw order.
 *
 * Negative handles come first so that when two of them land on the same pixel — which is exactly what
 * looking straight down an axis does — the positive one is later in the DOM and wins. The depth test
 * below settles it anyway, but the order keeps the common case right without relying on it.
 */
const HANDLES = [
  { face: { axis: 'x', sign: -1 }, label: 'X' },
  { face: { axis: 'y', sign: -1 }, label: 'Y' },
  { face: { axis: 'z', sign: -1 }, label: 'Z' },
  { face: { axis: 'x', sign: 1 }, label: 'X' },
  { face: { axis: 'y', sign: 1 }, label: 'Y' },
  { face: { axis: 'z', sign: 1 }, label: 'Z' },
] as const satisfies ReadonlyArray<{ face: ViewFace; label: string }>;

/** How far a handle sits from the ball's centre, and how big it is. */
const RADIUS = 33;
const HANDLE = 22;

/**
 * Below this many pixels of movement, a pointer gesture is a click rather than an orbit.
 *
 * This was 4, which is inside the wobble of an ordinary press-and-drag: a user intending to orbit
 * would move three or four pixels before the drag registered, the release was then read as a click on
 * whichever handle was under the pointer, and the view snapped to an orthographic face. That is the
 * "touching the gizmo makes it orthographic" report, and the answer is a threshold that a real drag
 * cannot fall under rather than a cleverer guess.
 */
const CLICK_SLOP = 8;

const styles = stylex.create({
  /** The column on the stage's trailing edge: the ball, then the overlays button beneath it. */
  cluster: {
    position: 'absolute',
    insetBlockStart: space.md,
    insetInlineEnd: space.md,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: space.sm,
    zIndex: 30,
  },
  ball: {
    position: 'relative',
    width: overlay.gizmo,
    height: overlay.gizmo,
    /**
     * The ball is a drag surface: it must not scroll or select the page behind it, and the gesture
     * must not also reach the canvas underneath, which has its own orbit listener that would move the
     * camera a second time.
     */
    touchAction: 'none',
    userSelect: 'none',
    cursor: 'grab',
  },
  handle: {
    position: 'absolute',
    insetBlockStart: 0,
    insetInlineStart: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: `${HANDLE}px`,
    height: `${HANDLE}px`,
    padding: 0,
    borderRadius: '50%',
    borderWidth: '1px',
    borderStyle: 'solid',
    fontSize: fontSize.micro,
    fontWeight: 600,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: 1,
    cursor: 'pointer',
    /** The transforms are written per frame, so nothing here may animate them. */
    transitionProperty: 'background-color, border-color',
    transitionDuration: '120ms',
  },
  /**
   * The circle the handles sit on.
   *
   * Six coloured discs on their own read as six loose buttons that happen to be near each other; the
   * ring is what makes them one object that turns. Blender's ball has the same circle, and it earns
   * its place for the same reason.
   *
   * Its size is written inline from `RADIUS` rather than as a token: it is the *same* number that
   * places the handles, and a token here would be a second copy that could drift from the arithmetic.
   */
  ring: {
    position: 'absolute',
    inset: 0,
    margin: 'auto',
    borderRadius: '50%',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color['border-input'],
    pointerEvents: 'none',
  },
  /** The positive end of an axis: a filled disc. Its fill is inline, since the axis colour is data. */
  handlePositive: {
    color: '#171717',
  },
  /** The negative end: a ring, so it reads as "behind" even where it overlaps its positive twin. */
  handleNegative: {
    backgroundColor: color['overlay-soft'],
  },
});

export interface ViewGizmoProps {
  viewport: React.RefObject<ViewportHandle | null>;
  /** Hidden in Play mode, where the camera is not the user's to move and the game is the subject. */
  visible: boolean;
  grid: boolean;
  onGridChange(visible: boolean): void;
  shadows: boolean;
  onShadowsChange(visible: boolean): void;
  measurements: boolean;
  onMeasurementsChange(visible: boolean): void;
  /**
   * The scene's saved framings. Listed in the overlays menu so the shortcut is discoverable and the
   * slots that hold something can be seen without pressing each one.
   */
  bookmarks: CameraBookmarks;
  onSaveBookmark(slot: BookmarkSlot): void;
  onRecallBookmark(slot: BookmarkSlot): void;
  onClearBookmarks(): void;
}

export function ViewGizmo({
  viewport,
  visible,
  grid,
  onGridChange,
  shadows,
  onShadowsChange,
  measurements,
  onMeasurementsChange,
  bookmarks,
  onSaveBookmark,
  onRecallBookmark,
  onClearBookmarks,
}: ViewGizmoProps): JSX.Element | null {
  const savedSlots = BOOKMARK_SLOTS.filter((slot) => bookmarks[slot] !== undefined);
  const freeSlot = BOOKMARK_SLOTS.find((slot) => bookmarks[slot] === undefined) ?? null;
  const handleRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /**
   * The live gesture, so a release can be told from a click.
   *
   * A ref rather than state: it changes on every pointermove and nothing renders from it.
   */
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);

  useEffect(() => {
    if (!visible) return undefined;
    let frame = 0;

    const place = () => {
      frame = requestAnimationFrame(place);
      const basis = viewport.current?.cameraBasis();
      if (!basis) return;

      const centre = GIZMO_SIZE / 2;
      HANDLES.forEach((handle, index) => {
        const node = handleRefs.current[index];
        if (!node) return;

        const vector = [
          handle.face.axis === 'x' ? handle.face.sign : 0,
          handle.face.axis === 'y' ? handle.face.sign : 0,
          handle.face.axis === 'z' ? handle.face.sign : 0,
        ] as const;
        const x = vector[0] * basis.right[0] + vector[1] * basis.right[1] + vector[2] * basis.right[2];
        const y = vector[0] * basis.up[0] + vector[1] * basis.up[1] + vector[2] * basis.up[2];
        const depth =
          vector[0] * basis.forward[0] + vector[1] * basis.forward[1] + vector[2] * basis.forward[2];
        /** Positive when this axis points at the viewer, which is the end that should read as nearest. */
        const toward = -depth;

        const left = centre + x * RADIUS - HANDLE / 2;
        const top = centre - y * RADIUS - HANDLE / 2;

        /**
         * Depth is carried by size and opacity rather than by radius from the centre.
         *
         * A handle pointing away from the viewer is drawn a little smaller and dimmer, which is enough
         * to say which of two overlapping handles is in front, without the ball changing shape as it
         * turns.
         */
        node.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0) scale(${(1 - 0.09 * (1 - toward)).toFixed(3)})`;
        node.style.opacity = (0.62 + 0.38 * ((toward + 1) / 2)).toFixed(3);
        node.style.zIndex = toward >= 0 ? '2' : '1';
      });
    };

    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [visible, viewport]);

  if (!visible) return null;

  /**
   * Start an orbit, and follow it on the window rather than on the ball.
   *
   * Pointer capture would be the tidier way to keep receiving moves outside the element, but it also
   * redirects the release to the ball, and the browser then derives the `click` from a gesture whose
   * end target is no longer the handle — so clicking an axis to square up would stop working. Window
   * listeners keep the drag working everywhere and leave the handles clickable.
   */
  const beginOrbit = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, moved: 0 };

    const move = (moveEvent: PointerEvent) => {
      const current = drag.current;
      if (!current) return;
      const deltaX = moveEvent.clientX - current.x;
      const deltaY = moveEvent.clientY - current.y;
      current.x = moveEvent.clientX;
      current.y = moveEvent.clientY;
      current.moved += Math.abs(deltaX) + Math.abs(deltaY);
      /**
       * Raw pixels, not radians: `orbitBy` owns the pixels-to-radians conversion, and this used to
       * scale the delta here as well — so a 100px drag turned the view 0.011 radians, about 0.6°,
       * and the gizmo felt immovable. One conversion, in one place.
       */
      viewport.current?.orbitBy(deltaX, deltaY);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return (
    <div {...stylex.props(styles.cluster)}>
      <div
        {...withDomClass(styles.ball, DOM.viewGizmo)}
        role="group"
        aria-label="View orientation"
        onPointerDown={beginOrbit}
      >
        <span {...stylex.props(styles.ring)} style={{ width: `${RADIUS * 2}px`, height: `${RADIUS * 2}px` }} />
        {HANDLES.map((handle, index) => {
          const positive = handle.face.sign === 1;
          const name = `${positive ? '+' : '−'}${handle.label}`;
          return (
            <button
              key={`${handle.face.axis}${handle.face.sign}`}
              ref={(node) => {
                handleRefs.current[index] = node;
              }}
              {...stylex.props(styles.handle, positive ? styles.handlePositive : styles.handleNegative)}
              type="button"
              /**
               * The colours are inline because they come from the axis. StyleX resolves its own
               * variables at build time, and an axis colour is data here rather than a design token.
               */
              style={{
                borderColor: AXIS_COLOR[handle.face.axis],
                backgroundColor: positive ? AXIS_COLOR[handle.face.axis] : undefined,
              }}
              title={`Look along ${name}`}
              aria-label={`Look along the ${name} axis`}
              onClick={() => {
                /**
                 * A drag that happened to end over a handle is an orbit, not a request for that face.
                 *
                 * The gesture is consumed here rather than in the pointer handler because the click
                 * always arrives after the release, and clearing it leaves a keyboard-activated click
                 * — which never sets it — working normally.
                 */
                const moved = drag.current?.moved ?? 0;
                drag.current = null;
                if (moved > CLICK_SLOP) return;
                viewport.current?.faceView(handle.face);
              }}
            >
              {handle.label}
            </button>
          );
        })}
      </div>

      {/**
       * The overlays menu: what the Display panel's switches became.
       *
       * Blender keeps these beside the gizmo rather than in a docked panel, and the reason is the same
       * here — they change what the *view* draws, not what the scene contains, so they belong with the
       * view controls and nowhere near the inspector.
       *
       * The menu stays open across a toggle (`preventDefault` on select) so two or three switches can
       * be set in one visit. Radix closes a menu on select, which is right for a command and wrong for
       * a switch.
       */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton size="row" label="View overlays">
            <Layers size={14} />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Overlays</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={grid}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(next) => onGridChange(next === true)}
          >
            Grid
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={shadows}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(next) => onShadowsChange(next === true)}
          >
            Shadows
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={measurements}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(next) => onMeasurementsChange(next === true)}
          >
            Measurements
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>View bookmarks</DropdownMenuLabel>
          {savedSlots.map((slot) => (
            <DropdownMenuItem key={slot} shortcut={`Shift+${slot}`} onSelect={() => onRecallBookmark(slot)}>
              Bookmark {slot} · {bookmarks[slot]?.projection === 'orthographic' ? 'orthographic' : 'perspective'}
            </DropdownMenuItem>
          ))}
          {freeSlot ? (
            <DropdownMenuItem shortcut={`Ctrl+Shift+${freeSlot}`} onSelect={() => onSaveBookmark(freeSlot)}>
              Save this view as bookmark {freeSlot}
            </DropdownMenuItem>
          ) : null}
          {savedSlots.length > 0 ? (
            <DropdownMenuItem onSelect={onClearBookmarks}>Forget the bookmarks for this scene</DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
