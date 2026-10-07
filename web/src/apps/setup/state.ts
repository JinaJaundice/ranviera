// The set-up, hooks and Claude Code state, shared by the first run, Settings, About, the top bar and Missions.
// It is kept apart from web/src/lib/store.ts, which another package owns.
import { useSyncExternalStore } from "react";
import type { ClaudeState, HooksState, SetupState } from "@shared/types";
import { api } from "../../lib/api";
import { needsFirstRun, startStep } from "./model";

export interface SetupStore {
  setup: SetupState | null;
  setupError: string | null;
  claude: ClaudeState | null;
  hooks: HooksState | null;
  /** true when the first run window is on screen */
  firstRunOpen: boolean;
  firstRunStep: number;
}

let state: SetupStore = { setup: null, setupError: null, claude: null, hooks: null, firstRunOpen: false, firstRunStep: 0 };
const listeners = new Set<() => void>();

function set(patch: Partial<SetupStore>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useSetupStore<T>(selector: (s: SetupStore) => T): T {
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Read the set-up state. The first run opens once, when the person has not yet agreed to the welcome step. */
export async function refreshSetup(): Promise<SetupState | null> {
  try {
    const setup = await api.setup();
    applySetup(setup);
    set({ setupError: null });
    return setup;
  } catch (e) {
    set({ setupError: message(e) });
    return null;
  }
}

export function applySetup(setup: SetupState): void {
  const open = !state.firstRunOpen && needsFirstRun(setup);
  set({ setup, ...(open ? { firstRunOpen: true, firstRunStep: startStep(setup) } : {}) });
}

export async function refreshClaude(): Promise<ClaudeState | null> {
  try {
    const claude = await api.claude();
    set({ claude });
    return claude;
  } catch {
    return null;
  }
}

export async function refreshHooks(): Promise<HooksState | null> {
  try {
    const hooks = await api.hooks();
    set({ hooks });
    return hooks;
  } catch {
    return null;
  }
}

export function openFirstRun(step = 0): void {
  set({ firstRunOpen: true, firstRunStep: step });
}

export function closeFirstRun(): void {
  set({ firstRunOpen: false });
}

export function setFirstRunStep(step: number): void {
  set({ firstRunStep: step });
}
