import { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import { Bot, Hammer, Palette, Search } from "lucide-react";
import type { Family, GraphNode } from "@shared/types";
import { APPS } from "../apps/registry";
import { FAMILY_DOT } from "../components/family";
import { api } from "../lib/api";
import { bus } from "../lib/bus";
import { loadGraph, selectNode, useStore } from "../lib/store";
import { toast } from "./toastStore";
import { cycleTheme, THEMES } from "./useTheme";
import { windowStore } from "./windows";

type Row =
  | { kind: "action"; key: string; label: string; icon: typeof Search; run: () => void }
  | { kind: "node"; key: string; node: GraphNode };

const FAMILY_ORDER: Family[] = ["instruction", "machinery", "record", "work", "world", "language"];
const FAMILY_LABEL: Record<Family, string> = {
  instruction: "Instructions",
  machinery: "Machinery",
  record: "Records",
  work: "Work",
  world: "World",
  language: "Language",
};

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const graph = useStore((s) => s.graph);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);

  const fuse = useMemo(
    () =>
      new Fuse(graph?.nodes ?? [], {
        keys: [
          { name: "label", weight: 3 },
          { name: "id", weight: 1 },
          { name: "path", weight: 1 },
          { name: "summary", weight: 1 },
        ],
        threshold: 0.35,
        ignoreLocation: true,
      }),
    [graph],
  );

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    const lower = q.toLowerCase();
    const actions: Row[] = [];
    if (q) {
      actions.push({
        kind: "action",
        key: "mission",
        label: `Start a mission: ${q}`,
        icon: Bot,
        run: () => windowStore.open("missions", { prompt: q }),
      });
    }
    for (const app of APPS) {
      if (!lower || `open ${app.title}`.toLowerCase().includes(lower)) {
        actions.push({ kind: "action", key: `open-${app.id}`, label: `Open ${app.title}`, icon: app.icon, run: () => windowStore.open(app.id) });
      }
    }
    if (!lower || "rebuild the graph".includes(lower)) {
      actions.push({
        kind: "action",
        key: "rebuild",
        label: "Rebuild the graph",
        icon: Hammer,
        run: () => {
          toast("Rebuilding the graph.");
          api
            .compile()
            .then((r) => {
              toast(`The graph was rebuilt with ${r.stats.nodes} nodes and ${r.stats.edges} edges.`);
              void loadGraph();
            })
            .catch((e: unknown) => toast(`The graph could not be rebuilt. ${e instanceof Error ? e.message : ""}`.trim(), "error"));
        },
      });
    }
    if (!lower || "switch theme".includes(lower)) {
      actions.push({
        kind: "action",
        key: "theme",
        label: "Switch theme",
        icon: Palette,
        run: () => {
          const next = cycleTheme();
          toast(`The theme is now ${THEMES.find((t) => t.value === next)?.label.toLowerCase() ?? next}.`);
        },
      });
    }
    const found = q ? fuse.search(q, { limit: 12 }).map((r) => r.item) : [];
    const nodes: Row[] = [];
    for (const fam of FAMILY_ORDER) {
      for (const node of found) if (node.family === fam) nodes.push({ kind: "node", key: node.id, node });
    }
    return [...actions, ...nodes];
  }, [query, fuse]);

  const active = Math.min(index, Math.max(0, rows.length - 1));

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (row: Row | undefined) => {
    if (!row) return;
    onClose();
    if (row.kind === "action") row.run();
    else {
      selectNode(row.node.id);
      bus.emit("focus", { id: row.node.id });
      windowStore.open("graph", { node: row.node.id });
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(Math.min(rows.length - 1, active + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(Math.max(0, active - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(rows[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastFamily: Family | null = null;
  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center pt-24" onPointerDown={onClose}>
      <div
        role="dialog"
        aria-label="Command palette"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        className="flex max-h-[70vh] w-[640px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border border-rule-strong bg-overlay"
      >
        <div className="flex items-center gap-2 border-b border-rule px-3">
          <Search size={16} className="shrink-0 text-ink-faint" aria-hidden="true" />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-label="Search the graph or start a mission"
            placeholder="Search the graph or start a mission"
            className="h-11 min-w-0 flex-1 bg-transparent text-ui text-ink placeholder:text-ink-faint focus:outline-none"
          />
        </div>
        <div ref={list} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1">
          {rows.length === 0 ? <p className="px-3 py-6 text-center text-body text-ink-faint">Nothing in the graph matches that text.</p> : null}
          {rows.map((row, i) => {
            const header =
              row.kind === "node" && row.node.family !== lastFamily ? (
                <p key={`h-${row.node.family}`} className="px-3 pb-1 pt-2 text-caption font-medium text-ink-faint">
                  {FAMILY_LABEL[row.node.family]}
                </p>
              ) : null;
            if (row.kind === "node") lastFamily = row.node.family;
            const on = i === active;
            return (
              <div key={row.key}>
                {header}
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  data-index={i}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => run(row)}
                  className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-3 text-left text-body ${on ? "bg-raised text-ink" : "text-ink-soft"}`}
                >
                  {row.kind === "action" ? (
                    <>
                      <row.icon size={14} className="shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{row.label}</span>
                    </>
                  ) : (
                    <>
                      <span className={`h-2 w-2 shrink-0 rounded-full ${FAMILY_DOT[row.node.family]}`} aria-hidden="true" />
                      <span className="min-w-0 truncate text-ink">{row.node.label}</span>
                      <span className="shrink-0 text-caption text-ink-faint">{row.node.type}</span>
                      <span className="ml-auto min-w-0 truncate font-mono text-caption text-ink-faint">{row.node.id}</span>
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
