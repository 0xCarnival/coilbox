import { useState } from 'react';
import type { JSX } from 'react';
import * as stylex from '@stylexjs/stylex';
import { color, fontSize, radius, space } from '../styles/tokens.stylex.js';
import { DOM, DOM_STATE, withDomClass } from '../dom-contract.js';import { useSession, useSessionSnapshot } from '../hooks.js';
import { AssetBrowser } from './AssetBrowser.js';
import { HistoryPanel } from './HistoryPanel.js';

/**
 * Bottom panel (plan §3): assets, scenes, and errors/console as tabs.
 *
 * Assets and scene transitions arrive with later stages; the console is already the place
 * where rejected edits, load failures, and runtime errors surface with enough detail to act
 * on. Unsupported or missing content must be understandable here rather than silent.
 */

export type BottomTab = 'assets' | 'scenes' | 'history' | 'console';

const BOTTOM_TABS: BottomTab[] = ['assets', 'scenes', 'history', 'console'];

const TAB_LABELS: Record<BottomTab, string> = {
  assets: 'Assets',
  scenes: 'Scenes',
  history: 'History',
  console: 'Console',
};

const styles = stylex.create({
  bottomPanel: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  },
  /**
   * The panel header: a 40px band holding the tab chips, with the panel's own actions on the
   * trailing edge and a hairline below.
   *
   * This is the reference's panel-header shape, and the split matters — tabs describe *what* is
   * shown, the trailing controls act on it. Putting Reload and Clear log at the same visual weight
   * as the tabs, as the previous version did, made three view-switchers and two commands look like
   * five peers.
   */
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
  /** The tab track: the segmented control's shell, holding tabs rather than radios. */
  tabTrack: {
    display: 'flex',
    alignItems: 'center',
    height: '28px',
    padding: '3px',
    borderRadius: radius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    backgroundColor: color['panel-2'],
    flexShrink: 0,
  },
  /** The trailing action cluster, separated from the tabs by a rule. */
  tabActions: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xxs,
    marginInlineStart: space.md,
    paddingInlineStart: space.md,
    borderInlineStartWidth: '1px',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: color.border,
  },
  /** A quiet command in the panel header: Reload, Clear log. */
  headerAction: {
    height: '24px',
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
  /**
   * `.tabs button[role='tab'].active` was a descendant selector on the parent. The button knows its
   * own selected state, so the style moved onto the button and the selector disappears.
   */
  tabButton: {
    display: 'flex',
    alignItems: 'center',
    height: '100%',
    paddingInline: space.lg,
    borderRadius: radius.md,
    fontSize: fontSize.xs,
    fontWeight: 500,
    color: color.muted,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transitionProperty: 'background-color, color, box-shadow',
    transitionDuration: '150ms',
    ':hover': {
      color: color.text,
      backgroundColor: color.wash,
    },
  },
  /**
   * The selected tab is the segmented control's selected segment, ring and all.
   *
   * A fill alone was ambiguous beside the trailing commands, which also fill on hover; the inset
   * ring is what distinguishes "this one is selected" from "this one is under the cursor".
   */
  tabActive: {
    backgroundColor: color.surface,
    color: color.text,
    boxShadow: `inset 0 0 0 1px ${color.border}`,
  },
  /** A count on a tab: the console's unread errors. */
  tabBadge: {
    marginInlineStart: space.sm,
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
  tab: controlledTab,
  onTabChange,
}: {
  onReloadScene(): void;
  /**
   * The visible tab, owned by the shell.
   *
   * It is hoisted because the icon rail can select a tab from outside this panel — clicking the
   * Assets icon in the rail has to open the assets tab, and a tab that owned its own state could
   * not be told to.
   */
  tab?: BottomTab;
  onTabChange?(tab: BottomTab): void;
}): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const [ownTab, setOwnTab] = useState<BottomTab>('console');
  const tab = controlledTab ?? ownTab;
  const setTab = (next: BottomTab) => {
    setOwnTab(next);
    onTabChange?.(next);
  };

  const errors = snapshot.logs.filter((entry) => entry.level === 'error').length;

  return (
    <section {...stylex.props(styles.bottomPanel)}>
      <div {...withDomClass(styles.tabs, DOM.tabs)}>
        <div {...stylex.props(styles.tabTrack)} role="tablist" aria-label="Panel">
          {BOTTOM_TABS.map((candidate) => (
          <button
            key={candidate}
            {...withDomClass(
              styles.tabButton,
              tab === candidate && styles.tabActive,
              tab === candidate && DOM_STATE.active,
            )}
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
              {TAB_LABELS[candidate]}
              {/**
               * The error count rides as a badge rather than inside the label: it is a state of the
               * console, not part of its name, and a check reading the tab by text would otherwise
               * have to know how many errors happened to be present.
               */}
              {candidate === 'console' && errors > 0 ? (
                <span {...stylex.props(styles.tabBadge)}>{errors}</span>
              ) : null}
            </button>
          ))}
        </div>
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
          <button {...stylex.props(styles.headerAction)} type="button" onClick={() => session.clearLogs()}>
            Clear log
          </button>
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
        {tab === 'history' && <HistoryPanel />}
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
