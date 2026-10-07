import { describe, expect, it } from "vitest";
import type { GraphNode } from "@shared/types";
import { anchorForce, countByFamily, familyAnchors, filterEdges, filterNodes, nodeRadius, rememberPositions, restorePosition, sizeClassOf, type AnchoredNode, type Vec3 } from "./layout";
import { FAMILIES } from "./palette";
import { makeGraph } from "./fixtures";

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe("family anchors", () => {
  it("places 6 anchors on a sphere of the given radius", () => {
    const anchors = familyAnchors(260);
    expect(Object.keys(anchors)).toHaveLength(6);
    for (const f of FAMILIES) expect(Math.hypot(anchors[f].x, anchors[f].y, anchors[f].z)).toBeCloseTo(260, 6);
  });

  it("keeps every pair of anchors apart by at least radius times root 2", () => {
    const anchors = familyAnchors(260);
    for (const a of FAMILIES) for (const b of FAMILIES) if (a !== b) expect(dist(anchors[a], anchors[b])).toBeGreaterThanOrEqual(260 * Math.SQRT2 - 1e-6);
  });

  it("pulls a node towards its own anchor and scales with alpha", () => {
    const anchors = familyAnchors(260);
    const force = anchorForce(anchors, 0.1);
    const n: AnchoredNode = { family: "instruction", x: 0, y: 0, z: 0 };
    force.initialize([n]);
    force(1);
    expect(n.vx).toBeCloseTo(26, 6);
    expect(n.vy).toBeCloseTo(0, 6);
    const m: AnchoredNode = { family: "instruction", x: 0, y: 0, z: 0 };
    force.initialize([m]);
    force(0.5);
    expect(m.vx).toBeCloseTo(13, 6);
  });
});

describe("filtering", () => {
  const graph = makeGraph(400, 800);
  const view = { families: { instruction: true, machinery: true, record: true, work: true, world: true, language: true }, cap: "client-confidential" as const };

  it("keeps all nodes at the widest cap", () => {
    expect(filterNodes(graph.nodes, view)).toHaveLength(graph.nodes.length);
  });

  it("drops a family that is switched off", () => {
    const shown = filterNodes(graph.nodes, { ...view, families: { ...view.families, language: false } });
    expect(shown.some((n) => n.family === "language")).toBe(false);
    expect(shown.length).toBeLessThan(graph.nodes.length);
  });

  it("applies the sensitivity cap in order", () => {
    const pub = filterNodes(graph.nodes, { ...view, cap: "public" });
    const internal = filterNodes(graph.nodes, { ...view, cap: "internal" });
    expect(pub.every((n) => n.sensitivity === "public")).toBe(true);
    expect(internal.every((n) => n.sensitivity !== "client-confidential")).toBe(true);
    expect(pub.length).toBeLessThanOrEqual(internal.length);
  });

  it("keeps only edges with both ends shown", () => {
    const shown = new Set(filterNodes(graph.nodes, { ...view, cap: "public" }).map((n) => n.id));
    const edges = filterEdges(graph.edges, shown);
    expect(edges.every((e) => shown.has(e.s) && shown.has(e.t))).toBe(true);
  });

  it("counts nodes by family", () => {
    const counts = countByFamily(graph.nodes);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(graph.nodes.length);
  });
});

describe("node size", () => {
  const make = (type: string, base: number | null, degree: number): GraphNode => ({
    id: `${type}:x`, type, label: "x", family: "instruction", path: null, summary: null, date: null, status: null,
    sensitivity: "public", props: {}, metrics: { uses: 0, last_used: null, base_level: base, degree },
  });

  it("never makes a rule larger than a file, for either size rule", () => {
    for (const by of ["heat", "degree"] as const) {
      const biggestRule = nodeRadius(make("Rule", 50, 5000), by);
      const smallestFile = nodeRadius(make("RuleFile", null, 0), by);
      expect(biggestRule).toBeLessThan(smallestFile);
    }
  });

  it("keeps task types, agents and projects visible at the minimum", () => {
    for (const t of ["TaskType", "Agent", "Project"]) expect(nodeRadius(make(t, null, 0), "heat")).toBeGreaterThanOrEqual(5);
  });

  it("gives a null base level the minimum size and grows with heat", () => {
    const cold = nodeRadius(make("Tool", null, 0), "heat");
    const hot = nodeRadius(make("Tool", 4, 0), "heat");
    expect(cold).toBe(sizeClassOf("Tool").floor);
    expect(hot).toBeGreaterThan(cold);
  });

  it("grows with degree when sized by links", () => {
    expect(nodeRadius(make("Tool", null, 100), "degree")).toBeGreaterThan(nodeRadius(make("Tool", null, 1), "degree"));
  });
});

describe("position memory", () => {
  it("restores a position by id", () => {
    const store = new Map<string, Vec3>();
    rememberPositions(store, [{ id: "a", x: 1, y: 2, z: 3 }, { id: "b" }]);
    const t: Partial<Vec3> = {};
    expect(restorePosition(store, "a", t)).toBe(true);
    expect(t).toEqual({ x: 1, y: 2, z: 3 });
    expect(restorePosition(store, "b", {})).toBe(false);
  });
});
