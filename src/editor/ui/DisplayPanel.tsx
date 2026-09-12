import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ChevronDown, Grid3x3, Magnet, Monitor, Ruler, Sun, SquareDashed } from 'lucide-react';
import { color, control, fontSize, radius, space } from '../styles/tokens.stylex.js';
import type { SnapSettings } from '../viewport/viewport-controller.js';
import type { ViewportDisplay, ViewportHandle } from '../panels/Viewport.js';
import { SegmentedControl, type SegmentedOption } from './Controls.js';
import { Switch } from './Field.js';
import { SegmentedControl as _SegmentedControl } from './Controls.js';
import type { UnitSystem } from '../units.js';
import { IconButton } from './Button.js';

/**
 * The display settings panel.
 *
 * The reference keeps a Display section on the stage that toggles what the *view* shows — shadows,
 * camera projection, units, theme — separately from what the scene contains. That separation is the
 * point: a shadow switch and a light's cast-shadow property are different things, and conflating
 * them in the inspector is how a user ends up editing their document when they meant to change how
 * they are looking at it.
 *
 * ## Why the values are read back from the viewport
 *
 * `projection`, `grid`, and `shadows` each mutate a Three object. They are not React state and a
 * re-render would not touch them, so the panel reads the current value back from the viewport after
 * every change rather than holding a copy that can drift. `snap` is the exception — that one is
 * already editor state, owned by the shell, so it is passed in and out.
 */

const styles = stylex.create({
  panel: {
    position: 'absolute',
    insetBlockStart: space.md,
    insetInlineEnd: space.md,
    width: '248px',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: radius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.border,
    backgroundColor: 'rgba(23, 23, 23, 0.92)',
    backdropFilter: 'blur(10px)',
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5)',
    zIndex: 30,
    overflow: 'hidden',
    animationName: 'coilbox-toast-in',
    animationDuration: '140ms',
    animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
    animationFillMode: 'both',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    height: '36px',
    paddingInline: space.md,
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: color.border,
    color: color.muted,
    flexShrink: 0,
  },
  title: {
    flex: 1,
    fontSize: fontSize.sm,
    fontWeight: 500,
    color: color.text,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.md,
  },
  /** A settings row: a leading glyph, the name, then the control. */
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minHeight: '28px',
  },
  rowGlyph: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    color: color.dim,
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: fontSize.sm,
    color: color.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The unit switch is narrow: two short labels, and it shares a row with its name. */
  unitSwitch: {
    width: '116px',
    flexShrink: 0,
  },
  /** The projection switch is a full-width segmented control under its own caption. */
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
  },
  fieldLabel: {
    fontSize: fontSize.micro,
    fontWeight: 600,
    letterSpacing: '0.09em',
    textTransform: 'uppercase',
    color: color.dim,
  },
});

const VIEW_MODES = [
  { value: '3d', label: '3D' },
  { value: '2d', label: '2D' },
  { value: 'split', label: 'Split' },
] satisfies readonly SegmentedOption<ViewportDisplay['mode']>[];

const UNIT_OPTIONS = [
  { value: 'metric', label: 'm' },
  { value: 'imperial', label: 'ft' },
] satisfies readonly SegmentedOption<UnitSystem>[];

const PROJECTIONS = [
  { value: 'perspective', label: 'Perspective' },
  { value: 'orthographic', label: 'Ortho' },
] satisfies readonly SegmentedOption<ViewportDisplay['projection']>[];

export interface DisplayPanelProps {
  viewport: React.RefObject<ViewportHandle | null>;
  snap: SnapSettings;
  onSnapChange(snap: SnapSettings): void;
  /** The unit system lengths are shown in. The document stays in metres either way. */
  units: UnitSystem;
  onUnitsChange(units: UnitSystem): void;
  /** Whether the dimension overlay is drawn over the selection. */
  measurements: boolean;
  onMeasurementsChange(visible: boolean): void;
  /** Shown collapsed to its header when false, so the stage is not permanently covered. */
  defaultOpen?: boolean;
}

