import { describe, expect, it } from "vitest";
import type { MappingRecord, TraceFinding } from "@shared/types";
import { ageLine } from "./model";
import { plainMessage, agentName, contextNotes, evidenceUpTo, longDate, outcomeWord, personName, plural, relationWord, ageDays, ageText, boundText, diffCounts, isProofNode, latestText, NO_BOUND, outsideBound, queueRows, scopeOf, unplacedFindings } from "./model";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const map = (id: string, owner: string, status: MappingRecord["status"], ts: string): MappingRecord => ({
  id, relation: "realises", s: "a", t: "b", status, basis: "", origin: "reviewer", owner, maker: "x", checker: null, valid_from: null, valid_to: null,
  anchors: { s_hash: null, t_hash: null }, reason: null, superseded_by: null, history: [{ ts, action: "propose", by: "x", note: null }],
});
const finding = (check: string, node: string): TraceFinding => ({ check, severity: "violation", node, message: "m", proof: null });

describe("the review queue", () => {
  it("lists proposed and stale mappings by owner, oldest first", () => {
    const rows = queueRows(
      [map("m1", "person:b", "proposed", "2026-10-06T00:00:00Z"), map("m2", "person:a", "proposed", "2026-10-01T00:00:00Z"), map("m3", "person:a", "proposed", "2026-09-20T00:00:00Z")],
      [map("m4", "person:a", "ratified", "2026-10-05T00:00:00Z"), map("m5", "person:a", "rejected", "2026-10-05T00:00:00Z")],
      NOW,
    );
    expect(rows.map((r) => `${r.mapping.id}:${r.kind}`)).toEqual(["m3:proposed", "m2:proposed", "m4:stale", "m1:proposed"]);
    expect(rows[0].days).toBe(17);
  });
  it("words an age", () => {
    expect(ageText(ageDays("2026-10-07T01:00:00Z", NOW))).toBe("Today");
    expect(ageText(1)).toBe("1 day");
    expect(ageLine("proposed", 20)).toBe("Proposed 20 days ago");
    expect(ageLine("stale", 1)).toBe("Ratified 1 day ago");
    expect(ageText(ageDays("nonsense", NOW))).toBe("Age not known");
  });
});

describe("findings and proofs", () => {
  it("lists a finding once, at its step", () => {
    const a = finding("O04", "adec:1");
    const b = finding("O12", "run:1");
    expect(unplacedFindings([a, b], [{ findings: [a] }, { findings: [] }])).toEqual([b]);
  });
  it("recognises the shape of a proof", () => {
    expect(isProofNode({ fact: "f", rule: "O04", children: [] })).toBe(true);
    expect(isProofNode({ fact: "f" })).toBe(false);
    expect(isProofNode(null)).toBe(false);
  });
});

describe("the instruction diff", () => {
  const lines = [
    { op: "same" as const, text: "one" },
    { op: "remove" as const, text: "two" },
    { op: "add" as const, text: "three" },
  ];
  it("counts changes and rebuilds the later text", () => {
    expect(diffCounts(lines)).toEqual({ added: 1, removed: 1 });
    expect(latestText(lines)).toBe("one\nthree");
  });
});

describe("the bounds of the bank", () => {
  it("says so where no bound is set", () => {
    expect(boundText(undefined, "")).toBe(NO_BOUND);
    expect(boundText({ min: null, max: null }, "")).toBe(NO_BOUND);
    expect(boundText({ min: 20, max: null }, " seconds")).toBe("at least 20 seconds");
    expect(boundText({ min: 5, max: 150 }, "")).toBe("at least 5 and at most 150");
  });
  it("finds a value outside a bound", () => {
    expect(outsideBound(500, { min: null, max: 150 })).toBe(true);
    expect(outsideBound(100, { min: null, max: 150 })).toBe(false);
    expect(outsideBound(null, { min: null, max: 150 })).toBe(false);
    expect(outsideBound(5, undefined)).toBe(false);
  });
});

describe("the scope of an evidence pack", () => {
  it("builds each scope and refuses an incomplete one", () => {
    expect(scopeOf("run", " run:alert-triage-r1 ", "", "")).toBe("run:run:alert-triage-r1");
    expect(scopeOf("agent", "dagent:x", "", "")).toBe("agent:dagent:x");
    expect(scopeOf("period", "", "2026-10-01", "2026-10-07")).toBe("period:2026-10-01..2026-10-07");
    expect(scopeOf("period", "", "2026-10-08", "2026-10-07")).toBeNull();
    expect(scopeOf("alert", "", "", "")).toBeNull();
    expect(scopeOf("alert", "-x", "", "")).toBeNull();
  });
});

describe("words for a reader", () => {
  it("words dates, counts, agents, outcomes and relations", () => {
    expect(longDate("2026-08-12")).toBe("12 August 2026");
    expect(plural(1, "version")).toBe("1 version");
    expect(plural(2, "version")).toBe("2 versions");
    expect(agentName("dagent:alert-triage")).toBe("Alert triage");
    expect(outcomeWord("request-information")).toBe("Information requested");
    expect(outcomeWord("close")).toBe("Closed");
    expect(relationWord("implementsClause")).toBe("implements the clause");
  });
  it("words a finding without relation names", () => {
    expect(plainMessage("has no ratified chain of satisfies, realises and implementsClause edges")).toBe("has no ratified chain of satisfies, realises and implements the clause links");
  });
  it("names a person from the people file", () => {
    const people = [{ id: "pell-ankarow", name: "Pell Ankarow" }];
    expect(personName(people, "pell-ankarow")).toBe("Pell Ankarow");
    expect(personName(people, "person:pell-ankarow")).toBe("Pell Ankarow");
    expect(personName(people, "role:mlro")).toBe("role:mlro");
  });
});

describe("instructions in context", () => {
  const i = (id: string) => ({ id, label: id });
  it("lists the first step in full and notes what changes", () => {
    const notes = contextNotes([
      { step: 0, in_context: [i("a"), i("b")] },
      { step: 1, in_context: [i("a"), i("b")] },
      { step: 2, in_context: [i("a"), i("c")] },
      { step: 3, in_context: [i("a"), i("c")] },
    ]);
    expect(notes.map((n) => `${n.kind}:${n.from}`)).toEqual(["full:0", "same:0", "changed:1", "same:2"]);
    expect(notes[2].added.map((x) => x.id)).toEqual(["c"]);
    expect(notes[2].removed.map((x) => x.id)).toEqual(["b"]);
  });
  it("collects the evidence up to the decision once", () => {
    const steps = [{ step: 1, evidence: [{ id: "e1" }] }, { step: 2, evidence: [{ id: "e1" }, { id: "e2" }] }, { step: 7, evidence: [{ id: "e3" }] }];
    expect(evidenceUpTo(steps, 6).map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});
