import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { EditorSession } from './state/editor-session.js';
import { workspaceClient } from './api/client.js';
import './styles.css';

/**
 * Editor entry point (`index.html`).
 *
 * The session is created outside React so the viewport and the panels share one document
 * store; React only renders panels.
 */

const container = document.getElementById('root');
if (!container) throw new Error('index.html is missing #root');

const session = new EditorSession(workspaceClient);

// Exposed for the browser checks in tools/verify-stage1.ts; authoring still goes through
// the same commands and the same API.
declare global {
  interface Window {
    __STUDIO__?: {
      session: EditorSession;
      ready: Promise<void>;
      /** Set by the editor shell once the viewport is mounted. */
      viewport?: () => import('./panels/Viewport.js').ViewportHandle | null;
    };
  }
}

window.__STUDIO__ = { session, ready: session.refreshProjects().then(() => undefined) };

createRoot(container).render(
  <StrictMode>
    <App session={session} />
  </StrictMode>,
);
