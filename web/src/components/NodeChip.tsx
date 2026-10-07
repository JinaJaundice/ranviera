import { bus } from "../lib/bus";
import { FAMILY_DOT } from "./family";
import { selectNode, useStore } from "../lib/store";

/** A node label with its family dot. Clicking selects the node and moves the graph camera to it. */
export function NodeChip({ id, label, className = "" }: { id: string; label?: string; className?: string }) {
  const node = useStore((s) => s.byId.get(id));
  const text = label ?? node?.label ?? id;
  return (
    <button
      type="button"
      title={`${node ? node.type : "Unknown node"}: ${id}`}
      onClick={() => {
        selectNode(id);
        bus.emit("focus", { id });
      }}
      onMouseEnter={() => bus.emit("highlight", { ids: [id] })}
      onMouseLeave={() => bus.emit("highlight", { ids: [] })}
      onFocus={() => bus.emit("highlight", { ids: [id] })}
      onBlur={() => bus.emit("highlight", { ids: [] })}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-md border border-rule bg-raised px-2 py-0.5 text-small text-ink hover:border-rule-strong ${className}`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${node ? FAMILY_DOT[node.family] : "bg-ink-faint"}`} aria-hidden="true" />
      <span className="min-w-0 truncate">{text}</span>
    </button>
  );
}
