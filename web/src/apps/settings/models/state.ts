// What the Models and keys section knows: the catalogue, the keys, the settings, the
// Claude Code status and the custom endpoint. It is kept apart from web/src/lib/store.ts,
// which another package owns, and follows the pattern of apps/setup/state.ts.
import { useSyncExternalStore } from "react";
import type { ClaudeCodeStatus, CustomProviderState, LearnSettings, ModelCatalogResponse } from "@shared/learn/models";
import { learnModels, type KeysResponse } from "../../../lib/learn/models";

export interface ModelsStore {
  catalog: ModelCatalogResponse | null;
  keys: KeysResponse | null;
  settings: LearnSettings | null;
  claude: ClaudeCodeStatus | null;
  custom: { state: CustomProviderState; etag: string } | null;
  /** the sentence of the last failed read, or null */
  error: string | null;
  loading: boolean;
}

let state: ModelsStore = { catalog: null, keys: null, settings: null, claude: null, custom: null, error: null, loading: false };
const listeners = new Set<() => void>();

function set(patch: Partial<ModelsStore>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useModelsStore<T>(selector: (s: ModelsStore) => T): T {
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Reads everything again. The previous values stay on screen while the new ones load. */
export async function loadModels(): Promise<void> {
  set({ loading: true });
  try {
    const [catalog, keys, settings, claude, custom] = await Promise.all([learnModels.catalog(), learnModels.keys(), learnModels.settings(), learnModels.claudeCode(), learnModels.custom()]);
    set({ catalog, keys, settings, claude, custom, error: null, loading: false });
  } catch (e) {
    set({ error: message(e), loading: false });
  }
}

/** Reads the catalogue and the keys only, after a key changes. */
export async function reloadCatalogue(): Promise<void> {
  try {
    const [catalog, keys] = await Promise.all([learnModels.catalog(), learnModels.keys()]);
    set({ catalog, keys, error: null });
  } catch (e) {
    set({ error: message(e) });
  }
}

export function applySettings(settings: LearnSettings): void {
  set({ settings });
}

export function applyCustom(custom: { state: CustomProviderState; etag: string }): void {
  set({ custom });
}

export function applyClaude(claude: ClaudeCodeStatus): void {
  set({ claude });
}
