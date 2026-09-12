import * as React from 'react';
import type { UnitSystem } from './units.js';

/* ------------------------------------------------------------------ the editor's setting */

/**
 * The unit system in force, as React context.
 *
 * A context rather than a prop threaded down from the shell: the fields that need it sit several
 * layers inside the Inspector, and the panels between them have no interest in units. Passing it
 * through would put a parameter on every intermediate component for one leaf's benefit.
 *
 * The default is metric, which is what the document stores — a field rendered outside the provider
 * (a test, a story) shows metres rather than silently converting to something arbitrary.
 */
const UnitContext = React.createContext<UnitSystem>('metric');

export function UnitProvider({
  system,
  children,
}: {
  system: UnitSystem;
  children: React.ReactNode;
}): React.ReactElement {
  return <UnitContext.Provider value={system}>{children}</UnitContext.Provider>;
}

/** The unit system in force. */
export function useUnitSystem(): UnitSystem {
  return React.useContext(UnitContext);
}
