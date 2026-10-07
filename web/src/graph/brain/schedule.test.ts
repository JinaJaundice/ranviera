import { describe, expect, it } from "vitest";
import type { Activation } from "@shared/types";
import { HOP_DELAY_MS, MAX_NODE_LABELS, labelOrder, leadRegion, planStep, stepDuration } from "./schedule";
import { curvePoint, curveSegments } from "./curves";

const act: Activation[] = [
  { id: "a", a: 1, hop: 0, via: null },
  { id: "b", a: 0.6, hop: 1, via: "a" },
  { id: "c", a: 0.3, hop: 2, via: "b" },
  { id: "d", a: 0.6, hop: 1, via: "a" },
];

describe("planStep", () => {
  it("lights hop 0 at once, hop 1 after 250 ms and hop 2 after another 250 ms", () => {
    const plan = planStep(act, false);
    expect(plan.map((e) => e.at)).toEqual([0, HOP_DELAY_MS, 2 * HOP_DELAY_MS, HOP_DELAY_MS]);
    expect(HOP_DELAY_MS).toBe(250);
  });

  it("sends a pulse from the via node of each node after hop 0", () => {
    const plan = planStep(act, false);
    expect(plan.map((e) => e.pulse)).toEqual([false, true, true, true]);
  });

  it("lights every node at once and draws no pulse with reduced motion", () => {
    const plan = planStep(act, true);
    expect(plan.every((e) => e.at === 0 && !e.pulse)).toBe(true);
    expect(stepDuration(plan)).toBe(0);
  });

  it("gives a node of hop 1 without a via node no pulse", () => {
    expect(planStep([{ id: "x", a: 1, hop: 1, via: null }], false)[0].pulse).toBe(false);
  });
});

describe("labelOrder", () => {
  it("lists the nodes in the order of their activation, without repeats", () => {
    expect(labelOrder([...act, { id: "a", a: 1, hop: 0, via: null }])).toEqual(["a", "b", "d", "c"]);
  });

  it("stops at 14 labels", () => {
    const many: Activation[] = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, a: 1, hop: i % 3, via: null }));
    expect(labelOrder(many)).toHaveLength(MAX_NODE_LABELS);
    expect(MAX_NODE_LABELS).toBe(14);
  });
});

describe("leadRegion", () => {
  it("names the region with the most activation at the lowest hop", () => {
    const region = (id: string) => (id === "a" ? "thalamus" : "prefrontal");
    expect(leadRegion(act, region)).toBe("thalamus");
    expect(leadRegion([], region)).toBeNull();
  });
});

describe("curves", () => {
  const a = { x: 40, y: 30, z: 20 };
  const b = { x: -40, y: 30, z: 20 };

  it("starts and ends at the two nodes", () => {
    expect(curvePoint(a, b, 0)).toEqual(a);
    expect(curvePoint(a, b, 1)).toEqual(b);
  });

  it("bends towards the centre of the brain", () => {
    const mid = curvePoint(a, b, 0.5);
    expect(Math.hypot(mid.x, mid.y, mid.z)).toBeLessThan(Math.hypot(0, 30, 20));
  });

  it("writes 2 vertices for each segment", () => {
    const out = new Float32Array(6 * 10);
    expect(curveSegments(a, b, 10, out, 0)).toBe(60);
    expect(Array.from(out.slice(0, 3))).toEqual([40, 30, 20]);
    expect(Array.from(out.slice(57, 60))).toEqual([-40, 30, 20]);
  });
});
