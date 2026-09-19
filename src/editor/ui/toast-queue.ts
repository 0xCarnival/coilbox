/**
 * The queue behind the floating notifications, kept separate from the component so it can be tested
 * without a DOM.
 *
 * Repeats collapse: a log entry that matches the newest toast's level, message and detail bumps that
 * toast's count and its clock instead of stacking a copy. An identical message further back in the
 * queue is pulled forward for the same reason — the point of a toast is to tell you something is
 * happening now, and three cards saying "Saved" say less than one saying "Saved ×3".
 */

export interface Toast {
  /** The log id of the most recent entry the toast stands for. */
  id: number;
  level: string;
  message: string;
  detail?: string;
  /** How many identical log entries the toast collapses. */
  count: number;
  /** When the toast leaves, in the clock of whatever `now` the caller passes. */
  expiresAt: number;
}

export interface ToastEntry {
  id: number;
  level: string;
  message: string;
  detail?: string;
}

export const TOAST_MS = 4200;
export const MAX_TOASTS = 3;

const sameText = (toast: Toast, entry: ToastEntry): boolean =>
  toast.level === entry.level && toast.message === entry.message && (toast.detail ?? '') === (entry.detail ?? '');

/** The queue after a new log entry, newest last, never longer than `MAX_TOASTS`. */
export function pushToast(current: readonly Toast[], entry: ToastEntry, now: number): Toast[] {
  const repeat = current.find((toast) => sameText(toast, entry));
  const expiresAt = now + TOAST_MS;
  if (repeat) {
    return [...current.filter((toast) => toast !== repeat), { ...repeat, id: entry.id, count: repeat.count + 1, expiresAt }];
  }
  const next: Toast[] = [...current, { ...entry, count: 1, expiresAt }];
  return next.slice(-MAX_TOASTS);
}

/** The queue without the toasts whose time is up. */
export function expireToasts(current: readonly Toast[], now: number): readonly Toast[] {
  const kept = current.filter((toast) => toast.expiresAt > now);
  return kept.length === current.length ? current : kept;
}

/** The earliest expiry in the queue, or `null` when nothing is showing. */
export function nextExpiry(current: readonly Toast[]): number | null {
  let earliest: number | null = null;
  for (const toast of current) {
    if (earliest === null || toast.expiresAt < earliest) earliest = toast.expiresAt;
  }
  return earliest;
}
