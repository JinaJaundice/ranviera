import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { api } from "../../lib/api";
import { useStore } from "../../lib/store";
import { focusNode } from "../../graph/nav";
import { Button } from "../../components/Button";
import { Empty } from "../../components/Empty";
import { NodeChip } from "../../components/NodeChip";
import { StatusDot, type Tone } from "../../components/StatusDot";
import { buildProjects, groupRows, type ProjectRow } from "./model";

const TONE: Record<string, Tone> = { active: "pass", parked: "hold", blocked: "block" };

function Row({ row }: { row: ProjectRow }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const { node } = row;
  const status = node.status ?? "No status";
  const openMemory = () => {
    if (row.memory?.path) api.open(row.memory.path).catch((e: unknown) => setError(e instanceof Error ? e.message : "The file could not be opened."));
  };

  return (
    <li className="min-w-0 border-b border-rule px-4 py-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          focusNode(node.id);
        }}
        className="flex w-full min-w-0 items-center gap-2 text-left"
      >
        {open ? <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-ink-faint" /> : <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-faint" />}
        <StatusDot tone={TONE[node.status ?? ""] ?? "idle"} label={status} />
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-ink">{node.label}</span>
        <span className="num shrink-0 text-small text-ink-soft">{row.last ?? "No recorded use"}</span>
        <span className="h-1.5 w-20 shrink-0 rounded-sm bg-rule" role="img" aria-label={`Heat ${Math.round(row.heat * 100)} out of 100`}>
          <span className="block h-full rounded-sm bg-signal" style={{ width: `${Math.round(row.heat * 100)}%` }} />
        </span>
      </button>

      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 pl-6">
        {row.clients.map((c) => (
          <NodeChip key={c.id} id={c.id} />
        ))}
        {row.apps.map((a) => (
          <NodeChip key={a.id} id={a.id} />
        ))}
        <span className="text-small text-ink-soft">
          <span className="num text-ink">{row.openItems}</span> open {row.openItems === 1 ? "item" : "items"}
        </span>
        {row.deliverable ? (
          <span className="min-w-0 truncate text-small text-ink-soft" title={row.deliverable.id}>
            Latest deliverable {row.deliverable.label}
            {row.deliverable.date ? <span className="num"> {row.deliverable.date}</span> : null}
          </span>
        ) : null}
        {row.memory?.path ? (
          <Button className="h-6 px-2 text-small" icon={<ExternalLink size={12} aria-hidden="true" />} onClick={openMemory} title={row.memory.path}>
            Open memory file
          </Button>
        ) : null}
      </div>
      {error ? <p className="mt-1 pl-6 text-small text-block">{error}</p> : null}

      {open ? (
        <div className="mt-2 min-w-0 pl-6">
          <p className="mb-1 text-small text-ink-soft">
            Linked nodes <span className="num text-ink-faint">{row.linked.length}</span>
          </p>
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {row.linked.map((l) => (
              <NodeChip key={l.id} id={l.id} />
            ))}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function ProjectsApp() {
  const graph = useStore((s) => s.graph);
  const byId = useStore((s) => s.byId);
  const groups = useMemo(() => (graph ? groupRows(buildProjects(graph.nodes, graph.edges, byId)) : []), [graph, byId]);

  if (!graph) return <Empty>Loading the graph.</Empty>;
  if (!groups.length) return <Empty>The graph holds no project.</Empty>;

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-surface text-ink">
      {groups.map((g) => (
        <section key={g.id} aria-label={g.label}>
          <h3 className="sticky top-0 flex items-baseline gap-2 border-b border-rule bg-surface px-4 py-2 text-small font-medium text-ink-faint">
            {g.label} <span className="num">{g.rows.length}</span>
          </h3>
          <ul>
            {g.rows.map((r) => (
              <Row key={r.node.id} row={r} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
