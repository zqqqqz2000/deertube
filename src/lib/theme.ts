export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "deertube-theme";

const isTheme = (value: string | null): value is Theme =>
  value === "light" || value === "dark";

export const getPreferredTheme = (): Theme =>
  window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

export const getInitialTheme = (): Theme => {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return isTheme(stored) ? stored : getPreferredTheme();
};

export const applyTheme = (theme: Theme): void => {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.dataset.theme = theme;
};
