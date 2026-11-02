// One switch for every "your thinking" row of the transcript. Rows start open. A press on the global switch opens or
// closes all of them, and a row that was set by hand after that keeps its own state.
import { useSyncExternalStore } from "react";

let all = true;
let epoch = 0;
const own = new Map<string, { open: boolean; epoch: number }>();
const listeners = new Set<() => void>();
let snapshot = { all, epoch };

function emit(): void {
  snapshot = { all, epoch };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function setAllThinking(open: boolean): void {
  all = open;
  epoch++;
  emit();
}

export function toggleAllThinking(): void {
  setAllThinking(!all);
}

export function setOneThinking(id: string, open: boolean): void {
  own.set(id, { open, epoch });
  emit();
}

/** Whether a row is open: its own choice if it made one after the last global press, otherwise the global state. */
export function isThinkingOpen(id: string): boolean {
  const o = own.get(id);
  return o && o.epoch === epoch ? o.open : all;
}

export function useThinkingOpen(id: string): boolean {
  useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return isThinkingOpen(id);
}

export function useAllThinking(): boolean {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot).all;
}
