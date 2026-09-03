'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Light, dark and system themes.
 *
 * The choice is stored on the device and reapplied before the first paint by a
 * small inline script in the document head, so the app never flashes white on
 * launch in dark mode. "System" keeps following the device setting for as long
 * as it is selected.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'pg.theme';

type ThemeContextValue = {
  preference: ThemePreference;
  resolved: 'light' | 'dark';
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  preference: 'system',
  resolved: 'light',
  setPreference: () => undefined,
});

/** Runs before hydration to stop a light flash on a dark device. */
export const THEME_BOOTSTRAP_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('${STORAGE_KEY}') || 'system';
    var dark = stored === 'dark' ||
      (stored === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (error) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');

  const apply = useCallback((next: ThemePreference) => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = next === 'dark' || (next === 'system' && prefersDark);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    setResolved(dark ? 'dark' : 'light');
  }, []);

  useEffect(() => {
    const stored = (window.localStorage.getItem(STORAGE_KEY) as ThemePreference | null) ?? 'system';
    setPreferenceState(stored);
    apply(stored);

    // Only follow the device while "system" is the selected preference.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const current = (window.localStorage.getItem(STORAGE_KEY) as ThemePreference | null) ?? 'system';
      if (current === 'system') apply('system');
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [apply]);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      window.localStorage.setItem(STORAGE_KEY, next);
      setPreferenceState(next);
      apply(next);
    },
    [apply],
  );

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
