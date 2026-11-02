// The Learn window: a sessions sidebar and the session pane. It fetches again when the learning stream says that something
// changed (notify, then fetch). Below a container width of 720px the sidebar collapses behind a button in the session row.
import { useCallback, useState } from "react";
import type { AppProps } from "../registry";
import { learnSessions } from "../../lib/learn/sessions";
import { useFetched } from "../../lib/learn/useFetched";
import { useStore } from "../../lib/store";
import { DraftView } from "./DraftView";
import { SessionView } from "./SessionView";
import { Sidebar } from "./Sidebar";

export function LearnApp({ params }: AppProps) {
  const signals = useStore((s) => s.learnSignals);
  const list = useFetched(() => learnSessions.list(), "list", (signals["sessions-changed"] ?? 0) + (signals["turn-settled"] ?? 0) + (signals["turn-started"] ?? 0) + (signals["compaction-changed"] ?? 0));
  const [selected, setSelected] = useState<string | null>(params?.session ?? null);
  const [draft, setDraft] = useState<{ kind: "teach" | "practice"; nonce: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());

  const onRunning = useCallback((id: string, on: boolean) => {
    setRunning((prev) => {
      if (prev.has(id) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const sessions = list.data;
  const firstId = sessions && sessions.length ? sessions[0].id : null;
  const active = draft ? null : (selected ?? firstId);
  const showDraft = !!draft || (sessions !== null && active === null);

  const sidebar = (
    <Sidebar
      sessions={sessions}
      error={list.error}
      onRetry={list.reload}
      selected={active}
      running={running}
      onSelect={(id) => {
        setDraft(null);
        setSelected(id);
        setOpen(false);
      }}
      onNew={(kind) => {
        setDraft({ kind, nonce: Date.now() });
        setOpen(false);
      }}
      onChanged={list.reload}
      onDeleted={(id) => {
        if (selected === id || active === id) setSelected(null);
      }}
    />
  );

  return (
    <div className="@container relative h-full min-h-0 min-w-0 overflow-hidden">
      <div className="grid h-full min-h-0 min-w-0 grid-cols-1 @min-[720px]:grid-cols-[260px_minmax(0,1fr)]">
        <div className="hidden min-h-0 min-w-0 @min-[720px]:block">{sidebar}</div>
        <div className="min-h-0 min-w-0">
          {showDraft ? (
            <DraftView
              key={draft?.nonce ?? "first"}
              initialKind={draft?.kind ?? "teach"}
              onToggleSidebar={() => setOpen(true)}
              onCreated={(id) => {
                setDraft(null);
                setSelected(id);
                list.reload();
              }}
            />
          ) : active ? (
            <SessionView key={active} id={active} onChanged={list.reload} onToggleSidebar={() => setOpen(true)} onRunning={onRunning} renameSignal={0} />
          ) : (
            <p role="status" className="px-6 py-10 text-center text-body text-ink-faint">Loading sessions.</p>
          )}
        </div>
      </div>
      {open ? (
        <div className="absolute inset-0 z-20 flex @min-[720px]:hidden">
          <div className="h-full w-65 max-w-full bg-surface">{sidebar}</div>
          <button type="button" aria-label="Close the sessions" className="min-w-0 flex-1 bg-void/70" onClick={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
