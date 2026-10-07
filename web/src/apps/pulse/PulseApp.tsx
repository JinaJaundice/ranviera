import { useEffect, useMemo, useState } from "react";
import { Bot, Bug, FileText, Hammer, MessageSquare, Puzzle, Wrench, Zap, type LucideIcon } from "lucide-react";
import type { CortexEvent, EventKind, GraphNode, RegisterDay } from "@shared/types";
import type { AppProps } from "../registry";
import { Empty } from "../../components/Empty";
import { NodeChip } from "../../components/NodeChip";
import { Section } from "../../components/Section";
import { Segmented } from "../../components/Segmented";
import { api } from "../../lib/api";
import { useStore } from "../../lib/store";
import { RegisterChart } from "./RegisterChart";

type Filter = "all" | "prompts" | "reads" | "agents" | "faults";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "prompts", label: "Prompts" },
  { value: "reads", label: "Reads" },
  { value: "agents", label: "Agents" },
  { value: "faults", label: "Faults" },
];

const KINDS: Record<Filter, EventKind[] | null> = {
  all: null,
  prompts: ["prompt"],
  reads: ["read", "instructions"],
  agents: ["agent.start", "agent.stop"],
  faults: ["fault"],
};

const KIND_ICON: Partial<Record<EventKind, LucideIcon>> = {
  prompt: MessageSquare,
  route: Zap,
  instructions: FileText,
  read: FileText,
  write: FileText,
  skill: Puzzle,
  "agent.start": Bot,
  "agent.stop": Bot,
  tool: Wrench,
  fault: Bug,
  compile: Hammer,
  check: Hammer,
};

const UNUSED_TYPES = new Set(["RuleFile", "ReferenceFile", "GuideFile", "Skill", "Agent"]);
const DAY = 86_400_000;

function sameDay(ts: string, now: Date): boolean {
  const d = new Date(ts);
  return !Number.isNaN(d.getTime()) && d.toDateString() === now.toDateString();
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 rounded-md border border-rule bg-raised px-3 py-2">
      <p className="num text-title text-ink">{value}</p>
      <p className="truncate text-small text-ink-soft">{label}</p>
    </div>
  );
}

