import { createContext, useContext } from 'react';
import type { DensityState } from './density.js';
import type { ThemeState } from './theme.js';

/**
 * The editor's appearance settings, owned by the shell and read by the toolbar, the palette and
 * the project home. Both are browser-local preferences about the person at the keyboard; neither
 * belongs in a project document.
 */
export interface Appearance {
  theme: ThemeState;
  density: DensityState;
}

const AppearanceContext = createContext<Appearance | null>(null);

export const AppearanceProvider = AppearanceContext.Provider;

export function useAppearance(): Appearance {
  const appearance = useContext(AppearanceContext);
  if (!appearance) throw new Error('useAppearance called outside an AppearanceProvider');
  return appearance;
}
