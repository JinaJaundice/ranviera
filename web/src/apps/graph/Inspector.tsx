import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { CortexEvent, GraphNode, InferredFact, InferredRule } from "@shared/types";
import { FactRow } from "../query/ProofTree";
import { api } from "../../lib/api";
import { useStore } from "../../lib/store";
import { Button } from "../../components/Button";
import { Empty } from "../../components/Empty";
import { NodeChip } from "../../components/NodeChip";
import { FAMILY_DOT } from "../../components/family";
import { PROVENANCE_WORDS, groupRelations, propRows, weekBuckets } from "./inspect";

const SHOWN = 8;

function Dl({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)] gap-x-3 gap-y-1 text-body">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="min-w-0 text-ink-faint">{r.label}</dt>
          <dd className="min-w-0 break-words text-ink">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Heading({ children }: { children: string }) {
  return <h4 className="mb-1.5 text-small font-medium text-ink-faint">{children}</h4>;
}

function Relations({ node }: { node: GraphNode }) {
  const graph = useStore((s) => s.graph);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => (graph ? groupRelations(node.id, graph.edges, graph.relations) : []), [graph, node.id]);
  if (!groups.length) return <p className="text-body text-ink-faint">This node has no relations.</p>;
  return (
    <div className="space-y-3">
      {groups.map((g) => {
        const all = open[g.key] === true;
        const ids = all ? g.ids : g.ids.slice(0, SHOWN);
        return (
          <div key={g.key} className="min-w-0">
            <p className="mb-1 text-small text-ink-soft">
              {g.label} <span className="num text-ink-faint">{g.ids.length}</span>
            </p>
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {ids.map((id) => (
                <span key={id} className="inline-flex min-w-0 items-center gap-1">
                  <NodeChip id={id} />
                  {g.prov[id] ? (
                    <span className={`text-caption ${g.prov[id] === "proposed" ? "text-hold" : "text-ink-faint"}`}>{PROVENANCE_WORDS[g.prov[id]!]}</span>
                  ) : null}
                </span>
              ))}
              {g.ids.length > SHOWN ? (
                <Button variant="ghost" className="h-6 px-2 text-small" onClick={() => setOpen({ ...open, [g.key]: !all })}>
                  {all ? "Show fewer" : `Show all ${g.ids.length}`}
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Usage({ node }: { node: GraphNode }) {
  const [loaded, setLoaded] = useState<{ id: string; events: CortexEvent[] } | null>(null);
  const [now] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    api
      .node(node.id)
      .then((d) => live && setLoaded({ id: node.id, events: d.events }))
      .catch(() => live && setLoaded({ id: node.id, events: [] }));
    return () => {
      live = false;
    };
  }, [node.id]);
  const events = loaded && loaded.id === node.id ? loaded.events : null;

  const weeks = useMemo(() => weekBuckets(events ?? [], now, 12), [events, now]);
  const max = Math.max(1, ...weeks);
  const m = node.metrics;
  return (
    <div className="min-w-0">
      <Dl
        rows={[
          { label: "Uses", value: String(m.uses) },
          { label: "Last used", value: m.last_used ? m.last_used.slice(0, 10) : "Never" },
        ]}
      />
      <div className="mt-2 flex h-8 items-end gap-0.5" role="img" aria-label={`Events by week over the last 12 weeks, latest week ${weeks[weeks.length - 1]}`}>
        {weeks.map((n, i) => (
          <div
            key={i}
            title={`${n} events, ${12 - 1 - i} weeks ago`}
            className={`min-w-0 flex-1 rounded-sm ${n ? "bg-signal" : "bg-rule"}`}
            style={{ height: `${n ? Math.max(12, (n / max) * 100) : 6}%` }}
          />
        ))}
      </div>
      <p className="mt-1 text-caption text-ink-faint">
        {events === null ? "Loading events." : "Events by week, from the latest 50 events. The last bar is this week."}
      </p>
    </div>
  );
}

function Derived({ node }: { node: GraphNode }) {
  const [loaded, setLoaded] = useState<{ id: string; data: { rules: InferredRule[]; facts: InferredFact[] } | null } | null>(null);
  useEffect(() => {
    let live = true;
    api
      .inferred(node.id)
      .then((data) => live && setLoaded({ id: node.id, data }))
      .catch(() => live && setLoaded({ id: node.id, data: null }));
    return () => {
      live = false;
    };
  }, [node.id]);
  if (!loaded || loaded.id !== node.id) return <p className="text-body text-ink-faint">Loading the derived facts.</p>;
  if (!loaded.data) return <p className="text-body text-ink-faint">The derived facts could not be loaded.</p>;
  const { rules, facts } = loaded.data;
  if (!facts.length) return <p className="text-body text-ink-faint">The engine derived no facts about this node.</p>;
  return (
    <ul className="min-w-0">
      {facts.map((f) => (
        <FactRow key={f.key} fact={f} rules={rules} />
      ))}
    </ul>
  );
}

/** The inspector for one node. The disclosure has two levels: this panel, and the full lists inside it. */
export function Inspector({ id }: { id: string }) {
  const node = useStore((s) => s.byId.get(id));
  const classes = useStore((s) => s.graph?.classes);
  const [error, setError] = useState("");

  if (!node) return <Empty>The selected node is not in the graph that is shown.</Empty>;
  const cls = classes?.find((c) => c.id === node.type)?.label ?? node.type;
  const rows = propRows(node);
  const open = () => {
    if (node.path) api.open(node.path).catch((e: unknown) => setError(e instanceof Error ? e.message : "The file could not be opened."));
  };

  return (
    <div className="min-w-0 space-y-4 px-4 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-small text-ink-soft">
          <span className={`h-2.5 w-2.5 rounded-full ${FAMILY_DOT[node.family]}`} aria-hidden="true" />
          {cls}
        </p>
        <h2 className="mt-1 break-words font-display text-title text-ink">{node.label}</h2>
        <p className="addr">{node.id}</p>
        {node.path ? (
          <div className="mt-2 flex min-w-0 items-start justify-between gap-2">
            <p className="addr min-w-0">{node.path}</p>
            <Button className="shrink-0" icon={<ExternalLink size={14} aria-hidden="true" />} onClick={open}>
              Open
            </Button>
          </div>
        ) : null}
        {error ? <p className="mt-1 text-small text-block">{error}</p> : null}
      </div>

      {node.summary ? <p className="text-body text-ink-soft">{node.summary}</p> : null}

      <Dl
        rows={[
          { label: "Date", value: node.date ?? "Not stated" },
          { label: "Status", value: node.status ?? "Not stated" },
          { label: "Sensitivity", value: node.sensitivity },
        ]}
      />

      {rows.length ? (
        <div>
          <Heading>Properties</Heading>
          <Dl rows={rows} />
        </div>
      ) : null}

      <div>
        <Heading>Relations</Heading>
        <Relations node={node} />
      </div>

      <div>
        <Heading>Usage</Heading>
        <Usage node={node} />
      </div>

      <div>
        <Heading>Inferred about this node</Heading>
        <Derived node={node} />
      </div>
    </div>
  );
}
