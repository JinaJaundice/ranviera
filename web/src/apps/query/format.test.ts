import { describe, expect, it } from "vitest";
import type { InferredFact, InferredRule, SparqlResult } from "@shared/types";
import { cellView, factWords, groupByRule, negatedFact, parseFact, resultNodeIds, segmentsText } from "./format";

const isNode = (id: string) => id.includes(":");

describe("parseFact", () => {
  it("reads quoted and Nemo-style arguments, including commas inside quotes", () => {
    expect(parseFact('edge("a:1","restates","b:2")')).toEqual({ predicate: "edge", args: ["a:1", "restates", "b:2"] });
    expect(parseFact("edge(<a>, <restates>, <b>)")?.args).toEqual(["a", "restates", "b"]);
    expect(parseFact('status("x:1","on, hold")')?.args).toEqual(["x:1", "on, hold"]);
  });
  it("returns null for text that is not a fact", () => {
    expect(parseFact("given")).toBeNull();
  });
});

describe("factWords", () => {
  it("words an edge with node segments", () => {
    const s = factWords('edge("rule:a","restates","rule:b")', isNode);
    expect(s).toEqual([
      { kind: "node", id: "rule:a" },
      { kind: "text", text: " restates " },
      { kind: "node", id: "rule:b" },
    ]);
  });
  it("splits a camel-case relation into words", () => {
    expect(segmentsText(factWords('inferred("rule:a","supersedesChain","rule:b")', isNode))).toBe("rule:a supersedes chain rule:b");
  });
  it("words a violation and falls back to the predicate for an unknown fact", () => {
    expect(segmentsText(factWords('violation("R04","rule:x")', isNode))).toBe("rule:x breaks check R04");
    expect(segmentsText(factWords('idle("rule:x","40")', isNode))).toBe("idle of rule:x, 40");
  });
});

describe("cellView", () => {
  it("prefers the node, then the IRI, then the literal", () => {
    expect(cellView({ type: "uri", value: "urn:x", node: "rule:x" })).toEqual({ kind: "node", id: "rule:x", value: "urn:x" });
    expect(cellView({ type: "uri", value: "http://e/x" })).toEqual({ kind: "iri", value: "http://e/x" });
    expect(cellView({ type: "literal", value: "hello" })).toEqual({ kind: "literal", value: "hello" });
    expect(cellView(undefined)).toEqual({ kind: "literal", value: "" });
  });
  it("collects distinct node ids from a result", () => {
    const r: SparqlResult = {
      kind: "select", vars: ["a", "b"], truncated: false, ms: 1,
      rows: [
        { a: { type: "uri", value: "u1", node: "n:1" }, b: { type: "literal", value: "x" } },
        { a: { type: "uri", value: "u1", node: "n:1" }, b: { type: "uri", value: "u2", node: "n:2" } },
      ],
    };
    expect(resultNodeIds(r)).toEqual(["n:1", "n:2"]);
  });
});

describe("groupByRule", () => {
  const rules: InferredRule[] = [
    { id: "R01", kind: "inference", message: "m1", text: "" },
    { id: "R04", kind: "violation", message: "m4", text: "" },
    { id: "R06", kind: "warning", message: "m6", text: "" },
  ];
  const f = (rule: string, kind: string): InferredFact => ({ key: `${rule}-${Math.random()}`, rule, kind, args: [], proof: null });
  it("groups by rule and orders violations before warnings before inferences", () => {
    const g = groupByRule([f("R01", "inference"), f("R06", "warning"), f("R04", "violation"), f("R04", "violation")], rules);
    expect(g.map((x) => [x.id, x.facts.length])).toEqual([["R04", 2], ["R06", 1], ["R01", 1]]);
    expect(g[0].message).toBe("m4");
  });
  it("keeps a fact whose rule is not in the list", () => {
    const g = groupByRule([f("R99", "info")], rules);
    expect(g[0].rule).toBeNull();
    expect(g[0].kind).toBe("info");
  });
});

describe("negatedFact", () => {
  it("returns the fact inside a negated body atom and null otherwise", () => {
    expect(negatedFact('not edge("a:1","r","b:2")')).toBe('edge("a:1","r","b:2")');
    expect(negatedFact('not(edge("a:1","r","b:2"))')).toBe('edge("a:1","r","b:2")');
    expect(negatedFact('~edge("a:1","r","b:2")')).toBe('edge("a:1","r","b:2")');
    expect(negatedFact('edge("a:1","r","b:2")')).toBeNull();
    expect(negatedFact("not sure")).toBeNull();
  });
});
