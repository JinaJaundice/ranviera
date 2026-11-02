// The sessions sidebar: the two ways to begin, a search field, a filter by kind, and one row for each session with its state.
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Dumbbell, Loader2, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import type { SessionSummary } from "@shared/learn/sessions";
import { Button } from "../../components/Button";
import { Segmented } from "../../components/Segmented";
import { fuzzyFilter } from "../../lib/learn/fuzzy";
import { failureText } from "../../lib/learn/http";
import { filterByKind, learnSessions, sessionMeta, sessionPath, type DeletionMode, type KindFilter } from "../../lib/learn/sessions";
import { Dialog, ErrorLine, LoadLine } from "../sources/parts";
import { Menu } from "./parts";

const FIELD = "h-8 w-full min-w-0 rounded-md border border-rule-strong bg-sunken pl-8 pr-2 text-body text-ink placeholder:text-ink-faint";

export interface SidebarProps {
  sessions: SessionSummary[] | null;
  error: string | null;
  onRetry: () => void;
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: (kind: "teach" | "practice") => void;
  onChanged: () => void;
  onDeleted: (id: string) => void;
  running: ReadonlySet<string>;
}

const MODES: { value: DeletionMode; title: string; note: string }[] = [
  { value: "preserve-graph", title: "Keep the claims it produced", note: "The claims and arguments stay in the graph. Only the session goes." },
  { value: "delete-nodes", title: "Remove the claims that only this session supports", note: "Claims that another source also supports stay." },
];

