'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { getTelegramWebApp } from './telegram';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'bingo.theme.v1';

export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

const CHROME: Record<Theme, string> = {
  dark: '#050d0b',
  light: '#f4f8f4',
};

interface ThemeValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function readStored(): Theme | null {
  if (typeof window === 'undefined') return null;
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === 'dark' || value === 'light' ? value : null;
}

function systemTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function telegramTheme(): Theme | null {
  const app = getTelegramWebApp();
  if (!app?.colorScheme) return null;
  return app.colorScheme === 'light' ? 'light' : 'dark';
}

function apply(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const app = getTelegramWebApp();
  try {
    app?.setHeaderColor?.(CHROME[theme]);
    app?.setBackgroundColor?.(CHROME[theme]);
    app?.setBottomBarColor?.(CHROME[theme]);
  } catch {
    // Older Telegram clients ignore unknown chrome colours.
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('dark');

  useEffect(() => {
    const stored = readStored();
    const initial = stored ?? telegramTheme() ?? systemTheme();
    setThemeState(initial);
    apply(initial);
  }, []);

  // Until the player picks a theme themselves, keep following the Telegram
  // client so system dark/light switches do not leave the Mini App mismatched.
  useEffect(() => {
    const app = getTelegramWebApp();
    if (!app) return;
    const sync = () => {
      if (readStored()) return;
      const next = telegramTheme() ?? systemTheme();
      setThemeState(next);
      apply(next);
    };
    try {
      app.onEvent?.('themeChanged', sync);
    } catch {
      // Older clients do not emit themeChanged.
    }
    return () => {
      try {
        app.offEvent?.('themeChanged', sync);
      } catch {
        // Nothing to unsubscribe from.
      }
    };
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    apply(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing can refuse storage; the in-memory theme still applies.
    }
  }, []);

  const toggle = useCallback(() => {
    setThemeState((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      apply(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Ignore storage failures.
      }
      return next;
    });
  }, []);

  const value = useMemo<ThemeValue>(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
