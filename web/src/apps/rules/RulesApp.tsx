import { InlineMd, MODAL_WORDS } from "../../components/InlineMd";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, ListChecks } from "lucide-react";
import type { GraphNode } from "@shared/types";
import { useStore } from "../../lib/store";
import { focusNode } from "../../graph/nav";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { Empty } from "../../components/Empty";
import { NodeChip } from "../../components/NodeChip";
import { Segmented } from "../../components/Segmented";
import { StatusDot } from "../../components/StatusDot";
import { groupRelations } from "../graph/inspect";
import {
  children,
  collectRules,
  fileList,
  indexEdges,
  matchesFilter,
  ruleStats,
  ruleText,
  taskTree,
  type EdgeIndex,
  type RuleFilter,
} from "./model";

const FILTERS: { value: RuleFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "conflict", label: "In conflict" },
  { value: "superseded", label: "Superseded" },
  { value: "undated", label: "Undated" },
  { value: "unused", label: "Not used" },
];

const PAGE = 150;

interface Ctx {
  index: EdgeIndex;
  byId: Map<string, GraphNode>;
  selected: string;
  choose: (id: string) => void;
}

const ROW = "flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left text-body hover:bg-raised";

function SectionBranch({ node, depth, ctx }: { node: GraphNode; depth: number; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const kids = children(ctx.index, ctx.byId, node.id, "Section");
  const on = ctx.selected === node.id;
  return (
    <li className="min-w-0">
      <div className={`${ROW} ${on ? "bg-raised text-ink" : "text-ink-soft"}`} style={{ paddingLeft: 6 + depth * 12 }}>
        {kids.length ? (
          <button type="button" aria-label={open ? "Hide sections" : "Show sections"} aria-expanded={open} onClick={() => setOpen(!open)} className="shrink-0">
            {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <button type="button" onClick={() => ctx.choose(node.id)} className="min-w-0 flex-1 truncate text-left" title={node.label}>
          {node.label}
        </button>
      </div>
      {open && kids.length ? (
        <ul>
          {kids.map((k) => (
            <SectionBranch key={k.id} node={k} depth={depth + 1} ctx={ctx} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function FileBranch({ node, depth, ctx }: { node: GraphNode; depth: number; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const kids = children(ctx.index, ctx.byId, node.id, "Section");
  const on = ctx.selected === node.id;
  return (
    <li className="min-w-0">
      <div className={`${ROW} ${on ? "bg-raised text-ink" : "text-ink"}`} style={{ paddingLeft: 6 + depth * 12 }}>
        {kids.length ? (
          <button type="button" aria-label={open ? "Hide sections" : "Show sections"} aria-expanded={open} onClick={() => setOpen(!open)} className="shrink-0">
            {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <FileText size={14} aria-hidden="true" className="shrink-0 text-ink-faint" />
        <button type="button" onClick={() => ctx.choose(node.id)} className="min-w-0 flex-1 truncate text-left" title={`${node.type}: ${node.label}`}>
          {node.label}
        </button>
      </div>
      {open && kids.length ? (
        <ul>
          {kids.map((k) => (
            <SectionBranch key={k.id} node={k} depth={depth + 1} ctx={ctx} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function TaskBranch({ task, files, ctx }: { task: GraphNode; files: GraphNode[]; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="min-w-0">
      <div className={`${ROW} text-ink`}>
        <button type="button" aria-label={open ? "Hide files" : "Show files"} aria-expanded={open} onClick={() => setOpen(!open)} className="shrink-0">
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        </button>
        <ListChecks size={14} aria-hidden="true" className="shrink-0 text-ink-faint" />
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            focusNode(task.id);
          }}
          className="min-w-0 flex-1 truncate text-left"
          title={task.id}
        >
          {task.label}
        </button>
        <span className="num text-caption text-ink-faint">{files.length}</span>
      </div>
      {open ? (
        <ul>
          {files.length ? files.map((f) => <FileBranch key={f.id} node={f} depth={1} ctx={ctx} />) : <li className="px-6 py-1 text-small text-ink-faint">No files are read first.</li>}
        </ul>
      ) : null}
    </li>
  );
}

function RuleRow({ rule, ctx }: { rule: GraphNode; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const graph = useStore((s) => s.graph);
  const s = ruleStats(ctx.index, rule);
  const given = rule.date ?? rule.props?.givenOn ?? rule.props?.given_on;
  const modal = typeof rule.props?.modal === "string" ? rule.props.modal : "";
  const groups = useMemo(
    () => (open && graph ? groupRelations(rule.id, graph.edges, graph.relations).filter((g) => g.label !== "contains" && g.label !== "is part of") : []),
    [open, graph, rule.id],
  );
  const uses = rule.metrics.uses;
  return (
    <li className="min-w-0 border-b border-rule px-3 py-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          focusNode(rule.id);
        }}
        className="block w-full min-w-0 text-left"
      >
        <span className={`block text-body text-ink ${open ? "" : "line-clamp-3"}`}><InlineMd text={ruleText(rule)} /></span>
        <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
          {modal ? <Chip>{MODAL_WORDS[modal] ?? modal}</Chip> : null}
          <Chip>{given ? String(given) : "Undated"}</Chip>
          {rule.status ? (
            <Chip>
              <StatusDot tone={s.superseded ? "hold" : "pass"} />
              {rule.status}
            </Chip>
          ) : null}
          {s.restates ? <Chip>restates {s.restates}</Chip> : null}
          {s.conflicts ? (
            <Chip>
              <StatusDot tone="block" />
              conflicts {s.conflicts}
            </Chip>
          ) : null}
          {s.supersedes ? <Chip>supersedes {s.supersedes}</Chip> : null}
          {s.superseded ? <Chip>superseded</Chip> : null}
          <Chip>{uses ? `used ${uses} times` : "not used"}</Chip>
          {rule.props?.kind === "note" ? <Chip>note, not an instruction</Chip> : null}
        </span>
      </button>
      {open ? (
        <div className="mt-2 min-w-0 space-y-2 pl-1">
          {groups.length ? (
            groups.map((g) => (
              <div key={g.key} className="min-w-0">
                <p className="mb-1 text-small text-ink-soft">
                  {g.label} <span className="num text-ink-faint">{g.ids.length}</span>
                </p>
                <div className="flex min-w-0 flex-wrap gap-1.5">
                  {g.ids.map((id) => (
                    <NodeChip key={id} id={id} />
                  ))}
                </div>
              </div>
            ))
          ) : (
            <p className="text-small text-ink-faint">This rule has no relations other than its place in the file.</p>
          )}
          <p className="addr">{rule.id}</p>
        </div>
      ) : null}
    </li>
  );
}

export function RulesApp() {
  const graph = useStore((s) => s.graph);
  const byId = useStore((s) => s.byId);
  const [chosen, setChosen] = useState<string | null>(null);
  const [filter, setFilter] = useState<RuleFilter>("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const index = useMemo(() => indexEdges(graph?.edges ?? []), [graph]);
  const files = useMemo(() => fileList(graph?.nodes ?? []), [graph]);
  const tasks = useMemo(() => taskTree(graph?.nodes ?? [], index, byId), [graph, index, byId]);

  const selected = chosen ?? files.find((f) => collectRules(index, byId, f.id).length > 0)?.id ?? "";
  const container = byId.get(selected);
  const ctx: Ctx = { index, byId, selected, choose: (id) => { setChosen(id); setLimit(PAGE); } };

  const all = useMemo(() => (selected ? collectRules(index, byId, selected) : []), [index, byId, selected]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((r) => matchesFilter(filter, ruleStats(index, r)) && (!needle || ruleText(r).toLowerCase().includes(needle)));
  }, [all, filter, q, index]);

  if (!graph) return <Empty>Loading the graph.</Empty>;

  return (
    <div className="grid h-full min-h-0 grid-cols-[300px_minmax(0,1fr)] bg-surface text-ink">
      <nav aria-label="Files and task types" className="min-h-0 min-w-0 overflow-y-auto border-r border-rule p-2">
        <h3 className="px-1.5 py-1 text-small font-medium text-ink-faint">By task</h3>
        <ul>
          {tasks.map((t) => (
            <TaskBranch key={t.task.id} task={t.task} files={t.files} ctx={ctx} />
          ))}
        </ul>
        <h3 className="mt-3 px-1.5 py-1 text-small font-medium text-ink-faint">All files</h3>
        <ul>
          {files.map((f) => (
            <FileBranch key={f.id} node={f} depth={0} ctx={ctx} />
          ))}
        </ul>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="min-w-0 space-y-2 border-b border-rule px-4 py-3">
          <div className="flex min-w-0 items-baseline justify-between gap-3">
            <h2 className="min-w-0 truncate text-ui font-medium text-ink">{container ? container.label : "Rules"}</h2>
            <span className="num shrink-0 text-small text-ink-soft">
              {rows.length} of {all.length} rules
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Segmented label="Filter the rules" options={FILTERS} value={filter} onChange={(v) => { setFilter(v); setLimit(PAGE); }} />
            <input
              type="search"
              aria-label="Search the text of the rules"
              placeholder="Search rule text"
              value={q}
              onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }}
              className="h-8 min-w-0 flex-1 rounded-md border border-rule-strong bg-sunken px-2 text-body text-ink placeholder:text-ink-faint"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.length ? (
            <>
              <ul>
                {rows.slice(0, limit).map((r) => (
                  <RuleRow key={r.id} rule={r} ctx={ctx} />
                ))}
              </ul>
              {rows.length > limit ? (
                <div className="p-3">
                  <Button onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, rows.length - limit)} more</Button>
                </div>
              ) : null}
            </>
          ) : (
            <Empty>{all.length ? "No rule matches the filter." : "This file or section holds no rules directly. Choose a section in the list."}</Empty>
          )}
        </div>
      </div>
    </div>
  );
}
