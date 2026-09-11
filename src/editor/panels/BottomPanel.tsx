import { useState } from 'react';
import type { JSX } from 'react';
import { useSession, useSessionSnapshot } from '../hooks.js';
import { AssetBrowser } from './AssetBrowser.js';

/**
 * Bottom panel (plan §3): assets, scenes, and errors/console as tabs.
 *
 * Assets and scene transitions arrive with later stages; the console is already the place
 * where rejected edits, load failures, and runtime errors surface with enough detail to act
 * on. Unsupported or missing content must be understandable here rather than silent.
 */

export type BottomTab = 'assets' | 'scenes' | 'console';

export function BottomPanel({ onReloadScene }: { onReloadScene(): void }): JSX.Element {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const [tab, setTab] = useState<BottomTab>('console');

  const errors = snapshot.logs.filter((entry) => entry.level === 'error').length;

  return (
    <section className="bottom-panel">
      <div className="tabs" role="tablist">
        {(['assets', 'scenes', 'console'] as BottomTab[]).map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={tab === candidate}
            className={tab === candidate ? 'active' : ''}
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
        <span className="toolbar-spacer" />
        {snapshot.conflict && (
          <span className="conflict">
            The file changed on disk.
            <button type="button" onClick={() => void session.reloadScene()}>
              Reload from disk
            </button>
            <button type="button" onClick={() => void session.overwriteWithLocal()}>
              Keep my version
            </button>
          </span>
        )}
        <button type="button" onClick={onReloadScene} title="Re-read the scene from disk">
          Reload
        </button>
        <button type="button" onClick={() => session.clearLogs()}>
          Clear log
        </button>
      </div>
      <div className="tab-body">
        {tab === 'assets' && <AssetBrowser />}
        {tab === 'scenes' && (
          <ul className="scene-list">
            {(snapshot.project?.scenes ?? []).map((entry) => (
              <li key={entry.id} className={entry.id === snapshot.sceneId ? 'active' : ''}>
                <button type="button" onClick={() => void session.openScene(entry.id)}>
                  {entry.name}
                </button>
                {entry.id === snapshot.project?.game.startScene && <span className="tag">start scene</span>}
              </li>
            ))}
          </ul>
        )}
        {tab === 'console' && (
          <ul className="log-list">
            {[...snapshot.logs].reverse().map((entry) => (
              <li key={entry.id} className={entry.level}>
                <span className="log-time">{new Date(entry.at).toLocaleTimeString()}</span>
                <span className="log-message">{entry.message}</span>
                {entry.detail && <span className="log-detail">{entry.detail}</span>}
              </li>
            ))}
            {snapshot.logs.length === 0 && <li className="panel-empty">Nothing logged yet.</li>}
          </ul>
        )}
      </div>
    </section>
  );
}
