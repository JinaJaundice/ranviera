import { useSyncExternalStore } from "react";
import { applyTheme, getThemePref, type ThemePref } from "../lib/theme";

let pref: ThemePref = getThemePref();
const listeners = new Set<() => void>();

export const THEMES: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function setTheme(next: ThemePref): void {
  pref = next;
  applyTheme(next);
  listeners.forEach((l) => l());
}

/** Move to the next of System, Light and Dark. */
export function cycleTheme(): ThemePref {
  const i = THEMES.findIndex((t) => t.value === pref);
  const next = THEMES[(i + 1) % THEMES.length].value;
  setTheme(next);
  return next;
}

export function useTheme(): ThemePref {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pref,
  );
}
