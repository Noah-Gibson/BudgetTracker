"use client";

import { useTheme } from "@/components/app-providers";
import { LocalTooltip } from "@/components/local-tooltip";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${nextTheme} mode`;

  return <LocalTooltip label={label} className={className}><button
    type="button"
    className="theme-toggle"
    onClick={toggleTheme}
    aria-label={label}
    aria-pressed={theme === "light"}
  >
    <i className={theme === "dark" ? "pi pi-sun" : "pi pi-moon"} aria-hidden="true" />
    <span>{theme === "dark" ? "Light" : "Dark"}</span>
  </button></LocalTooltip>;
}
