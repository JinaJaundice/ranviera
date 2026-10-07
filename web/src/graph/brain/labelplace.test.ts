import { describe, expect, it } from "vitest";
import { overlaps, placeLabels, type LabelRequest } from "./labelplace";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("placeLabels", () => {
  it("keeps clear of a blocked box and moves to the next position", () => {
    const blocked = [{ left: 105, top: 90, w: 100, h: 30 }];
    const [p] = placeLabels([{ key: "a", x: 100, y: 100, w: 60, h: 16 }], 800, 600, 2, undefined, blocked);
    expect(overlaps(p, blocked[0])).toBe(false);
    expect(p.moved).toBe(true);
  });

  it("drops a label when every position is blocked", () => {
    const blocked = [{ left: 0, top: 0, w: 800, h: 600 }];
    expect(placeLabels([{ key: "a", x: 100, y: 100, w: 60, h: 16 }], 800, 600, 2, undefined, blocked)).toHaveLength(0);
  });

  it("puts a lone label to the right of its point without a leader line", () => {
    const [p] = placeLabels([{ key: "a", x: 100, y: 100, w: 60, h: 16 }], 800, 600);
    expect(p.left).toBeGreaterThan(100);
    expect(p.moved).toBe(false);
  });

  it("moves a label that would overlap and keeps a leader line for it", () => {
    const placed = placeLabels(
      [
        { key: "a", x: 100, y: 100, w: 60, h: 16 },
        { key: "b", x: 102, y: 104, w: 60, h: 16 },
      ],
      800,
      600,
    );
    expect(placed).toHaveLength(2);
    expect(placed[0].moved).toBe(false);
    expect(placed[1].moved).toBe(true);
    expect(overlaps(placed[0], placed[1])).toBe(false);
  });

  it("drops a label that fits at none of its 8 positions", () => {
    const crowd: LabelRequest[] = [];
    // 9 labels on one point: the first takes a position, and only 8 positions exist around a point
    for (let i = 0; i < 12; i += 1) crowd.push({ key: `k${i}`, x: 300, y: 300, w: 80, h: 16 });
    const placed = placeLabels(crowd, 800, 600);
    expect(placed.length).toBeLessThanOrEqual(8);
    expect(placed.length).toBeGreaterThan(1);
  });

  it("keeps the labels in priority order, so that the first request is always placed", () => {
    const placed = placeLabels(
      [
        { key: "first", x: 50, y: 50, w: 70, h: 16 },
        { key: "second", x: 52, y: 50, w: 70, h: 16 },
      ],
      800,
      600,
    );
    expect(placed[0].key).toBe("first");
  });

  it("keeps every label inside the canvas", () => {
    const placed = placeLabels([{ key: "edge", x: 790, y: 5, w: 80, h: 16 }], 800, 600);
    for (const p of placed) {
      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.top).toBeGreaterThanOrEqual(0);
      expect(p.left + p.w).toBeLessThanOrEqual(800);
    }
  });

  it("tries a caption centred on its point first", () => {
    const [p] = placeLabels([{ key: "c", x: 400, y: 300, w: 100, h: 16, centred: true }], 800, 600);
    expect(p.left).toBeCloseTo(350);
    expect(p.moved).toBe(false);
  });

  it("never shows 2 labels that overlap, for 300 random requests in 20 layouts", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const rand = rng(seed);
      const reqs: LabelRequest[] = [];
      for (let i = 0; i < 300; i += 1) {
        reqs.push({ key: `n${i}`, x: rand() * 1200 + 40, y: rand() * 700 + 40, w: 30 + rand() * 120, h: 16, radius: 2 + rand() * 6, centred: rand() < 0.1 });
      }
      const placed = placeLabels(reqs, 1280, 800);
      expect(placed.length).toBeGreaterThan(10);
      for (let i = 0; i < placed.length; i += 1) {
        for (let j = i + 1; j < placed.length; j += 1) expect(overlaps(placed[i], placed[j])).toBe(false);
      }
    }
  }, 20_000); // 6,000 placements take about 5 seconds on a shared CI runner, past the default limit of 5

  it("keeps a label out of the safe margins", () => {
    const [p] = placeLabels([{ key: "a", x: 70, y: 50, w: 60, h: 16, centred: true }], 800, 600, 2, { left: 60, top: 44, right: 8, bottom: 8 });
    expect(p.top).toBeGreaterThanOrEqual(44);
    expect(p.left).toBeGreaterThanOrEqual(60);
    expect(placeLabels([{ key: "b", x: 10, y: 10, w: 700, h: 16 }], 800, 600, 2, { left: 60, top: 44, right: 8, bottom: 8 })).toHaveLength(0);
  });
});
