import { useSyncExternalStore } from "react";

// The theme is "system", "dark" or "light". The choice stays in
// localStorage. index.html sets it before the first paint.
export type ThemeChoice = "system" | "dark" | "light";

const KEY = "fullsend-theme";

const listeners = new Set<() => void>();

const media = window.matchMedia("(prefers-color-scheme: dark)");

const CHOICES: readonly string[] = ["system", "dark", "light"];

function isThemeChoice(v: string | null): v is ThemeChoice {
  return v !== null && CHOICES.includes(v);
}

// A value that is not a known choice gives "system".
const read = (): ThemeChoice => {
  const v = localStorage.getItem(KEY);

  return isThemeChoice(v) ? v : "system";
};

function apply() {
  const choice = read();
  const dark = choice === "dark" || (choice === "system" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

media.addEventListener("change", apply);

apply();

const still = window.matchMedia("(prefers-reduced-motion: reduce)");

export function setTheme(choice: ThemeChoice) {
  localStorage.setItem(KEY, choice);

  // A cross-fade, so a change from dark to light is not a flash.
  if ("startViewTransition" in document && !still.matches)
    document.startViewTransition(apply);
  else apply();

  for (const fn of listeners) fn();
}

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const choice = useSyncExternalStore((fn) => {
    listeners.add(fn);

    return () => listeners.delete(fn);
  }, read);

  return [choice, setTheme];
}
