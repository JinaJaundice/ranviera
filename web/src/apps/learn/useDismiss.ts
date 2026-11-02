import { useEffect, useRef } from "react";
import { pushEscape } from "../../lib/learn/escape";

/** Closes a popover on Escape and on a press outside its root. The root holds both the toggle and the panel. */
export function useDismiss(open: boolean, close: () => void, root: React.RefObject<HTMLElement | null>): void {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const off = pushEscape(() => {
      closeRef.current();
    });
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) closeRef.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      off();
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, root]);
}
