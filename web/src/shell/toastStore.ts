// A small toast queue. Any window may call toast(); the Toasts component shows the queue.
import { useSyncExternalStore } from "react";

export interface ToastItem {
  id: number;
  text: string;
  kind: "info" | "error";
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

export function dismissToast(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Show a plain sentence. Information clears after 5 seconds and an error stays until it is dismissed. */
export function toast(text: string, kind: ToastItem["kind"] = "info"): void {
  const id = nextId++;
  items = [...items, { id, text, kind }].slice(-5);
  emit();
  if (kind === "info") setTimeout(() => dismissToast(id), 5000);
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => items,
  );
}
