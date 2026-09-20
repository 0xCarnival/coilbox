import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isThemePreference,
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
} from '@editor/state/theme.js';
import { isDensityPreference, loadDensityPreference, saveDensityPreference } from '@editor/state/density.js';

/**
 * Theme and density are browser-local preferences. These tests pin the two things a preference must
 * get right without a browser: an unreadable or foreign stored value falls back to the default instead
 * of throwing, and `system` resolves through `prefers-color-scheme` rather than being a third theme.
 */

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  });
  return store;
}

function stubColorScheme(light: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-color-scheme: light)' && light,
    addEventListener() {},
    removeEventListener() {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme preference', () => {
  it('defaults to system when nothing is stored or storage is unavailable', () => {
    stubStorage();
    expect(loadThemePreference()).toBe('system');
    vi.stubGlobal('localStorage', undefined);
    expect(loadThemePreference()).toBe('system');
  });

  it('ignores a stored value that is not a theme', () => {
    stubStorage({ 'coilbox.theme.v1': 'sepia' });
    expect(loadThemePreference()).toBe('system');
    expect(isThemePreference('sepia')).toBe(false);
    expect(isThemePreference('light')).toBe(true);
  });

  it('round-trips an explicit preference', () => {
    const store = stubStorage();
    saveThemePreference('light');
    expect(store.get('coilbox.theme.v1')).toBe('light');
    expect(loadThemePreference()).toBe('light');
  });

  it('survives storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(loadThemePreference()).toBe('system');
    expect(() => saveThemePreference('dark')).not.toThrow();
  });

  it('resolves system through prefers-color-scheme and explicit themes as themselves', () => {
    stubColorScheme(true);
    expect(resolveTheme('system')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
    stubColorScheme(false);
    expect(resolveTheme('system')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });

  it('resolves system to dark when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(resolveTheme('system')).toBe('dark');
  });
});

describe('density preference', () => {
  it('defaults to compact and rejects unknown values', () => {
    stubStorage({ 'coilbox.density.v1': 'spacious' });
    expect(loadDensityPreference()).toBe('compact');
    expect(isDensityPreference('spacious')).toBe(false);
    expect(isDensityPreference('comfortable')).toBe(true);
  });

  it('round-trips an explicit preference', () => {
    const store = stubStorage();
    saveDensityPreference('comfortable');
    expect(store.get('coilbox.density.v1')).toBe('comfortable');
    expect(loadDensityPreference()).toBe('comfortable');
  });
});