function Feed({ events }: { events: CortexEvent[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const rows = useMemo(() => {
    const kinds = KINDS[filter];
    return events.filter((e) => !kinds || kinds.includes(e.kind)).slice(0, 100);
  }, [events, filter]);
  return (
    <Section title="Live feed" action={<Segmented label="Filter the feed" options={FILTERS} value={filter} onChange={setFilter} />}>
      {rows.length === 0 ? (
        <Empty>No events match this filter yet.</Empty>
      ) : (
        <ul className="divide-y divide-rule">
          {rows.map((e, i) => {
            const Icon = KIND_ICON[e.kind] ?? Zap;
            return (
              <li key={`${e.ts}-${e.key ?? i}-${e.kind}`} className="flex min-w-0 items-start gap-3 py-1.5">
                <span className="num w-16 shrink-0 text-small text-ink-faint">{new Date(e.ts).toLocaleTimeString("en-GB")}</span>
                <Icon size={14} className="mt-0.5 shrink-0 text-ink-soft" aria-label={e.kind} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-ink" title={e.label}>
                    {e.label}
                  </span>
                  {e.nodes.length > 0 ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {e.nodes.slice(0, 4).map((id) => (
                        <NodeChip key={id} id={id} />
                      ))}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function MostUsed({ nodes }: { nodes: GraphNode[] }) {
  const top = useMemo(
    () =>
      nodes
        .filter((n) => n.metrics.uses > 0)
        .sort((a, b) => b.metrics.uses - a.metrics.uses)
        .slice(0, 15),
    [nodes],
  );
  const max = top[0]?.metrics.uses ?? 1;
  return (
    <Section title="Most used in the last 30 days" note="Uses in the last 30 days, with the date of the latest use.">
      {top.length === 0 ? (
        <Empty>No node has been used yet.</Empty>
      ) : (
        <ol className="space-y-1.5">
          {top.map((n, i) => (
            <li key={n.id} className="grid min-w-0 grid-cols-[1.5rem_minmax(0,14rem)_minmax(0,1fr)_2.5rem_5rem] items-center gap-2">
              <span className="num text-small text-ink-faint">{i + 1}</span>
              <NodeChip id={n.id} />
              <div className="h-1.5 min-w-0 rounded-sm bg-sunken">
                <div className="h-1.5 rounded-sm bg-signal" style={{ width: `${Math.max(2, (n.metrics.uses / max) * 100)}%` }} />
              </div>
              <span className="num text-right text-small text-ink">{n.metrics.uses}</span>
              <span className="num text-right text-small text-ink-faint">{n.metrics.last_used?.slice(0, 10) ?? ""}</span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

function Unused({ nodes }: { nodes: GraphNode[] }) {
  const [now] = useState(() => Date.now());
  const stale = useMemo(() => {
    const cutoff = now - 60 * DAY;
    return nodes
      .filter((n) => UNUSED_TYPES.has(n.type))
      .filter((n) => {
        const t = n.metrics.last_used ? Date.parse(n.metrics.last_used) : NaN;
        return Number.isNaN(t) || t < cutoff;
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [nodes, now]);
  return (
    <Section title="Not used in 60 days" note="These instruction files, skills and agents are candidates for review, and nothing is deleted.">
      {stale.length === 0 ? (
        <Empty>Every instruction file, skill and agent was used in the last 60 days.</Empty>
      ) : (
        <>
          <p className="num mb-2 text-small text-ink-soft">{stale.length} nodes</p>
          <ul className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
            {stale.map((n) => (
              <li key={n.id} className="min-w-0 max-w-full">
                <NodeChip id={n.id} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

export function PulseApp(props: AppProps) {
  void props;
  const events = useStore((s) => s.events);
  const graph = useStore((s) => s.graph);
  const [days, setDays] = useState<RegisterDay[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .register(30)
      .then((r) => live && setDays(r.days))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const status = useStore((s) => s.status);
  const today = useMemo(() => {
    // The server counts today's events from the event file. The store holds only the last 500 events, so it is the
    // fallback when the server has not answered.
    const byKind = status?.events_today_by_kind;
    if (byKind && status) {
      const k = (...names: EventKind[]) => names.reduce((n, name) => n + (byKind[name] ?? 0), 0);
      return { events: status.events_today, prompts: k("prompt"), reads: k("read"), skills: k("skill"),
               agents: k("agent.start"), faults: k("fault") };
    }
    const now = new Date();
    const list = events.filter((e) => sameDay(e.ts, now));
    const count = (...k: EventKind[]) => list.filter((e) => k.includes(e.kind)).length;
    return {
      events: list.length,
      prompts: count("prompt"),
      reads: count("read"),
      skills: count("skill"),
      agents: count("agent.start"),
      faults: count("fault"),
    };
  }, [events, status]);

  const nodes = graph?.nodes ?? [];

  return (
    <div className="h-full min-w-0 overflow-y-auto">
      <div className="grid grid-cols-3 gap-2 border-b border-rule p-4 sm:grid-cols-6">
        <Counter label="Events today" value={today.events} />
        <Counter label="Prompts" value={today.prompts} />
        <Counter label="Files read" value={today.reads} />
        <Counter label="Skills" value={today.skills} />
        <Counter label="Agents" value={today.agents} />
        <Counter label="Register faults" value={today.faults} />
      </div>
      <Feed events={events} />
      <MostUsed nodes={nodes} />
      <Unused nodes={nodes} />
      <Section title="Register score" note="Register faults per reply for each of the last 30 days.">
        {failed ? <Empty>The register log could not be read.</Empty> : days === null ? <Empty>Loading the register log.</Empty> : <RegisterChart days={days} />}
      </Section>
    </div>
  );
}
