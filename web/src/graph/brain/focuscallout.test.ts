import { describe, expect, it } from "vitest";
import { keepOutBoxes, layoutFocusCallout, type CalloutRequest, type Pt } from "./callouts";
import { placeLabels, type LabelRequest } from "./labelplace";

const W = 1280;
const H = 720;
const safe = { left: 60, top: 44, right: 8, bottom: 8 };
const req: CalloutRequest = { key: "r:a", x: 500, y: 300, w: 180, h: 28 };
const opts = { width: W, height: H, safe, clearance: 12, radius: 4 };

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Neurons scattered over a rectangle. */
function neurons(x0: number, x1: number, y0: number, y1: number, n: number, seed = 1): Pt[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => ({ x: x0 + r() * (x1 - x0), y: y0 + r() * (y1 - y0) }));
}

const gap = (p: Pt, b: { left: number; top: number; w: number; h: number }) => Math.hypot(Math.max(b.left - p.x, 0, p.x - (b.left + b.w)), Math.max(b.top - p.y, 0, p.y - (b.top + b.h)));

describe("layoutFocusCallout", () => {
  it("stands in the free margin at the height of the region when the margin is wide enough", () => {
    const ns = neurons(400, 1200, 60, 700, 600);
    const p = layoutFocusCallout(req, ns, opts);
    expect(p.left).toBe(safe.left);
    expect(Math.abs(p.top - (req.y - req.h / 2))).toBeLessThanOrEqual(8);
    for (const n of ns) expect(gap(n, p)).toBeGreaterThanOrEqual(12);
  });

  it("goes to the top left of the free area, clear of every neuron, when no margin is wide enough", () => {
    // neurons fill the width from the left margin, but leave the top right corner of the free area free
    const ns = [...neurons(70, 1200, 200, 700, 800, 2), ...neurons(70, 120, 60, 200, 30, 3)];
    const p = layoutFocusCallout({ ...req, y: 400 }, ns, opts);
    for (const n of ns) expect(gap(n, p), `neuron at ${n.x},${n.y}`).toBeGreaterThanOrEqual(12);
    expect(p.top).toBeLessThan(200);
    expect(p.top).toBeGreaterThanOrEqual(safe.top);
  });

  it("keeps clear of a box that another part of the window covers", () => {
    const blocked = [{ left: 0, top: 280, w: 300, h: 60 }];
    const p = layoutFocusCallout(req, neurons(500, 1200, 60, 700, 300), { ...opts, blocked });
    expect(p.top + p.h <= 280 || p.top >= 340).toBe(true);
  });

  it("draws an orthogonal leader that starts at the caption and ends on a neuron to its right", () => {
    const ns = neurons(400, 1200, 60, 700, 300, 5);
    const p = layoutFocusCallout(req, ns, opts);
    expect(p.path[0]).toEqual(p.join);
    p.path.slice(1).forEach((q, i) => {
      const a = p.path[i];
      expect(Math.abs(a.x - q.x) < 1e-6 || Math.abs(a.y - q.y) < 1e-6).toBe(true);
    });
    const last = p.path[p.path.length - 1];
    expect(ns.some((n) => n.x === last.x && n.y === last.y)).toBe(true);
    expect(last.x).toBeGreaterThan(p.join.x);
  });
});

describe("label clearance from the callout", () => {
  it("keeps every placed label at least 14 pixels from the callout and from its leader", () => {
    const ns = neurons(400, 1200, 60, 700, 300, 9);
    const p = layoutFocusCallout(req, ns, opts);
    const keep = keepOutBoxes(p, p.path, 14);
    const r = rng(11);
    const labels: LabelRequest[] = Array.from({ length: 60 }, (_, i) => ({ key: `c:${i}`, x: 60 + r() * 700, y: 50 + r() * 650, w: 90, h: 18, radius: 4, centred: true }));
    const placed = placeLabels(labels, W, H, 6, safe, keep);
    expect(placed.length).toBeGreaterThan(5);
    const segs = p.path.slice(1).map((q, i) => ({ left: Math.min(p.path[i].x, q.x), top: Math.min(p.path[i].y, q.y), w: Math.abs(p.path[i].x - q.x), h: Math.abs(p.path[i].y - q.y) }));
    const dist = (a: { left: number; top: number; w: number; h: number }, b: { left: number; top: number; w: number; h: number }) =>
      Math.hypot(Math.max(b.left - (a.left + a.w), 0, a.left - (b.left + b.w)), Math.max(b.top - (a.top + a.h), 0, a.top - (b.top + b.h)));
    for (const l of placed) {
      expect(dist(l, p), l.key).toBeGreaterThanOrEqual(14);
      for (const s of segs) expect(dist(l, s), l.key).toBeGreaterThanOrEqual(14);
    }
  });

  it("hides a label whose every position is within 14 pixels of the callout", () => {
    const box = { left: 100, top: 100, w: 200, h: 28 };
    const keep = keepOutBoxes(box, [{ x: 300, y: 114 }, { x: 600, y: 114 }], 14);
    const near = placeLabels([{ key: "c:near", x: 200, y: 80, w: 60, h: 16, centred: true }], 800, 600, 2, undefined, keep);
    // it moves out of the zone rather than overlapping it
    expect(near).toHaveLength(1);
    for (const l of near) expect(l.top + l.h <= 100 - 14 || l.top >= 128 + 14 || l.left >= 300 + 14).toBe(true);
    // and it is dropped when the whole canvas is inside the zone
    const wide = keepOutBoxes({ left: 0, top: 0, w: 800, h: 600 }, [], 14);
    expect(placeLabels([{ key: "c:near", x: 200, y: 114, w: 60, h: 16, centred: true }], 800, 600, 2, undefined, wide)).toHaveLength(0);
  });

  it("grows the callout and each leader segment by the gap", () => {
    const boxes = keepOutBoxes({ left: 10, top: 10, w: 100, h: 20 }, [{ x: 110, y: 20 }, { x: 150, y: 20 }, { x: 150, y: 80 }], 14);
    expect(boxes).toEqual([
      { left: -4, top: -4, w: 128, h: 48 },
      { left: 96, top: 6, w: 68, h: 28 },
      { left: 136, top: 6, w: 28, h: 88 },
    ]);
  });
});