export function DisplayPanel({
  viewport,
  snap,
  onSnapChange,
  units,
  onUnitsChange,
  measurements,
  onMeasurementsChange,
  defaultOpen = true,
}: DisplayPanelProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const [display, setDisplay] = useState<ViewportDisplay>({
    projection: 'perspective',
    grid: true,
    shadows: true,
    mode: '3d',
  });

  /**
   * Pull the live values out of the viewport.
   *
   * Deferred by a frame because the viewport is created in an effect below this one: on the first
   * render the handle exists but the Three objects behind it do not, and reading through it would
   * report defaults that are not what is on screen.
   */
  const sync = useCallback(() => {
    const handle = viewport.current;
    if (handle) setDisplay(handle.display());
  }, [viewport]);

  useEffect(() => {
    const frame = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frame);
  }, [sync]);

  const update = (next: Partial<ViewportDisplay>) => {
    viewport.current?.setDisplay(next);
    sync();
  };

  return (
    <div {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.header)}>
        <Monitor size={control.iconSm} />
        <span {...stylex.props(styles.title)}>Display</span>
        <IconButton
          size="row"
          label={open ? 'Collapse display settings' : 'Expand display settings'}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDown
            size={control.iconSm}
            style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}
          />
        </IconButton>
      </div>

      {open ? (
        <div {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.field)}>
            <span {...stylex.props(styles.fieldLabel)}>View</span>
            <SegmentedControl<ViewportDisplay['mode']>
              ariaLabel="View mode"
              value={display.mode}
              onChange={(mode) => update({ mode })}
              options={VIEW_MODES}
            />
          </div>

          <div {...stylex.props(styles.field)}>
            <span {...stylex.props(styles.fieldLabel)}>Camera</span>
            <SegmentedControl<ViewportDisplay['projection']>
              ariaLabel="Camera projection"
              value={display.projection}
              onChange={(projection) => update({ projection })}
              options={PROJECTIONS}
              /**
               * In the plan view the camera is orthographic by definition, so the switch has
               * nothing to choose. Disabling it says that; hiding it would make the panel's contents
               * change shape as the view mode does.
               */
              disabled={display.mode === '2d'}
            />
          </div>

          <div {...stylex.props(styles.row)}>
            <span {...stylex.props(styles.rowGlyph)}>
              <Grid3x3 size={control.iconSm} />
            </span>
            <span {...stylex.props(styles.rowLabel)}>Grid</span>
            <Switch
              label="Show the ground grid"
              checked={display.grid}
              onCheckedChange={(grid) => update({ grid })}
            />
          </div>

          <div {...stylex.props(styles.row)}>
            <span {...stylex.props(styles.rowGlyph)}>
              <Sun size={control.iconSm} />
            </span>
            <span {...stylex.props(styles.rowLabel)}>Shadows</span>
            <Switch
              label="Render cast shadows"
              checked={display.shadows}
              onCheckedChange={(shadows) => update({ shadows })}
            />
          </div>

          <div {...stylex.props(styles.row)}>
            <span {...stylex.props(styles.rowGlyph)}>
              <Ruler size={control.iconSm} />
            </span>
            <span {...stylex.props(styles.rowLabel)}>Units</span>
            <span {...stylex.props(styles.unitSwitch)}>
              <SegmentedControl<UnitSystem>
                ariaLabel="Unit system"
                value={units}
                onChange={onUnitsChange}
                options={UNIT_OPTIONS}
              />
            </span>
          </div>

          <div {...stylex.props(styles.row)}>
            <span {...stylex.props(styles.rowGlyph)}>
              <SquareDashed size={control.iconSm} />
            </span>
            <span {...stylex.props(styles.rowLabel)}>Measurements</span>
            <Switch
              label="Show the selection's dimensions"
              checked={measurements}
              onCheckedChange={onMeasurementsChange}
            />
          </div>

          <div {...stylex.props(styles.row)}>
            <span {...stylex.props(styles.rowGlyph)}>
              <Magnet size={control.iconSm} />
            </span>
            <span {...stylex.props(styles.rowLabel)}>Snap to grid</span>
            <Switch
              label="Snap transforms to the grid"
              checked={snap.enabled}
              onCheckedChange={(enabled) => onSnapChange({ ...snap, enabled })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
