"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { SessionProvider } from "next-auth/react";
import { PrimeReactProvider } from "primereact/api";

type Theme = "dark" | "light";
type ThemeContextValue = { theme: Theme; toggleTheme: () => void };

const THEME_STORAGE_KEY = "cipher-budget-theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") {
      setTheme(stored);
      applyTheme(stored);
      return;
    }

    const preference = window.matchMedia("(prefers-color-scheme: light)");
    const syncSystemTheme = () => {
      const nextTheme: Theme = preference.matches ? "light" : "dark";
      setTheme(nextTheme);
      applyTheme(nextTheme);
    };
    syncSystemTheme();
    preference.addEventListener("change", syncSystemTheme);
    return () => preference.removeEventListener("change", syncSystemTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      applyTheme(next);
      return next;
    });
  }, []);

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside AppProviders.");
  return context;
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  return <ThemeProvider><SessionProvider><PrimeReactProvider value={{ ripple: true }}>{children}</PrimeReactProvider></SessionProvider></ThemeProvider>;
}
