// Pure helpers for the Projects window. Tested in model.test.ts.
import type { GraphEdge, GraphNode } from "@shared/types";
import { heatOfNode } from "../../graph/palette";

export type GroupId = "active" | "maintained" | "parked" | "superseded" | "none";

export const GROUPS: { id: GroupId; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "maintained", label: "Maintained" },
  { id: "parked", label: "Parked or blocked" },
  { id: "superseded", label: "Superseded or archived" },
  { id: "none", label: "No status" },
];

export function groupOf(status: string | null): GroupId {
  switch (status) {
    case "active":
      return "active";
    case "maintained":
      return "maintained";
    case "parked":
    case "blocked":
      return "parked";
    case "superseded":
    case "archived":
    case "retired":
      return "superseded";
    default:
      return "none";
  }
}

export interface ProjectRow {
  node: GraphNode;
  group: GroupId;
  clients: GraphNode[];
  apps: GraphNode[];
  openItems: number;
  deliverable: GraphNode | null;
  memory: GraphNode | null;
  last: string | null;
  heat: number;
  linked: GraphNode[];
}

const LINK_RELS = new Set(["deliveredTo", "builtWith", "mentions"]);

function uniq(list: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  return list.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
}

/** One row for each Project node, with its linked clients, apps, open items, latest deliverable and memory file. */
export function buildProjects(nodes: GraphNode[], edges: GraphEdge[], byId: Map<string, GraphNode>): ProjectRow[] {
  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    (out.get(e.s) ?? out.set(e.s, []).get(e.s)!).push(e);
    (inn.get(e.t) ?? inn.set(e.t, []).get(e.t)!).push(e);
  }
  const get = (id: string) => byId.get(id);

  return nodes
    .filter((n) => n.type === "Project")
    .map((node) => {
      const o = out.get(node.id) ?? [];
      const i = inn.get(node.id) ?? [];
      const documented = o.filter((e) => e.r === "documentedIn").map((e) => get(e.t)).filter((n): n is GraphNode => !!n);
      const memory = documented.find((n) => n.type === "MemoryFile") ?? null;

      // clients and apps: from the project, and from its memory file, where mentions are harvested
      const sources = [node.id, ...(memory ? [memory.id] : [])];
      const linkedTo = sources
        .flatMap((s) => out.get(s) ?? [])
        .filter((e) => LINK_RELS.has(e.r))
        .map((e) => get(e.t))
        .filter((n): n is GraphNode => !!n && (n.type === "Client" || n.type === "App"));
      const clients = uniq(linkedTo.filter((n) => n.type === "Client"));
      const apps = uniq(linkedTo.filter((n) => n.type === "App"));

      // open items: those that belong to a backlog section of the project, or to the project itself
      const sections = new Set<string>();
      for (const n of documented) if (n.type === "BacklogSection") sections.add(n.id);
      for (const e of i) if (e.r === "belongsTo" && get(e.s)?.type === "BacklogSection") sections.add(e.s);
      const items = new Set<string>();
      for (const e of i) if (e.r === "belongsTo" && get(e.s)?.type === "OpenItem") items.add(e.s);
      for (const s of sections) for (const e of inn.get(s) ?? []) if (e.r === "belongsTo" && get(e.s)?.type === "OpenItem") items.add(e.s);

      const deliverable =
        i
          .filter((e) => e.r === "belongsTo")
          .map((e) => get(e.s))
          .filter((n): n is GraphNode => !!n && n.type === "Deliverable")
          .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))[0] ?? null;

      const linked = uniq([...o, ...i].map((e) => get(e.s === node.id ? e.t : e.s)).filter((n): n is GraphNode => !!n));

      return {
        node,
        group: groupOf(node.status),
        clients,
        apps,
        openItems: items.size,
        deliverable,
        memory,
        last: node.metrics.last_used ? node.metrics.last_used.slice(0, 10) : null,
        heat: heatOfNode(node),
        linked,
      };
    });
}

/** Most recent activity first, projects with no recorded activity last, then by label. */
export function sortByActivity(rows: ProjectRow[]): ProjectRow[] {
  return [...rows].sort((a, b) => (b.last ?? "").localeCompare(a.last ?? "") || a.node.label.localeCompare(b.node.label));
}

export function groupRows(rows: ProjectRow[]): { id: GroupId; label: string; rows: ProjectRow[] }[] {
  return GROUPS.map((g) => ({ ...g, rows: sortByActivity(rows.filter((r) => r.group === g.id)) })).filter((g) => g.rows.length > 0);
}
