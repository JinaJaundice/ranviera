import { describe, expect, it } from "vitest";
import type { GraphNode } from "@shared/types";
import { REGION_CONTENTS, countByRegion, hottest } from "./regions";

const node = (id: string, type: string, heat: number, uses = 0, path: string | null = null): GraphNode =>
  ({
    id,
    type,
    label: id,
    family: "instruction",
    path,
    summary: null,
    date: null,
    status: null,
    sensitivity: "internal",
    props: {},
    metrics: { uses, last_used: null, base_level: null, degree: 0, heat },
  }) as GraphNode;

describe("region legend", () => {
  const nodes = [
    node("a", "Agent", 0.3),
    node("b", "Agent", 0.9),
    node("c", "RuleFile", 0.5, 0, "rules/writing.md"),
    node("d", "RuleFile", 0.4, 0, "rules/other.md"),
  ];

  it("counts the nodes of each of the 10 regions", () => {
    const counts = countByRegion(nodes);
    expect(Object.keys(counts)).toHaveLength(10);
    expect(Object.keys(REGION_CONTENTS)).toHaveLength(10);
    expect(counts.cerebellum).toBe(2);
    expect(counts.language).toBe(1);
    expect(counts.prefrontal).toBe(1);
  });

  it("lists the hottest nodes of a region first, at most 10", () => {
    expect(hottest(nodes, "cerebellum").map((n) => n.id)).toEqual(["b", "a"]);
    const many = Array.from({ length: 14 }, (_, i) => node(`n${i}`, "Agent", i / 20));
    const top = hottest(many, "cerebellum");
    expect(top).toHaveLength(10);
    expect(top[0].id).toBe("n13");
  });
});
