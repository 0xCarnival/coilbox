import { useEffect } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { color, controlSize, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { DOM, DOM_STATE, withDomClass } from '../dom-contract.js';
import { useSession, useSessionSnapshot } from '../hooks.js';
import { AssetBrowser } from './AssetBrowser.js';
import { HistoryPanel } from './HistoryPanel.js';

/**
 * Bottom panel (plan §3): assets, scenes, history and the console.
 *
 * Which of them shows is chosen from the icon rail on the left, which already names each one; the
 * panel carries no tab strip of its own, only the header actions for what is showing. The console
 * is the place where rejected edits, load failures, and runtime errors surface with enough detail
 * to act on. Unsupported or missing content must be understandable here rather than silent.
 */

export type BottomTab = 'assets' | 'scenes' | 'history' | 'console';

const styles = stylex.create({
  bottomPanel: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  },
  /** The panel header: a 40px band with the panel's actions on the trailing edge and a hairline below. */
  tabs: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    height: '40px',
    paddingInline: space.md,
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: color.border,
    flexShrink: 0,
  },
  /** The trailing action cluster. */
  tabActions: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xxs,
    marginInlineStart: space.md,
  },
  /** A quiet command in the panel header: Reload, Clear log. */
  headerAction: {
    height: controlSize.row,
    paddingInline: space.md,
    borderRadius: radius.md,
    fontSize: fontSize.sm,
    color: color.muted,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    cursor: 'pointer',
    ':hover': {
      color: color.text,
      backgroundColor: color.wash,
    },
  },
  /** The console's error count, in the header while the console shows. */
  errorCount: {
    paddingInline: '5px',
    borderRadius: radius.pill,
    backgroundColor: color.panel,
    fontSize: fontSize.micro,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    color: color.muted,
  },
  toolbarSpacer: {
    flex: 1,
  },
  conflict: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    color: color.warn,
    fontSize: fontSize.xs,
  },
  muted: {
    color: color.dim,
    margin: 0,
    fontSize: fontSize.xs,
  },
  tabBody: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
  },
  sceneList: {
    listStyle: 'none',
    margin: 0,
    paddingBlock: space.sm,
    paddingInline: space.sm,
    display: 'flex',
    flexDirection: 'column',
    gap: space.xxs,
  },
  sceneRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  /** `.scene-list li.active button` — again a descendant rule, moved onto the row itself. */
  sceneRowActive: {
    color: color.primary,
  },
  tag: {
    color: color.dim,
    backgroundColor: color.wash,
    borderRadius: radius.sm,
    paddingBlock: '1px',
    paddingInline: space.sm,
    fontSize: fontSize.micro,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  },
  logList: {
    listStyle: 'none',
    margin: 0,
    paddingBlock: space.xs,
    paddingInline: space.sm,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  logRow: {
    display: 'flex',
    gap: space.sm,
    alignItems: 'baseline',
    paddingBlock: '1px',
  },
  /** `.log-list li.error .log-message`: the level lives on the row, so the colour follows it here. */
  logMessage: {
    color: color.text,
  },
  logMessageError: {
    color: color.danger,
  },
  logMessageWarning: {
    color: color.warn,
  },
  logTime: {
    color: color.dim,
    fontVariantNumeric: 'tabular-nums',
    fontSize: fontSize.xs,
    flexShrink: 0,
  },
  logDetail: {
    color: color.dim,
    fontSize: fontSize.xs,
  },
  empty: {
    color: color.dim,
    padding: space.lg,
    textAlign: 'center',
    fontSize: fontSize.sm,
  },
});

export function BottomPanel({
  onReloadScene,
  tab = 'console',
  locked = false,
}: {
  onReloadScene(): void;
  /** The visible panel, chosen from the icon rail and owned by the shell. */
  tab?: BottomTab;
  /** True while Play owns the scene: panels that edit the authored document disable their controls. */
  locked?: boolean;
}): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const errors = snapshot.logs.filter((entry) => entry.level === 'error').length;

  // Agents and other tools can add files behind the editor's back; showing the assets re-reads the
  // manifest rather than presenting a stale list.
  useEffect(() => {
    if (tab === 'assets') void session.refreshAssets();
  }, [tab, session]);

  return (
    <section {...stylex.props(styles.bottomPanel)} data-panel={tab}>
      <div {...withDomClass(styles.tabs, DOM.tabs)}>
        {tab === 'console' && errors > 0 && (
          <span {...stylex.props(styles.errorCount)} title="Errors in the log">
            {errors}
          </span>
        )}
        <span {...withDomClass(styles.toolbarSpacer, DOM.toolbarSpacer)} />
        {snapshot.conflict && (
          <span {...withDomClass(styles.conflict, DOM.conflict)} role="alert">
            {snapshot.conflict.source === 'external' ? 'The file changed on disk.' : 'Save was refused: the file changed on disk.'}
            <button {...stylex.props(styles.headerAction)} type="button" onClick={() => void session.reloadScene()}>
              Reload from disk
            </button>
            <button {...stylex.props(styles.headerAction)} type="button" onClick={() => void session.overwriteWithLocal()}>
              Keep my version
            </button>
          </span>
        )}
        {!snapshot.conflict && snapshot.watching && (
          <span {...stylex.props(styles.muted)}>watching for external changes</span>
        )}
        <span {...stylex.props(styles.tabActions)}>
          <button
            {...stylex.props(styles.headerAction)}
            type="button"
            onClick={onReloadScene}
            title="Re-read the scene from disk"
          >
            Reload
          </button>
          {tab === 'console' && (
            <button {...stylex.props(styles.headerAction)} type="button" onClick={() => session.clearLogs()}>
              Clear log
            </button>
          )}
        </span>
      </div>
      <div {...stylex.props(styles.tabBody)}>
        {tab === 'assets' && <AssetBrowser />}
        {tab === 'scenes' && (
          <ul {...withDomClass(styles.sceneList, DOM.sceneList)}>
            {(snapshot.project?.scenes ?? []).map((entry) => (
              <li
                key={entry.id}
                {...withDomClass(
                  styles.sceneRow,
                  entry.id === snapshot.sceneId && styles.sceneRowActive,
                  entry.id === snapshot.sceneId && DOM_STATE.active,
                )}
              >
                <button type="button" onClick={() => void session.openScene(entry.id)}>
                  {entry.name}
                </button>
                {entry.id === snapshot.project?.game.startScene && <span {...stylex.props(styles.tag)}>start scene</span>}
              </li>
            ))}
          </ul>
        )}
        {tab === 'history' && <HistoryPanel locked={locked} />}
        {tab === 'console' && (
          <ul {...withDomClass(styles.logList, DOM.logList)}>
            {[...snapshot.logs].reverse().map((entry) => (
              <li key={entry.id} {...withDomClass(styles.logRow, entry.level)}>
                <span {...stylex.props(styles.logTime)}>{new Date(entry.at).toLocaleTimeString()}</span>
                <span
                  {...stylex.props(
                    styles.logMessage,
                    entry.level === 'error' && styles.logMessageError,
                    entry.level === 'warning' && styles.logMessageWarning,
                  )}
                >
                  {entry.message}
                </span>
                {entry.detail && <span {...stylex.props(styles.logDetail)}>{entry.detail}</span>}
              </li>
            ))}
            {snapshot.logs.length === 0 && (
              <li {...withDomClass(styles.empty, DOM.panelEmpty)}>Nothing logged yet.</li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
