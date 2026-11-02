import { describe, expect, it } from "vitest";
import { createPlanTree } from "./plan-tree.ts";
import { parsePlan, type ParseResult } from "./mermaid.ts";

const ok = (r: ParseResult) => {
  if (!r.ok) throw new Error(`expected success: ${JSON.stringify(r.problems)}`);
  return r.plan;
};
const bad = (r: ParseResult) => {
  if (r.ok) throw new Error("expected failure");
  return r.problems;
};

describe("the restricted diagram parser (B-8-28, B-8-30)", () => {
  it("accepts graph and flowchart headers in any case, comments and blank lines", () => {
    const plan = ok(
      parsePlan(`%% a comment\n\nFlowChart lr\n  %% another\n  a[First] --> b("Second")\n\n  b ==> c\n  c -.-> d;\n`),
    );
    expect(plan.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
    expect(plan.nodes.map((n) => n.title)).toEqual(["First", "Second", "c", "d"]);
    expect(plan.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
    ]);
  });

  it("reads a chain, hyphenated slugs next to arrows and a fenced block", () => {
    const plan = ok(parsePlan("```mermaid\ngraph TD\n  common-denominator --> add-fractions-->two_step\n```"));
    expect(plan.nodes.map((n) => n.id)).toEqual(["common-denominator", "add-fractions", "two_step"]);
    expect(plan.edges).toHaveLength(2);
  });

  it("falls back to the identifier as the title and lets the first label win", () => {
    const plan = ok(parsePlan('graph TD\n  a --> b\n  b["Bee"]\n  a["Ay"]'));
    expect(plan.nodes).toEqual([
      { id: "a", title: "Ay" },
      { id: "b", title: "Bee" },
    ]);
    const twice = ok(parsePlan('graph TD\n  a["Same"] --> b\n  a["Same"] --> c'));
    expect(twice.nodes[0].title).toBe("Same");
  });

  it("keeps brackets inside a quoted title", () => {
    const plan = ok(parsePlan('graph TD\n  a["f(x) [rate]"] --> b'));
    expect(plan.nodes[0].title).toBe("f(x) [rate]");
  });

  it("rejects a title that is empty or never closed", () => {
    expect(bad(parsePlan("graph TD\n  a[] --> b"))[0].message).toMatch(/empty/);
    expect(bad(parsePlan("graph TD\n  a[Open --> b"))[0].message).toMatch(/closing/);
  });

  it("reports every problem with its line number in one reply (B-8-28)", () => {
    const problems = bad(
      parsePlan(["graph TD", "  Bad_Id --> ok", "  subgraph One", "  x --> x", "  a --> b", "  a --> b", "  style a fill:red", "  p --> q --> ", "  end"].join("\n")),
    );
    const lines = problems.map((p) => p.line);
    expect(lines).toEqual([2, 3, 4, 6, 7, 8, 9]);
    expect(problems[0].message).toMatch(/slug/);
    expect(problems[1].message).toMatch(/Subgraphs/);
    expect(problems[2].message).toMatch(/itself/);
    expect(problems[3].message).toMatch(/twice/);
    expect(problems[4].message).toMatch(/Styles/);
  });

  it("refuses an upper case or spaced identifier", () => {
    expect(bad(parsePlan("graph TD\n  Photosynthesis --> light"))[0].message).toMatch(/not a valid slug/);
    expect(bad(parsePlan("graph TD\n  a b --> c"))[0].message).toMatch(/Unexpected text/);
  });

  it("refuses a cycle and names it", () => {
    const problems = bad(parsePlan("graph TD\n  a --> b\n  b --> c\n  c --> a"));
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toMatch(/cycle \(a to b to c to a\)/);
    expect(problems[0].line).toBe(4);
  });

  it("refuses a missing header, an empty block and an unsupported arrow", () => {
    expect(bad(parsePlan("a --> b"))[0].line).toBe(1);
    expect(bad(parsePlan(""))[0].message).toMatch(/empty/);
    expect(bad(parsePlan("graph TD\n  a --- b"))[0].message).toMatch(/arrow form/);
    expect(bad(parsePlan("graph TD\n  a -->|label| b"))[0].message).toMatch(/Edge labels/);
    expect(bad(parsePlan("graph TD\n  a & b --> c"))[0].message).toMatch(/&/);
  });

  it("refuses a node declared twice with different titles", () => {
    const problems = bad(parsePlan('graph TD\n  a["One"] --> b\n  a["Two"] --> c'));
    expect(problems[0].message).toMatch(/declared twice/);
    expect(problems[0].line).toBe(3);
  });

  it("allows a node name that is also a mermaid keyword when it takes part in an edge", () => {
    const plan = ok(parsePlan("graph TD\n  class --> end"));
    expect(plan.nodes.map((n) => n.id)).toEqual(["class", "end"]);
  });
});

describe("the plan tree (B-8-27)", () => {
  it("builds version 1 without changing its inputs", () => {
    const nodes = [{ id: "a", title: " A " }, { id: "b", title: "B" }];
    const edges = [{ from: "a", to: "b" }];
    const copy = JSON.stringify([nodes, edges]);
    const built = createPlanTree(nodes, edges);
    expect(built.ok && built.tree.version).toBe(1);
    expect(built.ok && built.tree.nodes[0].title).toBe("A");
    expect(JSON.stringify([nodes, edges])).toBe(copy);
  });

  it("refuses a duplicate id, an unknown node, a self loop, a duplicate edge and a cycle", () => {
    const n = (...ids: string[]) => ids.map((id) => ({ id, title: id }));
    const problems = (r: ReturnType<typeof createPlanTree>) => (r.ok ? [] : r.problems.join(" | "));
    expect(problems(createPlanTree(n("a", "a"), []))).toMatch(/used twice/);
    expect(problems(createPlanTree(n("a"), [{ from: "a", to: "zzz" }]))).toMatch(/not in the map/);
    expect(problems(createPlanTree(n("a"), [{ from: "a", to: "a" }]))).toMatch(/itself/);
    expect(problems(createPlanTree(n("a", "b"), [{ from: "a", to: "b" }, { from: "a", to: "b" }]))).toMatch(/twice/);
    expect(problems(createPlanTree(n("a", "b"), [{ from: "a", to: "b" }, { from: "b", to: "a" }]))).toMatch(/cycle/);
    expect(problems(createPlanTree([{ id: "Bad Id", title: "x" }], []))).toMatch(/slug/);
  });
});
