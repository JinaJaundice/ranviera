// Window state: pure functions over a WindowSet, a small store around them and persistence to localStorage.
import { useSyncExternalStore } from "react";
import { APP_BY_ID } from "../apps/registry";

export const DOCK_W = 52;
export const TOPBAR_H = 36;
export const MIN_VISIBLE = 40;
export const MIN_W = 320;
export const MIN_H = 200;
const CASCADE = 28;
const ORIGIN = { x: 96, y: 64 };
export const STORAGE_KEY = "cortex:windows";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  w: number;
  h: number;
}

export interface WinState extends Rect {
  app: string;
  z: number;
  minimised: boolean;
  maximised: boolean;
  params?: Record<string, string>;
}

export interface WindowSet {
  wins: WinState[];
  focused: string | null;
  nextZ: number;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const EMPTY: WindowSet = { wins: [], focused: null, nextZ: 1 };

/** Keep a window inside the viewport with at least MIN_VISIBLE px showing and the title bar below the top bar. */
export function clampRect(r: Rect, vp: Viewport): Rect {
  const w = Math.max(MIN_W, r.w);
  const h = Math.max(MIN_H, r.h);
  const x = Math.min(Math.max(r.x, MIN_VISIBLE - w), vp.w - MIN_VISIBLE);
  const y = Math.min(Math.max(r.y, TOPBAR_H), vp.h - MIN_VISIBLE);
  return { x, y, w, h };
}

/** The area a maximised window fills: right of the dock and under the top bar. */
export function maximisedRect(vp: Viewport): Rect {
  return { x: DOCK_W, y: TOPBAR_H, w: Math.max(MIN_W, vp.w - DOCK_W), h: Math.max(MIN_H, vp.h - TOPBAR_H) };
}

export function rectOf(win: WinState, vp: Viewport): Rect {
  return win.maximised ? maximisedRect(vp) : { x: win.x, y: win.y, w: win.w, h: win.h };
}

function raise(set: WindowSet, app: string): WindowSet {
  return {
    wins: set.wins.map((w) => (w.app === app ? { ...w, z: set.nextZ } : w)),
    focused: app,
    nextZ: set.nextZ + 1,
  };
}

/** Open an app. An open app is raised, restored from the dock and given the new params. */
export function openWindow(
  set: WindowSet,
  app: string,
  size: { w: number; h: number },
  vp: Viewport,
  params?: Record<string, string>,
): WindowSet {
  const existing = set.wins.find((w) => w.app === app);
  if (existing) {
    const next = { ...set, wins: set.wins.map((w) => (w.app === app ? { ...w, minimised: false, params: params ?? w.params } : w)) };
    return raise(next, app);
  }
  const step = set.wins.length % 8;
  // the Graph window opens docked to the right edge and at most 40 percent of the width, so that the brain stays in view beside it (docs/BRAIN.md)
  const docked = app === "graph" ? { w: Math.max(MIN_W, Math.min(size.w, Math.round(vp.w * 0.4))) } : null;
  const rect = docked
    ? clampRect({ x: vp.w - docked.w - 12, y: TOPBAR_H + 12, w: docked.w, h: Math.min(size.h, vp.h - TOPBAR_H - 24) }, vp)
    : clampRect({ x: ORIGIN.x + CASCADE * step, y: ORIGIN.y + CASCADE * step, w: size.w, h: size.h }, vp);
  const win: WinState = { app, ...rect, z: set.nextZ, minimised: false, maximised: false, params };
  return { wins: [...set.wins, win], focused: app, nextZ: set.nextZ + 1 };
}

export function focusWindow(set: WindowSet, app: string): WindowSet {
  if (!set.wins.some((w) => w.app === app)) return set;
  return raise({ ...set, wins: set.wins.map((w) => (w.app === app ? { ...w, minimised: false } : w)) }, app);
}

function topVisible(wins: WinState[]): string | null {
  const visible = wins.filter((w) => !w.minimised).sort((a, b) => b.z - a.z);
  return visible[0]?.app ?? null;
}

export function closeWindow(set: WindowSet, app: string): WindowSet {
  const wins = set.wins.filter((w) => w.app !== app);
  return { ...set, wins, focused: set.focused === app ? topVisible(wins) : set.focused };
}

export function minimiseWindow(set: WindowSet, app: string): WindowSet {
  const wins = set.wins.map((w) => (w.app === app ? { ...w, minimised: true } : w));
  return { ...set, wins, focused: set.focused === app ? topVisible(wins) : set.focused };
}

export function toggleMaximise(set: WindowSet, app: string): WindowSet {
  return raise({ ...set, wins: set.wins.map((w) => (w.app === app ? { ...w, maximised: !w.maximised } : w)) }, app);
}

export function setRect(set: WindowSet, app: string, rect: Rect, vp: Viewport): WindowSet {
  const c = clampRect(rect, vp);
  return { ...set, wins: set.wins.map((w) => (w.app === app ? { ...w, ...c } : w)) };
}

/** Re-clamp every window, used after the viewport changes or a saved layout loads. */
export function clampAll(set: WindowSet, vp: Viewport): WindowSet {
  return { ...set, wins: set.wins.map((w) => ({ ...w, ...clampRect(w, vp) })) };
}

export function serialise(set: WindowSet): string {
  return JSON.stringify({
    focused: set.focused,
    wins: set.wins.map(({ app, x, y, w, h, z, minimised, maximised }) => ({ app, x, y, w, h, z, minimised, maximised })),
  });
}

export function saveWindows(set: WindowSet, storage: KeyValueStorage): void {
  try {
    storage.setItem(STORAGE_KEY, serialise(set));
  } catch {
    // storage may be blocked or full, and the layout then lasts for this page only
  }
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function loadWindows(storage: KeyValueStorage, vp: Viewport, known: (app: string) => boolean): WindowSet {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const data = JSON.parse(raw) as { focused?: string | null; wins?: Partial<WinState>[] };
    const seen = new Set<string>();
    const wins: WinState[] = [];
    for (const w of data.wins ?? []) {
      if (typeof w.app !== "string" || !known(w.app) || seen.has(w.app)) continue;
      if (!num(w.x) || !num(w.y) || !num(w.w) || !num(w.h)) continue;
      seen.add(w.app);
      wins.push({
        app: w.app,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        z: num(w.z) ? w.z : wins.length + 1,
        minimised: w.minimised === true,
        maximised: w.maximised === true,
      });
    }
    const nextZ = wins.reduce((m, w) => Math.max(m, w.z), 0) + 1;
    const focused = wins.some((w) => w.app === data.focused && !w.minimised) ? (data.focused as string) : topVisible(wins);
    return clampAll({ wins, focused, nextZ }, vp);
  } catch {
    return EMPTY;
  }
}

// The live store

function viewport(): Viewport {
  return typeof window === "undefined" ? { w: 1280, h: 800 } : { w: window.innerWidth, h: window.innerHeight };
}

function safeStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let current: WindowSet = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const st = safeStorage();
  if (st) current = loadWindows(st, viewport(), (a) => APP_BY_ID.has(a));
}

function commit(next: WindowSet): void {
  if (next === current) return;
  current = next;
  const st = safeStorage();
  if (st) saveWindows(current, st);
  listeners.forEach((l) => l());
}

export const windowStore = {
  get(): WindowSet {
    ensureLoaded();
    return current;
  },
  open(app: string, params?: Record<string, string>): void {
    ensureLoaded();
    const def = APP_BY_ID.get(app);
    if (!def) return;
    commit(openWindow(current, app, def.size, viewport(), params));
  },
  focus: (app: string) => commit(focusWindow(windowStore.get(), app)),
  close: (app: string) => commit(closeWindow(windowStore.get(), app)),
  minimise: (app: string) => commit(minimiseWindow(windowStore.get(), app)),
  toggleMaximise: (app: string) => commit(toggleMaximise(windowStore.get(), app)),
  setRect: (app: string, rect: Rect) => commit(setRect(windowStore.get(), app, rect, viewport())),
  reclamp: () => commit(clampAll(windowStore.get(), viewport())),
};

export function useWindows(): WindowSet {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => windowStore.get(),
  );
}
