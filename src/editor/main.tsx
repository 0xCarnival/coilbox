import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { EditorSession } from './state/editor-session.js';
import { workspaceClient } from './api/client.js';
/**
 * The UI typeface, bundled rather than fetched.
 *
 * The reference sets its interface in Barlow and loads it from Google Fonts. This editor is
 * local-first and an export must not reach for a network font, so the two weights the UI actually
 * uses are imported from `@fontsource/barlow` — OFL-1.1, self-hosted woff2 that Vite fingerprints
 * into the build. `styles.css` asks for Barlow first and falls back to the system stack, so the
 * font failing to load degrades rather than breaks.
 *
 * Imported by weight *and subset*. The default `400.css` pulls every subset the family ships — latin,
 * latin-ext, and vietnamese — in both `woff2` and `woff`, which measured 184 KB of build output for an
 * interface that is set in English. The `latin-*` entry points carry one subset each, and the ladder
 * uses two weights, so this is four files instead of twelve.
 *
 * This import is in the editor's entry point, not the runtime's: an exported game ships the player
 * and the HUD, neither of which has any styling dependency on the editor.
 */
import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
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
