import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AlertTriangle, Check, Info, X } from 'lucide-react';
import { color, control, fontSize, overlay, radius, space } from '../styles/tokens.stylex.js';
import { useSessionSnapshot } from '../hooks.js';
import { DOM, withDomClass } from '../dom-contract.js';
import { IconButton } from './Button.js';
import { expireToasts, nextExpiry, pushToast, type Toast } from './toast-queue.js';

/**
 * Transient notifications for things that happened *to* the user.
 *
 * The reference reports the outcome of an action where the action is — a save confirms itself, an
 * export says where it landed — rather than only in a console the user has to go and read. This
 * editor had one status line at the bottom of the window doing all of it, which is easy to miss
 * entirely when the eye is on the viewport, and which says nothing at all about a background job that
 * finishes while the user is looking elsewhere.
 *
 * ## What earns a toast, and what does not
 *
 * Only a *new* log entry becomes a toast. The log is the durable record and keeps everything; a toast
 * is a signal, so it is deliberately filtered:
 *
 * - Not while the console tab is already open. A toast repeating the line the user is looking at is
 *   noise, and the reference does not do it either.
 * - Not twice for the same text. A repeated entry bumps a counter on the toast that is already
 *   showing (`toast-queue.ts`), so a save spammed five times reads "Saved ×5", not five cards.
 *
 * ## Where it sits
 *
 * Over the stage, in its bottom-right corner, rather than over the window's. The workspace corner
 * put the stack on top of the inspector's fields and the status bar — the two places the eye goes
 * right after an action to see what changed. The stage corner is the render, which has nothing to
 * read there. The stack starts above the tool dock's lane, since on a laptop-width stage the corner
 * and the centred dock are close enough to meet.
 *
 * `LogLevel` is `info | warning | error`, so there is no level to filter out — every entry is worth
 * surfacing. A `debug` tier was the first thing written here and the type checker was right to
 * reject it: it guarded a level that does not exist.
 *
 * Each one dismisses itself, and a click dismisses it sooner. Nothing here is the only copy of
 * anything: the console still has every entry, so a missed toast is not a missed message.
 */

const styles = stylex.create({
  region: {
    position: 'absolute',
    insetInlineEnd: space.lg,
    insetBlockEnd: overlay.dockLane,
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    zIndex: 60,
    pointerEvents: 'none',
    width: '340px',
    maxWidth: 'calc(100% - 32px)',
  },
  toast: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderRadius: radius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.border,
    backgroundColor: color.overlay,
    backdropFilter: 'blur(8px)',
    boxShadow: `0 16px 40px ${color.shadow}`,
    pointerEvents: 'auto',
    animationName: 'coilbox-toast-in',
    animationDuration: '140ms',
    animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
    animationFillMode: 'both',
  },
  /** The leading glyph: the toast's whole severity signal, so the text does not have to shout. */
  glyph: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    paddingBlock: '1px',
  },
  glyphInfo: { color: color.muted },
  glyphSuccess: { color: color.ok },
  glyphWarning: { color: color.warn },
  glyphError: { color: color.danger },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    flex: 1,
    minWidth: 0,
  },
  message: {
    fontSize: fontSize.md,
    fontWeight: 500,
    color: color.text,
    overflowWrap: 'anywhere',
  },
  detail: {
    fontSize: fontSize.xs,
    color: color.dim,
    overflowWrap: 'anywhere',
  },
  count: {
    flexShrink: 0,
    alignSelf: 'flex-start',
    paddingBlock: '1px',
    paddingInline: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.wash,
    color: color.muted,
    fontSize: fontSize.xs,
    fontVariantNumeric: 'tabular-nums',
  },
  dismiss: {
    flexShrink: 0,
    marginBlock: '-4px',
    marginInlineEnd: '-6px',
  },
});

const GLYPHS = {
  info: { Icon: Info, style: styles.glyphInfo },
  success: { Icon: Check, style: styles.glyphSuccess },
  ok: { Icon: Check, style: styles.glyphSuccess },
  warning: { Icon: AlertTriangle, style: styles.glyphWarning },
  error: { Icon: AlertTriangle, style: styles.glyphError },
} as const;

/**
 * The glyph for a log level.
 *
 * An explicit switch rather than an index into `GLYPHS`: the level arrives as a `string` on the log
 * entry, and an index would need an assertion about which keys exist. A switch says the same thing
 * and the compiler checks that every level is handled.
 */
function glyphFor(level: string): { Icon: typeof Info; style: stylex.StyleXStyles } {
  switch (level) {
    case 'success':
    case 'ok':
      return GLYPHS.success;
    case 'warning':
      return GLYPHS.warning;
    case 'error':
      return GLYPHS.error;
    default:
      return GLYPHS.info;
  }
}

export function Toasts({ enabled }: { enabled: boolean }): JSX.Element | null {
  const snapshot = useSessionSnapshot();
  const [visible, setVisible] = useState<readonly Toast[]>([]);
  const { logs } = snapshot;
  /**
   * The highest log id already seen, so only genuinely new entries raise a toast. On mount everything
   * but the newest entry counts as seen: the stage mounts after the project has already logged its
   * opening, and a stack of three stale lines is not news.
   */
  const seen = useRef(logs.length > 1 ? (logs[logs.length - 2]?.id ?? 0) : 0);

  /**
   * Every unseen entry is queued, not just the newest: React batches store notifications, so one
   * continuation that logs two warnings and a success reaches this effect once, with all three new.
   */
  useEffect(() => {
    const fresh = logs.filter((entry) => entry.id > seen.current);
    const last = fresh[fresh.length - 1];
    if (!last) return;
    seen.current = last.id;
    if (!enabled) return;
    const now = Date.now();
    setVisible((current) => fresh.reduce((queue, entry) => pushToast(queue, entry, now), current));
  }, [enabled, logs]);

  useEffect(() => {
    const due = nextExpiry(visible);
    if (due === null) return undefined;
    const handle = setTimeout(() => {
      const now = Date.now();
      setVisible((current) => expireToasts(current, now));
    }, Math.max(0, due - Date.now()));
    return () => clearTimeout(handle);
  }, [visible]);

  /**
   * Opening the console clears what is showing rather than leaving duplicates behind: the entries
   * are now in front of the user, and a stack of toasts repeating them would be the opposite of
   * helpful.
   */
  useEffect(() => {
    if (!enabled) setVisible([]);
  }, [enabled]);

  if (!enabled || visible.length === 0) return null;

  return (
    <div {...stylex.props(styles.region)} role="status" aria-live="polite">
      {visible.map((toast) => {
        const { Icon, style } = glyphFor(toast.level);
        return (
          <div key={`${toast.level}:${toast.message}:${toast.detail ?? ''}`} {...withDomClass(styles.toast, DOM.toast)} data-count={toast.count}>
            <span {...stylex.props(styles.glyph, style)}>
              <Icon size={control.iconSm} />
            </span>
            <span {...stylex.props(styles.body)}>
              <span {...stylex.props(styles.message)}>{toast.message}</span>
              {toast.detail ? <span {...stylex.props(styles.detail)}>{toast.detail}</span> : null}
            </span>
            {toast.count > 1 ? (
              <span {...stylex.props(styles.count)} aria-label={`${toast.count} times`}>
                ×{toast.count}
              </span>
            ) : null}
            <span {...stylex.props(styles.dismiss)}>
              <IconButton
                size="row"
                label="Dismiss"
                onClick={() => setVisible((current) => current.filter((entry) => entry.id !== toast.id))}
              >
                <X size={control.iconSm} />
              </IconButton>
            </span>
          </div>
        );
      })}
    </div>
  );
}
