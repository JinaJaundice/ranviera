import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphFile, GraphNode, IndexFile } from "../../shared/types.ts";
import { DEFAULT_PARAMS } from "./activation.ts";
import { buildView } from "./graph.ts";
import { plan } from "./plan.ts";

function node(id: string, type: string, label: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, type, label, family: "instruction", path: null, summary: null, date: null, status: null,
    sensitivity: "internal", props: {}, metrics: { uses: 0, last_used: null, base_level: null, degree: 0 }, ...extra,
  };
}

const edge = (s: string, r: string, t: string): GraphEdge => ({ s, r, t, w: 0.5, evidence: null });

const nodes = [
  node("task:deck", "TaskType", "Deck or slide"),
  node("task:reply", "TaskType", "Reply or short text"),
  node("rulefile:decks", "RuleFile", "decks", { path: "C:/h/rules/decks.md" }),
  node("agent:checker", "Agent", "checker"),
  node("gate:deck-family-qa", "Gate", "Deck family QA script", { props: { command: "python deck_qa.py <deck>" } }),
  node("gate:look", "Gate", "Look at every page image"),
  node("project:falcon", "Project", "Falcon walkthrough", { family: "work", sensitivity: "client-confidential" }),
  node("memory:falcon", "MemoryFile", "project_falcon", { family: "record", path: "C:/m/project_falcon.md" }),
];
const edges = [
  edge("task:deck", "readsFirst", "rulefile:decks"),
  edge("task:deck", "handledBy", "agent:checker"),
  edge("task:deck", "checkedBy", "gate:deck-family-qa"),
  edge("task:deck", "checkedBy", "gate:look"),
  edge("project:falcon", "documentedIn", "memory:falcon"),
];
const file = {
  v: 1, built: "2026-10-05T00:00:00Z", classes: [], relations: [], nodes, edges, schemes: [],
  source: { claude_home: "", projects_root: "", git: null, host: "" },
  health: { errors: 0, warnings: 0, infos: 0, checked: "" }, stats: { nodes: nodes.length, edges: edges.length, by_class: {} },
} as GraphFile;
const view = buildView(file, DEFAULT_PARAMS);
const index: IndexFile = {
  v: 1, built: "", paths: {}, prefixes: [], skills: {}, agents: {}, tools: {}, faults: {}, hooks: {}, always: [],
  routes: [{ id: "route:decks", patterns: ["\\bdeck\\b", "slides?"], fires: ["task:deck"] }],
  terms: [{ id: "term:falcon", pattern: "\\bFalcon\\b", fires: ["project:falcon"] }],
};

describe("plan", () => {
  it("gives task:deck for a deck prompt, loads the decks rule file and ends with a checker step", () => {
    const p = plan("Build a Deck of 10 slides", view, index);
    expect(p.task_types.map((t) => t.id)).toEqual(["task:deck"]);
    expect(p.task_types[0].matched).toEqual(["Deck", "slides"]);
    expect(p.load.map((l) => l.node)).toContain("rulefile:decks");
    expect(p.load[0].reason).toBe("Read first for Deck or slide");
    expect(p.steps[p.steps.length - 1].agent).toBe("checker");
    expect(p.gates).toEqual([
      { node: "gate:deck-family-qa", command: "python deck_qa.py <deck>" },
      { node: "gate:look", command: "Look at every page image" },
    ]);
    expect(p.cautions[p.cautions.length - 1]).toContain("switched off for missions");
    expect(p.fire[0].a).toBe(1);
  });

  it("falls back to task:reply and the main session when nothing matches", () => {
    const p = plan("hello there", view, index);
    expect(p.task_types.map((t) => t.id)).toEqual(["task:reply"]);
    expect(p.steps).toEqual([{ agent: "main", purpose: "Carry out the task in the main Claude Code session" }]);
  });

  it("loads the memory file of a named project and warns about client material", () => {
    const p = plan("Update the Falcon deck", view, index);
    expect(p.entities).toEqual([{ id: "term:falcon", label: "Falcon walkthrough", matched: "Falcon" }]);
    const mem = p.load.find((l) => l.node === "memory:falcon");
    expect(mem?.reason).toBe("Project record for Falcon walkthrough");
    expect(p.cautions[0]).toBe("This mission touches client-confidential material: Falcon walkthrough.");
  });

  it("adds the spread with the hop and the via node of each node", () => {
    const p = plan("Build a Deck of 10 slides", view, index);
    const start = p.spread?.find((x) => x.id === "task:deck");
    expect(start).toMatchObject({ hop: 0, via: null });
    const next = p.spread?.find((x) => x.id === "rulefile:decks");
    expect(next).toMatchObject({ hop: 1, via: "task:deck" });
  });
});
