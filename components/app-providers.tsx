"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { SessionProvider } from "next-auth/react";
import { PrimeReactProvider } from "primereact/api";
import { PwaProvider } from "@/components/pwa-provider";
import { AppConfirmationDialog } from "@/components/confirmation-dialog";

type Theme = "dark" | "light" | "pure-black";
type DarkTheme = Exclude<Theme, "light">;
type ThemeContextValue = { theme: Theme; toggleTheme: () => void; setDarkTheme: (theme: DarkTheme) => void };

const THEME_STORAGE_KEY = "cipher-budget-theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);
const THEME_COLORS: Record<Theme, string> = { dark: "#1a1718", light: "#fbf9f8", "pure-black": "#000000" };

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
}

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light" || stored === "pure-black") {
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
      const next: Theme = current === "light" ? "dark" : "light";
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      applyTheme(next);
      return next;
    });
  }, []);

  const setDarkTheme = useCallback((next: DarkTheme) => {
    setTheme(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
  }, []);

  return <ThemeContext.Provider value={{ theme, toggleTheme, setDarkTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside AppProviders.");
  return context;
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  return <PwaProvider><ThemeProvider><SessionProvider><PrimeReactProvider value={{ ripple: true }}><AppConfirmationDialog />{children}</PrimeReactProvider></SessionProvider></ThemeProvider></PwaProvider>;
}
