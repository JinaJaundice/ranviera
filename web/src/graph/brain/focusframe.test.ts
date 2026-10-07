import { describe, expect, it } from "vitest";
import { fitFocusFrame, percentile, percentileRange } from "./focusframe";

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

const base = { sf: 1200, availW: 800, availH: 600, wantX: 0, wantY: 0, minDist: 20, maxDist: 4000 };

/** Points in a 40 by 30 box with a few far outliers. */
function cloud(outliers: number): number[][] {
  const r = rng(3);
  const co: number[][] = [];
  for (let i = 0; i < 400; i += 1) co.push([(r() - 0.5) * 40, (r() - 0.5) * 30, (r() - 0.5) * 6]);
  for (let i = 0; i < outliers; i += 1) co.push([i % 2 ? 300 : -300, i % 2 ? -200 : 200, 0]);
  return co;
}

describe("percentile", () => {
  it("interpolates between neighbours and clamps at the ends", () => {
    expect(percentile([0, 10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([0, 10], 0.25)).toBe(2.5);
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([], 0.5)).toBe(0);
    expect(percentileRange([40, 0, 20, 10, 30], 0, 1)).toEqual([0, 40]);
  });
});

describe("fitFocusFrame", () => {
  it("is not shrunk by a few outlying neurons", () => {
    const plain = fitFocusFrame({ ...base, co: cloud(0) });
    const scattered = fitFocusFrame({ ...base, co: cloud(8) });
    // 8 of 408 points are outliers (2 per cent), which is inside the 5 per cent that the frame ignores
    expect(scattered.dist).toBeLessThan(plain.dist * 1.15);
    expect(scattered.dist).toBeGreaterThan(plain.dist * 0.85);
  });

  it("keeps the whole height of the percentile box inside the free area and fills it", () => {
    for (const outliers of [0, 8, 20]) {
      const fit = fitFocusFrame({ ...base, co: cloud(outliers) });
      const h = fit.box.y1 - fit.box.y0;
      const w = fit.box.x1 - fit.box.x0;
      expect(h).toBeLessThanOrEqual(base.availH * 1.02);
      expect(w).toBeLessThanOrEqual(base.availW * 1.02);
      // one axis fills the area
      expect(Math.max(w / base.availW, h / base.availH)).toBeGreaterThan(0.97);
    }
  });

  it("lets the outliers stand outside the view", () => {
    const co = cloud(20);
    const fit = fitFocusFrame({ ...base, co });
    const outside = co.filter((c) => {
      const k = base.sf / (fit.dist - (c[2] - fit.mid[2]));
      return Math.abs((c[0] - fit.mid[0] + fit.shift) * k) > base.availW / 2 || Math.abs((c[1] - fit.mid[1] + fit.lift) * k) > base.availH / 2;
    });
    expect(outside.length).toBeGreaterThanOrEqual(15);
  });

  it("centres the box where wanted", () => {
    const fit = fitFocusFrame({ ...base, wantX: 120, wantY: -40, co: cloud(4) });
    expect((fit.box.x0 + fit.box.x1) / 2).toBeCloseTo(120, 0);
    expect((fit.box.y0 + fit.box.y1) / 2).toBeCloseTo(-40, 0);
  });

  it("respects the nearest distance for a very small region", () => {
    const fit = fitFocusFrame({ ...base, minDist: 300, co: [[0, 0, 0], [1, 1, 0], [2, 0, 0], [0, 2, 0]] });
    expect(fit.dist).toBeGreaterThanOrEqual(300);
  });
});
