import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@shared/types";
import { buildProjects, groupOf, groupRows } from "./model";

const n = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id, type, label: id, family: "work", path: null, summary: null, date: null, status: null, sensitivity: "public", props: {},
  metrics: { uses: 0, last_used: null, base_level: null, degree: 0 }, ...extra,
});
const e = (s: string, r: string, t: string): GraphEdge => ({ s, r, t, w: 1, evidence: null });
const used = (last: string | null, base: number | null) => ({ uses: 1, last_used: last, base_level: base, degree: 0 });

const nodes = [
  n("project:falcon", "Project", { status: "active", metrics: used("2026-10-04T10:00:00Z", 2) }),
  n("project:old", "Project", { status: "archived", metrics: used("2026-01-01T10:00:00Z", -2) }),
  n("project:new", "Project", { status: "active", metrics: used("2026-10-05T10:00:00Z", 1) }),
  n("project:blank", "Project"),
  n("memory:falcon", "MemoryFile", { path: "C:/m/falcon.md" }),
  n("client:acme-bank", "Client"),
  n("app:northwind", "App"),
  n("backlog:falcon", "BacklogSection"),
  n("openitem:1", "OpenItem"),
  n("openitem:2", "OpenItem"),
  n("deliverable:a", "Deliverable", { date: "2026-09-01" }),
  n("deliverable:b", "Deliverable", { date: "2026-09-20" }),
];
const edges = [
  e("project:falcon", "documentedIn", "memory:falcon"),
  e("project:falcon", "documentedIn", "backlog:falcon"),
  e("project:falcon", "deliveredTo", "client:acme-bank"),
  e("memory:falcon", "mentions", "app:northwind"),
  e("openitem:1", "belongsTo", "backlog:falcon"),
  e("openitem:2", "belongsTo", "backlog:falcon"),
  e("deliverable:a", "belongsTo", "project:falcon"),
  e("deliverable:b", "belongsTo", "project:falcon"),
];
const byId = new Map(nodes.map((x) => [x.id, x]));

describe("projects model", () => {
  it("maps a status to its group", () => {
    expect(groupOf("blocked")).toBe("parked");
    expect(groupOf("archived")).toBe("superseded");
    expect(groupOf(null)).toBe("none");
  });

  it("finds clients, apps, open items, the latest deliverable and the memory file", () => {
    const row = buildProjects(nodes, edges, byId).find((r) => r.node.id === "project:falcon")!;
    expect(row.clients.map((c) => c.id)).toEqual(["client:acme-bank"]);
    expect(row.apps.map((c) => c.id)).toEqual(["app:northwind"]);
    expect(row.openItems).toBe(2);
    expect(row.deliverable?.id).toBe("deliverable:b");
    expect(row.memory?.id).toBe("memory:falcon");
    expect(row.last).toBe("2026-10-04");
    expect(row.heat).toBeGreaterThan(0.8);
  });

  it("groups in order and sorts by last activity with no activity last", () => {
    const groups = groupRows(buildProjects(nodes, edges, byId));
    expect(groups.map((g) => g.id)).toEqual(["active", "superseded", "none"]);
    expect(groups[0].rows.map((r) => r.node.id)).toEqual(["project:new", "project:falcon"]);
  });
});
