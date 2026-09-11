import { useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { color, space } from '../styles/tokens.stylex.js';
import { DOM, DOM_STATE, withDomClass } from '../dom-contract.js';import { useSession, useSessionSnapshot } from '../hooks.js';
import { AssetBrowser } from './AssetBrowser.js';

/**
 * Bottom panel (plan §3): assets, scenes, and errors/console as tabs.
 *
 * Assets and scene transitions arrive with later stages; the console is already the place
 * where rejected edits, load failures, and runtime errors surface with enough detail to act
 * on. Unsupported or missing content must be understandable here rather than silent.
 */

export type BottomTab = 'assets' | 'scenes' | 'console';

const BOTTOM_TABS: BottomTab[] = ['assets', 'scenes', 'console'];

const styles = stylex.create({
  bottomPanel: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  },
  tabs: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    paddingBlock: space.xs,
    paddingInline: '8px',
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: color.line,
  },
  /**
   * `.tabs button[role='tab'].active` was a descendant selector on the parent. The button knows
   * its own selected state, so the style moved onto the button and the selector disappears.
   */
  tabActive: {
    backgroundColor: '#22314c',
    borderColor: color.accent,
  },
  toolbarSpacer: {
    flex: 1,
  },
  conflict: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    color: color.warn,
  },
  muted: {
    color: color.muted,
    margin: 0,
  },
  tabBody: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
  },
  sceneList: {
    listStyle: 'none',
    margin: 0,
    padding: '6px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
  },
  sceneRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  /** `.scene-list li.active button` — again a descendant rule, moved onto the row itself. */
  sceneRowActive: {
    borderColor: color.accent,
  },
  tag: {
    color: color.muted,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.line,
    borderRadius: '10px',
    paddingBlock: 0,
    paddingInline: space.sm,
    fontSize: '10px',
  },
  logList: {
    listStyle: 'none',
    margin: 0,
    padding: '4px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
  },
  logRow: {
    display: 'flex',
    gap: '8px',
    alignItems: 'baseline',
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
    color: color.muted,
    fontVariantNumeric: 'tabular-nums',
  },
  logDetail: {
    color: color.muted,
  },
  empty: {
    color: color.muted,
    padding: '14px',
    textAlign: 'center',
  },
});

export function BottomPanel({ onReloadScene }: { onReloadScene(): void }): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const [tab, setTab] = useState<BottomTab>('console');

  const errors = snapshot.logs.filter((entry) => entry.level === 'error').length;

  return (
    <section {...stylex.props(styles.bottomPanel)}>
      <div {...withDomClass(styles.tabs, DOM.tabs)} role="tablist">
        {BOTTOM_TABS.map((candidate) => (
          <button
            key={candidate}
            {...withDomClass(tab === candidate && styles.tabActive, tab === candidate && DOM_STATE.active)}
            type="button"
            role="tab"
            aria-selected={tab === candidate}
            onClick={() => {
              setTab(candidate);
              // Agents and other tools can add files behind the editor's back; opening the
              // tab re-reads the manifest rather than showing a stale list.
              if (candidate === 'assets') void session.refreshAssets();
            }}
          >
            {candidate === 'assets' ? 'Assets' : candidate === 'scenes' ? 'Scenes' : `Console${errors > 0 ? ` (${errors})` : ''}`}
          </button>
        ))}
        <span {...withDomClass(styles.toolbarSpacer, DOM.toolbarSpacer)} />
        {snapshot.conflict && (
          <span {...withDomClass(styles.conflict, DOM.conflict)} role="alert">
            {snapshot.conflict.source === 'external' ? 'The file changed on disk.' : 'Save was refused: the file changed on disk.'}
            <button type="button" onClick={() => void session.reloadScene()}>
              Reload from disk
            </button>
            <button type="button" onClick={() => void session.overwriteWithLocal()}>
              Keep my version
            </button>
          </span>
        )}
        {!snapshot.conflict && snapshot.watching && (
          <span {...stylex.props(styles.muted)}>watching for external changes</span>
        )}
        <button type="button" onClick={onReloadScene} title="Re-read the scene from disk">
          Reload
        </button>
        <button type="button" onClick={() => session.clearLogs()}>
          Clear log
        </button>
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
