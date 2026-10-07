// Three theme states. Keep in step with the inline script in web/index.html, which resolves the theme before
// first paint.
export type ThemePref = "system" | "light" | "dark";
const KEY = "cortex:theme";

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "system" ? v : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // storage may be blocked; the theme still applies for this page
  }
  const dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  syncDesktopTitleBar();
}

interface DesktopBridge {
  setTitleBar: (colour: string, symbols: string) => void;
}

/** In the desktop app, give the Windows title bar buttons the colours of the current theme. */
export function syncDesktopTitleBar(): void {
  const bridge = (window as unknown as { cortexDesktop?: DesktopBridge }).cortexDesktop;
  if (!bridge) return;
  requestAnimationFrame(() => bridge.setTitleBar(token("--color-surface"), token("--color-ink-soft")));
}

/** Read a colour token from the live theme, eg token("--color-signal"). */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
