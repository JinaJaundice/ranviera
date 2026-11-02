// One Escape, one action, on the topmost layer. A layer (a menu, a card, a dialog) registers a handler while it is open,
// and a single listener on the document gives the key to the layer that opened last. The handler returns true when it
// used the key. A field that is being edited takes the key first, through its own handler.

type Handler = () => boolean | void;

const stack: Handler[] = [];
let listening = false;

function onKey(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]() !== false) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }
}

/** Registers a layer and returns the function that removes it. */
export function pushEscape(handler: Handler): () => void {
  stack.push(handler);
  if (!listening && typeof document !== "undefined") {
    document.addEventListener("keydown", onKey, true);
    listening = true;
  }
  return () => {
    const i = stack.indexOf(handler);
    if (i >= 0) stack.splice(i, 1);
  };
}

export function escapeDepth(): number {
  return stack.length;
}
