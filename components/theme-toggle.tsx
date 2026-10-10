"use client";

import { useTheme } from "@/components/app-providers";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggleTheme, setDarkTheme } = useTheme();
  const isDarkMode = theme !== "light";
  const nextTheme = isDarkMode ? "light" : "dark";
  const label = `Switch to ${nextTheme} mode`;

  return <div className={`theme-controls ${className}`.trim()}>
    <button
      type="button"
      className="theme-toggle"
      onClick={toggleTheme}
      aria-label={label}
      aria-pressed={!isDarkMode}
    >
      <i className={isDarkMode ? "pi pi-sun" : "pi pi-moon"} aria-hidden="true" />
      <span>{isDarkMode ? "Light" : "Dark"}</span>
    </button>
    {isDarkMode && <label className="dark-theme-select">
      <span className="visually-hidden">Dark theme</span>
      <select value={theme} onChange={(event) => setDarkTheme(event.target.value as "dark" | "pure-black")} aria-label="Dark theme">
        <option value="pure-black">Pure Black</option>
        <option value="dark">Gray</option>
      </select>
    </label>}
  </div>;
}
