// Pure helpers for the Rules window: the tree of task types and files, the rules inside a file or section, and the
// filters. Tested in model.test.ts.
import type { GraphEdge, GraphNode } from "@shared/types";

export interface EdgeIndex {
  out: Map<string, GraphEdge[]>;
  inn: Map<string, GraphEdge[]>;
}

export function indexEdges(edges: GraphEdge[]): EdgeIndex {
  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    (out.get(e.s) ?? out.set(e.s, []).get(e.s)!).push(e);
    (inn.get(e.t) ?? inn.set(e.t, []).get(e.t)!).push(e);
  }
  return { out, inn };
}

export const FILE_TYPES = ["MapFile", "RuleFile", "OutputStyle", "Skill", "ReferenceFile", "GuideFile"];

const FILE_ORDER = new Map(FILE_TYPES.map((t, i) => [t, i]));

/** Every instruction file, ordered by kind and then by label. */
export function fileList(nodes: GraphNode[]): GraphNode[] {
  return nodes
    .filter((n) => FILE_ORDER.has(n.type))
    .sort((a, b) => FILE_ORDER.get(a.type)! - FILE_ORDER.get(b.type)! || a.label.localeCompare(b.label));
}

export interface TaskBranch {
  task: GraphNode;
  files: GraphNode[];
}

/** Each task type with the files it reads first, taken from its readsFirst edges. */
export function taskTree(nodes: GraphNode[], index: EdgeIndex, byId: Map<string, GraphNode>): TaskBranch[] {
  return nodes
    .filter((n) => n.type === "TaskType")
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((task) => ({
      task,
      files: (index.out.get(task.id) ?? [])
        .filter((e) => e.r === "readsFirst")
        .map((e) => byId.get(e.t))
        .filter((n): n is GraphNode => !!n),
    }));
}

/** The direct children of a given type, through contains edges, in file order. */
export function children(index: EdgeIndex, byId: Map<string, GraphNode>, id: string, type: string): GraphNode[] {
  return (index.out.get(id) ?? [])
    .filter((e) => e.r === "contains")
    .map((e) => byId.get(e.t))
    .filter((n): n is GraphNode => !!n && n.type === type);
}

/** Every rule in a file or section, including the rules in the sections inside it. */
export function collectRules(index: EdgeIndex, byId: Map<string, GraphNode>, containerId: string): GraphNode[] {
  const seen = new Set<string>();
  const rules: GraphNode[] = [];
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const e of index.out.get(id) ?? []) {
      if (e.r !== "contains") continue;
      const n = byId.get(e.t);
      if (!n) continue;
      if (n.type === "Rule") rules.push(n);
      else if (n.type === "Section") walk(n.id);
    }
  };
  walk(containerId);
  return rules;
}

export interface RuleStats {
  restates: number;
  conflicts: number;
  supersedes: number;
  superseded: boolean;
  undated: boolean;
  unused: boolean;
}

function count(list: GraphEdge[] | undefined, rel: string): number {
  return (list ?? []).filter((e) => e.r === rel).length;
}

export function ruleStats(index: EdgeIndex, rule: GraphNode): RuleStats {
  const o = index.out.get(rule.id);
  const i = index.inn.get(rule.id);
  const given = rule.date ?? rule.props?.givenOn ?? rule.props?.given_on;
  return {
    restates: count(o, "restates") + count(i, "restates"),
    conflicts: count(o, "conflictsWith") + count(i, "conflictsWith"),
    supersedes: count(o, "supersedes"),
    superseded: count(i, "supersedes") > 0 || rule.status === "superseded" || rule.status === "retired",
    undated: !given,
    unused: (rule.metrics?.uses ?? 0) === 0,
  };
}

export type RuleFilter = "all" | "conflict" | "superseded" | "undated" | "unused";

export function matchesFilter(filter: RuleFilter, s: RuleStats): boolean {
  switch (filter) {
    case "conflict":
      return s.conflicts > 0;
    case "superseded":
      return s.superseded;
    case "undated":
      return s.undated;
    case "unused":
      return s.unused;
    default:
      return true;
  }
}

export function ruleText(rule: GraphNode): string {
  const t = rule.props?.text;
  return typeof t === "string" && t ? t : rule.label;
}
