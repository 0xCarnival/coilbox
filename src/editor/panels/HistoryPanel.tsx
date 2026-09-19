import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Check, Circle } from 'lucide-react';
import { color, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { DOM, DOM_STATE, withDomClass } from '../dom-contract.js';
import { useSession, useSessionSnapshot } from '../hooks.js';

/**
 * The undo history as a list.
 *
 * Undo and redo walk one step at a time; this panel shows the whole stack so a user can see how
 * far back "the thing that broke it" is and jump there in one click. Newest first, because the
 * step just made is the one most often reverted. Rows beyond the cursor are what redo would
 * bring back; a new edit discards them, which the dimmed rendering is meant to make plain.
 */

const styles = stylex.create({
  list: {
    listStyle: 'none',
    margin: 0,
    paddingBlock: space.xs,
    paddingInline: space.sm,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: '100%',
    height: '26px',
    paddingInline: space.sm,
    borderRadius: radius.md,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    color: color.text,
    fontSize: fontSize.sm,
    textAlign: 'start',
    cursor: 'pointer',
    ':hover': {
      backgroundColor: color.wash,
    },
  },
  rowCurrent: {
    backgroundColor: color.surface,
    boxShadow: `inset 0 0 0 1px ${color.border}`,
  },
  rowUndone: {
    color: color.dim,
  },
  marker: {
    flexShrink: 0,
    width: '12px',
    height: '12px',
    color: color.dim,
  },
  markerCurrent: {
    color: color.primary,
  },
  label: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  time: {
    color: color.dim,
    fontVariantNumeric: 'tabular-nums',
    fontSize: fontSize.xs,
    flexShrink: 0,
  },
  empty: {
    color: color.dim,
    padding: space.lg,
    textAlign: 'center',
    fontSize: fontSize.sm,
  },
});

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function HistoryPanel(): JSX.Element {
  const session = useSession();
  const { history, historyPosition } = useSessionSnapshot();

  const rows = history.map((entry, index) => ({ entry, position: index + 1 })).reverse();

  return (
    <ul {...withDomClass(styles.list, DOM.historyList)} aria-label="Undo history">
      {rows.map(({ entry, position }) => {
        const current = position === historyPosition;
        const undone = position > historyPosition;
        return (
          <li key={entry.id}>
            <button
              {...withDomClass(styles.row, current && styles.rowCurrent, undone && styles.rowUndone, current && DOM_STATE.active)}
              type="button"
              aria-current={current ? 'step' : undefined}
              title={undone ? `Redo to "${entry.label}"` : current ? 'Current state' : `Undo back to "${entry.label}"`}
              onClick={() => session.jumpHistory(position)}
            >
              {current ? (
                <Check {...stylex.props(styles.marker, styles.markerCurrent)} aria-hidden />
              ) : (
                <Circle {...stylex.props(styles.marker)} aria-hidden />
              )}
              <span {...stylex.props(styles.label)}>{entry.label}</span>
              <span {...stylex.props(styles.time)}>{formatTime(entry.timestamp)}</span>
            </button>
          </li>
        );
      })}
      <li key="origin">
        <button
          {...withDomClass(styles.row, historyPosition === 0 && styles.rowCurrent, historyPosition === 0 && DOM_STATE.active)}
          type="button"
          aria-current={historyPosition === 0 ? 'step' : undefined}
          title={historyPosition === 0 ? 'Current state' : 'Undo everything since the scene was opened'}
          onClick={() => session.jumpHistory(0)}
        >
          {historyPosition === 0 ? (
            <Check {...stylex.props(styles.marker, styles.markerCurrent)} aria-hidden />
          ) : (
            <Circle {...stylex.props(styles.marker)} aria-hidden />
          )}
          <span {...stylex.props(styles.label)}>Scene opened</span>
        </button>
      </li>
      {history.length === 0 && <li {...withDomClass(styles.empty, DOM.panelEmpty)}>No edits yet. Changes you make appear here and can be jumped back to.</li>}
    </ul>
  );
}
