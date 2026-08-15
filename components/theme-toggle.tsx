"use client";

import { useTheme } from "@/components/app-providers";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${nextTheme} mode`;

  return <button
    type="button"
    className={`theme-toggle ${className}`.trim()}
    onClick={toggleTheme}
    aria-label={label}
    aria-pressed={theme === "light"}
    title={label}
  >
    <i className={theme === "dark" ? "pi pi-sun" : "pi pi-moon"} aria-hidden="true" />
    <span>{theme === "dark" ? "Light" : "Dark"}</span>
  </button>;
}
