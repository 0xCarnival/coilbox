import { useCallback, useMemo, useState } from 'react';

/**
 * How much room the editor's controls take.
 *
 * `compact` is the design's own scale — 28px toolbar controls, 24px tree rows. `comfortable` adds
 * 4px to every control height and widens the spacing scale a step, for large displays, touch, and
 * anyone who finds the compact rows hard to hit. Like the theme it is a browser-local setting, not a
 * project one.
 */
export type DensityPreference = 'compact' | 'comfortable';

const DENSITY_KEY = 'coilbox.density.v1';

export const DENSITY_PREFERENCES: readonly DensityPreference[] = ['compact', 'comfortable'];

export const DENSITY_LABELS: Record<DensityPreference, string> = {
  compact: 'Compact',
  comfortable: 'Comfortable',
};

export function isDensityPreference(value: string | null | undefined): value is DensityPreference {
  return value === 'compact' || value === 'comfortable';
}

export function loadDensityPreference(): DensityPreference {
  try {
    const stored = globalThis.localStorage?.getItem(DENSITY_KEY);
    return isDensityPreference(stored) ? stored : 'compact';
  } catch {
    return 'compact';
  }
}

export function saveDensityPreference(preference: DensityPreference): void {
  try {
    globalThis.localStorage?.setItem(DENSITY_KEY, preference);
  } catch {
    // A browser with storage disabled still gets the density for this session.
  }
}

export interface DensityState {
  preference: DensityPreference;
  setPreference(next: DensityPreference): void;
}

export function useDensityState(): DensityState {
  const [preference, setPreferenceState] = useState<DensityPreference>(() => loadDensityPreference());
  const setPreference = useCallback((next: DensityPreference) => {
    setPreferenceState(next);
    saveDensityPreference(next);
  }, []);
  return useMemo(() => ({ preference, setPreference }), [preference, setPreference]);
}
