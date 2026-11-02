import { describe, expect, it } from "vitest";
import { MIN_H, MIN_W, MAX_ZOOM, fitView, fitZoomFor, layoutPlan, lineWidth, nodeSize, wrapTitle, zoomedView } from "./planLayout";

const node = (id: string, title = id) => ({ id, title });

describe("the plan layout (B-9-30, B-9-32)", () => {
  it("lays a chain top down with one node in each row", () => {
    const l = layoutPlan([node("a"), node("b"), node("c")], [{ from: "a", to: "b" }, { from: "b", to: "c" }]);
    const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    expect(byId.a.y).toBeLessThan(byId.b.y);
    expect(byId.b.y).toBeLessThan(byId.c.y);
    expect(new Set(l.nodes.map((n) => n.rank)).size).toBe(3);
    expect(l.edges).toHaveLength(2);
  });

  it("centres nodes of one depth and keeps them apart", () => {
    const l = layoutPlan([node("a"), node("b"), node("c")], [{ from: "a", to: "b" }, { from: "a", to: "c" }]);
    const b = l.nodes.find((n) => n.id === "b")!;
    const c = l.nodes.find((n) => n.id === "c")!;
    const a = l.nodes.find((n) => n.id === "a")!;
    expect(b.y).toBe(c.y);
    expect(Math.abs(c.cx - b.cx)).toBeGreaterThanOrEqual((b.w + c.w) / 2 + 24 - 0.001);
    expect(a.cx).toBeCloseTo((b.cx + c.cx) / 2, 0);
  });

  it("places a node below the longest path to it", () => {
    const l = layoutPlan([node("a"), node("b"), node("c")], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }]);
    expect(l.nodes.find((n) => n.id === "c")!.rank).toBe(2);
    const long = l.edges.find((e) => e.from === "a" && e.to === "c")!;
    expect(long.points.length).toBe(3);
  });

  it("wraps titles at 28 characters and drops nothing", () => {
    const title = "A very long title for a node that needs more than one line";
    const lines = wrapTitle(title);
    expect(lines.every((x) => x.length <= 28)).toBe(true);
    expect(lines.join(" ")).toBe(title);
    expect(wrapTitle("x".repeat(60)).join("")).toBe("x".repeat(60));
    expect(wrapTitle("")).toEqual([""]);
  });

  it("sizes a node from its text with a minimum, and grows by 13 for each line beyond two", () => {
    expect(nodeSize(["a"])).toEqual({ w: MIN_W, h: MIN_H });
    expect(nodeSize(["a", "b", "c", "d"]).h).toBe(MIN_H + 26);
    expect(lineWidth("iii")).toBeLessThan(lineWidth("MMM"));
  });

  it("covers every edge inside the extent, and ignores an edge to an unknown node", () => {
    const l = layoutPlan([node("a"), node("b"), node("c")], [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "a", to: "zzz" }, { from: "b", to: "c" }]);
    expect(l.edges).toHaveLength(3);
    for (const e of l.edges) for (const p of e.points) expect(p.x).toBeGreaterThanOrEqual(0);
    for (const p of l.edges.flatMap((e) => e.points)) expect(p.x).toBeLessThanOrEqual(l.width);
    expect(Math.max(...l.nodes.map((n) => n.y + n.h))).toBeLessThanOrEqual(l.height);
  });

  it("survives a cycle and an empty plan", () => {
    expect(() => layoutPlan([node("a"), node("b")], [{ from: "a", to: "b" }, { from: "b", to: "a" }])).not.toThrow();
    expect(layoutPlan([], [])).toMatchObject({ nodes: [], edges: [] });
  });
});

describe("pan and zoom", () => {
  const box = { w: 400, h: 300 };
  const vp = { w: 800, h: 500 };

  it("fits with padding and never above 1.5", () => {
    expect(fitZoomFor({ w: 100, h: 100 }, vp)).toBe(1.5);
    expect(fitZoomFor({ w: 1600, h: 300 }, vp)).toBeCloseTo((800 - 32) / 1600, 5);
    expect(fitZoomFor(box, { w: 0, h: 0 })).toBe(1);
  });

  it("centres the box at the fit", () => {
    const v = fitView(box, vp, 1);
    expect(v).toEqual({ k: 1, x: 200, y: 100 });
  });

  it("zooms around the pointer, stops at 4 times, and returns to the fit at the floor", () => {
    const floor = fitZoomFor(box, vp);
    let v = fitView(box, vp, floor);
    const focus = { x: 400, y: 250 };
    v = zoomedView(v, 1.5, floor, focus, box, vp);
    expect(v.k).toBeCloseTo(floor * 1.5, 5);
    for (let i = 0; i < 20; i++) v = zoomedView(v, 1.5, floor, focus, box, vp);
    expect(v.k).toBe(MAX_ZOOM);
    for (let i = 0; i < 40; i++) v = zoomedView(v, 0.5, floor, focus, box, vp);
    expect(v).toEqual(fitView(box, vp, floor));
  });

  it("keeps the point under the pointer fixed", () => {
    const v0 = { k: 1, x: 10, y: 20 };
    const focus = { x: 300, y: 200 };
    const v1 = zoomedView(v0, 2, 0.5, focus, box, vp);
    const before = { x: (focus.x - v0.x) / v0.k, y: (focus.y - v0.y) / v0.k };
    const after = { x: (focus.x - v1.x) / v1.k, y: (focus.y - v1.y) / v1.k };
    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
  });
});
