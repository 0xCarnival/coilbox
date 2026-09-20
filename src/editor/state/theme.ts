import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * The editor's colour theme, as a preference and as what is on screen.
 *
 * `system` follows the operating system's `prefers-color-scheme` and tracks it live, so a machine
 * that switches at sunset takes the editor with it. The preference is an editor setting, like the
 * panel layout: it lives in `localStorage`, not in any project document, because it describes the
 * person at the keyboard and not the game.
 */
export type ThemePreference = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

const THEME_KEY = 'coilbox.theme.v1';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'dark', 'light'];

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'Follow system',
  dark: 'Dark',
  light: 'Light',
};

export function isThemePreference(value: string | null | undefined): value is ThemePreference {
  return value === 'system' || value === 'dark' || value === 'light';
}

export function loadThemePreference(): ThemePreference {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    globalThis.localStorage?.setItem(THEME_KEY, preference);
  } catch {
    // A browser with storage disabled still gets the theme for this session.
  }
}

function systemTheme(): ResolvedTheme {
  return globalThis.matchMedia?.(LIGHT_QUERY).matches ? 'light' : 'dark';
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

export interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference(next: ThemePreference): void;
}

/**
 * The theme preference and the theme it currently resolves to.
 *
 * Writing the resolved theme onto `<html data-theme>` is what lets `styles.css` switch the element
 * defaults and `color-scheme` (so native controls and scrollbars follow) — StyleX's theme class is
 * applied at the React root and cannot reach the document element from there.
 */
export function useThemeState(): ThemeState {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => loadThemePreference());
  const [system, setSystem] = useState<ResolvedTheme>(() => systemTheme());

  useEffect(() => {
    const query = globalThis.matchMedia?.(LIGHT_QUERY);
    if (!query) return undefined;
    const onChange = () => setSystem(query.matches ? 'light' : 'dark');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme = preference === 'system' ? system : preference;

  useEffect(() => {
    document.documentElement.dataset['theme'] = resolved;
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    saveThemePreference(next);
  }, []);

  return useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference]);
}
