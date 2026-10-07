import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode, RelationDef } from "@shared/types";
import { PROVENANCE_WORDS, advance, dayLabel, groupRelations, propRows, virtualAt, weekBuckets } from "./inspect";

const node = (type: string, props: Record<string, unknown>, extra: Partial<GraphNode> = {}): GraphNode => ({
  id: `${type.toLowerCase()}:x`, type, label: "Label", family: "instruction", path: null, summary: null, date: null,
  status: null, sensitivity: "public", props, metrics: { uses: 0, last_used: null, base_level: null, degree: 0 }, ...extra,
});

describe("propRows", () => {
  it("shows the full text, modal, date given and section of a rule, with Undated as the fallback", () => {
    const rows = propRows(node("Rule", { text: "Firms must test the tool.", modal: "must", section: "Checks" }));
    expect(rows).toEqual([
      { label: "Rule text", value: "Firms must test the tool." },
      { label: "Modal verb", value: "Must" },
      { label: "Date given", value: "Undated" },
      { label: "Section", value: "Checks" },
    ]);
  });

  it("shows the model, effort and tools of an agent", () => {
    const rows = propRows(node("Agent", { model: "sonnet", effort: "medium", tools: ["Read", "Edit"] }));
    expect(rows.map((r) => r.value)).toEqual(["sonnet", "medium", "Read, Edit"]);
  });

  it("shows the event, matcher and command of a hook", () => {
    const rows = propRows(node("Hook", { event: "Stop", command: "python hook.py stop" }));
    expect(rows.find((r) => r.label === "Matcher")?.value).toBe("Any");
    expect(rows.find((r) => r.label === "Command")?.value).toBe("python hook.py stop");
  });

  it("shows the forms and definition of a concept", () => {
    const rows = propRows(node("Concept", { prefLabel: "Falcon", altLabels: ["Falcon TM"], hiddenLabels: ["Kestrel"], definition: "The test tool." }));
    expect(rows.map((r) => r.label)).toEqual(["Preferred form", "Accepted forms", "Forms to avoid", "Definition"]);
  });
});

describe("groupRelations", () => {
  const relations: RelationDef[] = [
    { id: "contains", label: "contains", inverse_label: "is part of", weight: 0.6, reverse_weight: 0.35 },
    { id: "restates", label: "restates", inverse_label: "is restated by", weight: 0.6, reverse_weight: 0.6 },
  ];
  const edges: GraphEdge[] = [
    { s: "a", r: "contains", t: "b", w: 1, evidence: null },
    { s: "a", r: "contains", t: "c", w: 1, evidence: null },
    { s: "z", r: "contains", t: "a", w: 1, evidence: null },
    { s: "q", r: "restates", t: "a", w: 1, evidence: null },
    { s: "x", r: "contains", t: "y", w: 1, evidence: null },
  ];

  it("labels outgoing edges with the label and incoming edges with the inverse label", () => {
    const g = groupRelations("a", edges, relations);
    expect(g.find((x) => x.label === "contains")?.ids).toEqual(["b", "c"]);
    expect(g.find((x) => x.label === "is part of")?.ids).toEqual(["z"]);
    expect(g.find((x) => x.label === "is restated by")?.ids).toEqual(["q"]);
    expect(g).toHaveLength(3);
  });

  it("carries the provenance of each edge and prefers the better established source for a repeated pair", () => {
    const withProv: GraphEdge[] = [
      { s: "a", r: "restates", t: "b", w: 1, evidence: null, provenance: "proposed" },
      { s: "a", r: "restates", t: "b", w: 1, evidence: null, provenance: "stated" },
      { s: "a", r: "restates", t: "c", w: 1, evidence: null, provenance: "proposed" },
      { s: "a", r: "restates", t: "d", w: 1, evidence: null },
    ];
    const g = groupRelations("a", withProv, relations).find((x) => x.label === "restates")!;
    expect(g.prov).toEqual({ b: "stated", c: "proposed", d: undefined });
    expect(PROVENANCE_WORDS.proposed).toBe("not yet reviewed");
    expect(PROVENANCE_WORDS.inferred).toBe("derived by a rule");
  });
});

describe("weekBuckets", () => {
  it("counts events by week, oldest first, with the current week last", () => {
    const now = Date.parse("2026-10-05T12:00:00Z"); // a Monday
    const out = weekBuckets(
      [{ ts: "2026-10-05T01:00:00Z" }, { ts: "2026-10-04T23:00:00Z" }, { ts: "2026-09-28T09:00:00Z" }, { ts: "2025-01-01T00:00:00Z" }],
      now,
      4,
    );
    expect(out).toEqual([0, 0, 2, 1]);
  });
});

describe("replay clock", () => {
  it("runs one day in 4 seconds", () => {
    const start = Date.parse("2026-09-28T00:00:00Z");
    expect(virtualAt(start, 4000) - start).toBe(86_400_000);
    expect(dayLabel(start)).toBe("Mon 28 Sep 2026");
  });

  it("advances past the events that are due", () => {
    const items = [{ event: { ts: "2026-09-28T01:00:00Z" } }, { event: { ts: "2026-09-28T02:00:00Z" } }, { event: { ts: "2026-09-29T00:00:00Z" } }];
    expect(advance(items, 0, Date.parse("2026-09-28T03:00:00Z"))).toBe(2);
    expect(advance(items, 2, Date.parse("2026-09-30T00:00:00Z"))).toBe(3);
  });
});
