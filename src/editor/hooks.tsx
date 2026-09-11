import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { JSX } from 'react';
import { EditorSession, type SessionSnapshot } from './state/editor-session.js';

/**
 * React bridge to the editor session.
 *
 * `useSyncExternalStore` keeps React out of the per-frame path: the session only notifies
 * when authored state changes, and the viewport reads documents imperatively.
 */

const SessionContext = createContext<EditorSession | null>(null);

export function SessionProvider({ session, children }: { session: EditorSession; children: ReactNode }): JSX.Element {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): EditorSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside a SessionProvider');
  return session;
}

export function useSessionSnapshot(): SessionSnapshot {
  const session = useSession();
  return useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.snapshot(),
    () => session.snapshot(),
  );
}

/** True while the viewport or another text field owns the keyboard. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function useStable<T>(factory: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(factory, deps);
}