function DeleteDialog({ session, onClose, onDone }: { session: SessionSummary; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<DeletionMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!mode) return;
    setBusy(true);
    setError(null);
    try {
      await learnSessions.remove(session.id, mode);
      onDone();
    } catch (e) {
      setError(failureText(e, "The session could not be deleted."));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Delete this session?"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button className="border-block text-block" disabled={!mode || busy} onClick={() => void run()}>
            {busy ? "Deleting" : "Delete the session"}
          </Button>
        </>
      }
    >
      <p className="min-w-0 break-words text-body text-ink">{session.title}</p>
      <p className="mt-1 text-small text-ink-soft">This cannot be undone. Choose what happens to the knowledge that the session produced.</p>
      <div role="radiogroup" aria-label="What happens to the knowledge" className="mt-3 space-y-1.5">
        {MODES.map((m) => (
          <label key={m.value} className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${mode === m.value ? "border-signal bg-signal-soft" : "border-rule-strong"}`}>
            <input type="radio" name="mode" className="mt-1 accent-signal" checked={mode === m.value} onChange={() => setMode(m.value)} />
            <span className="min-w-0">
              <span className="block text-body font-medium text-ink">{m.title}</span>
              <span className="block text-small text-ink-soft">{m.note}</span>
            </span>
          </label>
        ))}
      </div>
      {error ? <p role="alert" className="mt-3 break-words text-small text-block">{error}</p> : null}
    </Dialog>
  );
}

export function Sidebar({ sessions, error, onRetry, selected, onSelect, onNew, onChanged, onDeleted, running }: SidebarProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const shown = useMemo(() => fuzzyFilter(filterByKind(sessions ?? [], kind), query, (s) => [s.title]), [sessions, kind, query]);

  const commit = async (s: SessionSummary) => {
    const v = draft.trim();
    setRenaming(null);
    if (!v || v === s.title) return;
    try {
      await learnSessions.rename(s.id, v);
      onChanged();
    } catch (e) {
      setActionError(failureText(e, "The session could not be renamed."));
    }
  };

  const walk = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button[data-row]") ?? []);
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 && e.key === "ArrowUp") return;
    e.preventDefault();
    rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col border-r border-rule bg-sunken">
      <div className="flex shrink-0 flex-col gap-2 p-3">
        <Button variant="primary" className="w-full" icon={<Plus size={14} aria-hidden="true" />} onClick={() => onNew("teach")}>
          New session
        </Button>
        <Button className="w-full" icon={<Dumbbell size={14} aria-hidden="true" />} onClick={() => onNew("practice")}>
          Practice
        </Button>
        <label className="relative block">
          <span className="sr-only">Search sessions</span>
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input type="search" value={query} placeholder="Search sessions" className={FIELD} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); list.current?.querySelector<HTMLButtonElement>("button[data-row]")?.focus(); } }} />
        </label>
        <Segmented<KindFilter>
          label="Kind of session"
          value={kind}
          onChange={setKind}
          options={[
            { value: "teach", label: "Teaching" },
            { value: "all", label: "All" },
            { value: "practice", label: "Practice" },
          ]}
        />
      </div>
      {actionError ? <ErrorLine>{actionError}</ErrorLine> : null}
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" onKeyDown={walk}>
        {error && !sessions ? <ErrorLine onRetry={onRetry}>{`The sessions could not load. ${error}`}</ErrorLine> : null}
        {!sessions && !error ? <LoadLine what="sessions" /> : null}
        {sessions && sessions.length === 0 ? <p className="px-3 py-6 text-center text-body text-ink-soft">No sessions yet.</p> : null}
        {sessions && sessions.length > 0 && shown.length === 0 ? <p className="px-3 py-6 text-center text-body text-ink-soft">No sessions match.</p> : null}
        <ul className="space-y-0.5">
          {shown.map((s) => {
            const current = s.id === selected;
            const isRunning = s.busy || running.has(s.id);
            return (
              <li key={s.id} className={`group/row flex min-w-0 items-center rounded-md ${current ? "bg-raised" : "hover:bg-raised"}`} onContextMenu={(e) => { e.preventDefault(); e.currentTarget.querySelector<HTMLButtonElement>("[data-row-menu]")?.click(); }}>
                {renaming === s.id ? (
                  <input
                    autoFocus
                    aria-label="Session title"
                    value={draft}
                    className="m-1 h-8 min-w-0 flex-1 rounded-md border border-rule-strong bg-sunken px-2 text-body text-ink"
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => void commit(s)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") void commit(s);
                      else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenaming(null);
                      }
                    }}
                  />
                ) : (
                  <button type="button" data-row="" aria-current={current ? "true" : undefined} className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left" onClick={() => onSelect(s.id)}>
                    <span className="flex min-w-0 items-center gap-1.5 text-body text-ink">
                      {s.kind === "practice" ? <Dumbbell size={12} aria-label="Practice session" className="shrink-0 text-ink-soft" /> : null}
                      <span className="min-w-0 truncate">{s.title}</span>
                      {isRunning ? <Loader2 size={12} aria-label="A turn is running" className="shrink-0 animate-spin text-ink-soft" /> : null}
                    </span>
                    <span className="block truncate font-mono text-caption text-ink-soft">{sessionMeta(s, now)}</span>
                  </button>
                )}
                <Menu
                  label={`Actions for ${s.title}`}
                  align="right"
                  button={({ toggle, open }) => (
                    <button type="button" data-row-menu="" aria-label={`Actions for ${s.title}`} aria-expanded={open} className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-soft hover:text-ink" onClick={toggle}>
                      <MoreHorizontal size={14} aria-hidden="true" />
                    </button>
                  )}
                  items={[
                    { label: "Rename", icon: Pencil, onSelect: () => { setDraft(s.title); setRenaming(s.id); } },
                    { label: "Export as Markdown", icon: Download, onSelect: () => window.open(sessionPath.markdown(s.id), "_blank", "noopener") },
                    { label: "Delete", icon: Trash2, danger: true, onSelect: () => setDeleting(s) },
                  ]}
                />
              </li>
            );
          })}
        </ul>
      </div>
      {deleting ? (
        <DeleteDialog
          session={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            const id = deleting.id;
            setDeleting(null);
            onDeleted(id);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}
