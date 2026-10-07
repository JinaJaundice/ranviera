// Selecting a node from a window also moves the graph camera to it.
import { bus } from "../lib/bus";
import { selectNode } from "../lib/store";

export function focusNode(id: string): void {
  selectNode(id);
  bus.emit("focus", { id });
}
