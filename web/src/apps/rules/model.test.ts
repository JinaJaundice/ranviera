import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@shared/types";
import { collectRules, fileList, indexEdges, matchesFilter, ruleStats, taskTree } from "./model";

const n = (id: string, type: string, props: Record<string, unknown> = {}, extra: Partial<GraphNode> = {}): GraphNode => ({
  id, type, label: id, family: "instruction", path: null, summary: null, date: null, status: null, sensitivity: "public",
  props, metrics: { uses: 1, last_used: null, base_level: null, degree: 0 }, ...extra,
});
const e = (s: string, r: string, t: string): GraphEdge => ({ s, r, t, w: 1, evidence: null });

const nodes = [
  n("task:deck", "TaskType"),
  n("rulefile:decks", "RuleFile"),
  n("claudemd:global", "MapFile"),
  n("section:decks-a", "Section"),
  n("section:decks-b", "Section"),
  n("rule:decks-1", "Rule", { text: "Use a template.", givenOn: "2026-09-01" }),
  n("rule:decks-2", "Rule", {}, { metrics: { uses: 0, last_used: null, base_level: null, degree: 0 } }),
  n("rule:decks-3", "Rule", { givenOn: "2026-09-02" }),
  n("tool:x", "Tool"),
];
const edges = [
  e("task:deck", "readsFirst", "rulefile:decks"),
  e("rulefile:decks", "contains", "section:decks-a"),
  e("section:decks-a", "contains", "section:decks-b"),
  e("section:decks-a", "contains", "rule:decks-1"),
  e("section:decks-b", "contains", "rule:decks-2"),
  e("rulefile:decks", "contains", "rule:decks-3"),
  e("rule:decks-1", "conflictsWith", "rule:decks-2"),
  e("rule:decks-3", "supersedes", "rule:decks-1"),
  e("rule:decks-3", "restates", "rule:decks-2"),
];
const byId = new Map(nodes.map((x) => [x.id, x]));
const index = indexEdges(edges);

describe("rules model", () => {
  it("lists instruction files only, map file first", () => {
    expect(fileList(nodes).map((x) => x.id)).toEqual(["claudemd:global", "rulefile:decks"]);
  });

  it("builds the task tree from readsFirst edges", () => {
    const t = taskTree(nodes, index, byId);
    expect(t).toHaveLength(1);
    expect(t[0].files.map((f) => f.id)).toEqual(["rulefile:decks"]);
  });

  it("collects the rules of a file through its nested sections", () => {
    expect(collectRules(index, byId, "rulefile:decks").map((r) => r.id).sort()).toEqual(["rule:decks-1", "rule:decks-2", "rule:decks-3"]);
    expect(collectRules(index, byId, "section:decks-b").map((r) => r.id)).toEqual(["rule:decks-2"]);
  });

  it("counts relations in either direction and flags the states", () => {
    const s2 = ruleStats(index, byId.get("rule:decks-2")!);
    expect(s2.conflicts).toBe(1);
    expect(s2.restates).toBe(1);
    expect(s2.undated).toBe(true);
    expect(s2.unused).toBe(true);
    const s1 = ruleStats(index, byId.get("rule:decks-1")!);
    expect(s1.superseded).toBe(true);
    expect(ruleStats(index, byId.get("rule:decks-3")!).supersedes).toBe(1);
  });

  it("applies each filter", () => {
    const stats = collectRules(index, byId, "rulefile:decks").map((r) => [r.id, ruleStats(index, r)] as const);
    const ids = (f: Parameters<typeof matchesFilter>[0]) => stats.filter(([, s]) => matchesFilter(f, s)).map(([id]) => id).sort();
    expect(ids("all")).toHaveLength(3);
    expect(ids("conflict")).toEqual(["rule:decks-1", "rule:decks-2"]);
    expect(ids("superseded")).toEqual(["rule:decks-1"]);
    expect(ids("undated")).toEqual(["rule:decks-2"]);
    expect(ids("unused")).toEqual(["rule:decks-2"]);
  });
});
