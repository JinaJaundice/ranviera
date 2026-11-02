// The chain table: sources, then the arguments that were first read from each, then the statements. It covers the canvas inside
// the Graph window, is opaque, and has its own 32px toolbar. The keys follow the source tree (lib/learn/nav.ts).
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, FileText, MessageSquare, Search, X } from "lucide-react";
import type { GraphSnapshot } from "@shared/learn/knowledge";
import { IconButton } from "../../components/IconButton";
import { pushEscape } from "../../lib/learn/escape";
import { ensureFocus, moveFocus, type NavKey } from "../../lib/learn/nav";
import { DEFAULT_SORT, buildChainTable, filterSources, sortSources, tableCounts, visibleRows, type Sort, type SortKey, type TableRow } from "./chains";

const COLS = "grid-cols-[minmax(0,1fr)_64px] @md:grid-cols-[minmax(0,1fr)_96px_150px]";

function dayWord(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Not recorded" : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function Header({ sort, onSort }: { sort: Sort; onSort: (k: SortKey) => void }) {
  const col = (key: SortKey, label: string, cls = "") => {
    const on = sort.key === key;
    return (
      <div role="columnheader" aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={cls}>
        <button type="button" onClick={() => onSort(key)} className="inline-flex h-8 items-center gap-1 text-small font-medium text-ink-soft hover:text-ink">
          {label}
          {on ? sort.dir === "asc" ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" /> : null}
        </button>
      </div>
    );
  };
  return (
    <div role="row" className={`grid shrink-0 ${COLS} items-center gap-2 border-b border-rule bg-raised px-3`}>
      {col("name", "Name")}
      {col("propositions", "Claims", "text-right")}
      {col("created", "Created", "hidden text-right @md:block")}
    </div>
  );
}

export function ChainTable({ snap, onClose, onPickClaim }: { snap: GraphSnapshot; onClose: () => void; onPickClaim: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const tree = useRef<HTMLDivElement>(null);

  useEffect(() => pushEscape(() => onClose()), [onClose]);
  const sources = useMemo(() => buildChainTable(snap), [snap]);
  const searching = query.trim() !== "";
  const shown = useMemo(() => sortSources(filterSources(sources, query), sort), [sources, query, sort]);
  const rows = useMemo(() => visibleRows(shown, opened, closed, searching), [shown, opened, closed, searching]);
  const counts = tableCounts(snap);
  const active = ensureFocus(rows, focus);

  useEffect(() => {
    if (active) document.getElementById(`ct-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const setOpen = (id: string, open: boolean, level: number) => {
    if (searching && level === 1) {
      const next = new Set(closed);
      if (open) next.delete(id);
      else next.add(id);
      setClosed(next);
      return;
    }
    const next = new Set(opened);
    if (open) next.add(id);
    else next.delete(id);
    setOpened(next);
  };
  const activate = (r: TableRow) => {
    setFocus(r.id);
    if (r.statement) onPickClaim(r.statement.id);
    else if (r.hasChildren) setOpen(r.id, !r.open, r.level);
  };
  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const r = moveFocus(rows, active, e.key as NavKey);
      if (r.toggle) {
        const row = rows.find((x) => x.id === r.toggle?.id);
        if (row) setOpen(row.id, r.toggle.open, row.level);
      }
      setFocus(r.focus);
    } else if (e.key === "Enter" || e.key === " ") {
      const row = rows.find((x) => x.id === active);
      if (row) {
        e.preventDefault();
        activate(row);
      }
    }
  };

  return (
    <div
      className="@container absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col bg-surface"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          search.current?.focus();
          search.current?.select();
        }
      }}
    >
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-rule px-3">
        <p className="num min-w-0 shrink-0 text-small text-ink-soft">{`${counts.chains} ${counts.chains === 1 ? "chain" : "chains"}, ${counts.claims} ${counts.claims === 1 ? "claim" : "claims"}`}</p>
        <div className="relative ml-auto w-56 min-w-0 shrink">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2 top-1.5 text-ink-faint" />
          <input
            ref={search}
            type="search"
            aria-label="Search claims"
            placeholder="Search claims"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setFocus(ensureFocus(rows, null));
                tree.current?.focus();
              }
            }}
            className="h-6 w-full min-w-0 rounded-md border border-rule-strong bg-sunken pl-7 pr-2 text-small text-ink placeholder:text-ink-faint"
          />
        </div>
        <IconButton icon={X} label="Close the chain table" onClick={onClose} className="h-6 w-6" size={14} />
      </div>
      <Header sort={sort} onSort={onSort} />
      <div
        ref={tree}
        role="tree"
        tabIndex={0}
        aria-label="Sources, chains and claims"
        aria-activedescendant={active ? `ct-${active}` : undefined}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-body text-ink-faint">
            {sources.length === 0 ? "No chains yet. Extract a linked file or finish a lesson to add claims." : "No matching claims."}
          </p>
        ) : (
          rows.map((r) => <Row key={r.id} row={r} active={r.id === active} onActivate={() => activate(r)} />)
        )}
      </div>
    </div>
  );
}

function Row({ row: r, active, onActivate }: { row: TableRow; active: boolean; onActivate: () => void }) {
  const indent = { paddingLeft: 12 + (r.level - 1) * 20 };
  const base = `grid ${COLS} cursor-pointer items-center gap-2 border-b border-rule pr-3 ${active ? "bg-raised" : "hover:bg-raised"}`;
  const chev = r.hasChildren ? r.open ? <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-ink-faint" /> : <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-faint" /> : <span className="w-3.5 shrink-0" />;
  if (r.statement) {
    return (
      <div id={`ct-${r.id}`} role="treeitem" aria-level={3} aria-selected={active} onClick={onActivate} style={indent} className={`${base} py-1.5`}>
        <p className="min-w-0 break-words text-body text-ink-soft">
          <span className="text-ink">{r.statement.name}</span>
          {`. ${r.statement.statement}`}
        </p>
        <span />
      </div>
    );
  }
  if (r.chain) {
    const c = r.chain;
    return (
      <div id={`ct-${r.id}`} role="treeitem" aria-level={2} aria-expanded={r.open} aria-selected={active} aria-label={c.spoken} onClick={onActivate} style={indent} className={`${base} min-h-8 py-1`}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          {chev}
          {c.premises.map((p, i) => (
            <span key={p.id} className="flex items-center gap-1.5">
              {i > 0 ? <span aria-hidden="true" className="font-mono text-small text-ink-soft">∧</span> : null}
              <span className="max-w-[14rem] truncate rounded-md border border-rule-strong px-1.5 py-0.5 text-small text-ink" title={p.statement}>
                {p.name}
              </span>
            </span>
          ))}
          {c.premises.length ? <span aria-hidden="true" className="font-mono text-small text-ink-soft">⟹</span> : null}
          <span className="max-w-[14rem] truncate rounded-md border border-rule-strong px-1.5 py-0.5 text-small text-ink" title={c.conclusion.statement}>
            {c.conclusion.name}
          </span>
        </div>
        <span className="num text-right text-small text-ink-soft">{c.statements.length}</span>
        <span className="hidden text-right text-small text-ink-soft @md:block">{dayWord(c.createdAt)}</span>
      </div>
    );
  }
  const s = r.source!;
  return (
    <div id={`ct-${r.id}`} role="treeitem" aria-level={1} aria-expanded={r.hasChildren ? r.open : undefined} aria-selected={active} onClick={onActivate} style={indent} className={`${base} min-h-8 py-1`}>
      <div className="flex min-w-0 items-center gap-1.5">
        {chev}
        {s.kind === "session" ? <MessageSquare size={14} aria-hidden="true" className="shrink-0 text-ink-faint" /> : <FileText size={14} aria-hidden="true" className="shrink-0 text-ink-faint" />}
        <span className="min-w-0 truncate text-body font-medium text-ink" title={s.label}>
          {s.label}
        </span>
      </div>
      <span className="num text-right text-small text-ink-soft">{s.propositions}</span>
      <span className="hidden text-right text-small text-ink-soft @md:block">{dayWord(s.createdAt)}</span>
    </div>
  );
}

