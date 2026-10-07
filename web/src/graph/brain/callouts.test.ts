import { describe, expect, it } from "vitest";
import { boxHitsPolygon, convexHull, extentX, layoutCallouts, segmentHitsBox, segmentsCross, type CalloutRequest, type PlacedCallout, type Pt } from "./callouts";

/** A small seeded generator, so that a failure can be repeated. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function ellipse(cx: number, cy: number, rx: number, ry: number, n = 90): Pt[] {
  return convexHull(Array.from({ length: n }, (_, i) => ({ x: cx + rx * Math.cos((2 * Math.PI * i) / n), y: cy + ry * Math.sin((2 * Math.PI * i) / n) })));
}

const W = 1280;
const H = 720;
const hull = ellipse(640, 380, 280, 250);
const safe = { left: 8, top: 44, right: 8, bottom: 8 };

const pathsCross = (a: Pt[], b: Pt[]) => a.slice(1).some((p, i) => b.slice(1).some((q, k) => segmentsCross(a[i], p, b[k], q)));

/** The leaders are only horizontal or vertical, start horizontally at the caption, have one vertical segment at most and end on the dot. */
function expectOrthogonal(placed: PlacedCallout[]): void {
  for (const p of placed) {
    expect(p.path[0]).toEqual(p.join);
    const last = p.path[p.path.length - 1];
    expect(last.x).toBeCloseTo(p.dot.x, 5);
    expect(Math.abs(last.y - p.dot.y)).toBeLessThan(0.5);
    let vertical = 0;
    p.path.slice(1).forEach((q, i) => {
      const a = p.path[i];
      const horizontal = Math.abs(a.y - q.y) < 1e-6;
      const upright = Math.abs(a.x - q.x) < 1e-6;
      expect(horizontal || upright, `${p.key} has a slanted segment`).toBe(true);
      if (i === 0) expect(horizontal, `${p.key} does not start horizontally`).toBe(true);
      if (upright && !horizontal) vertical += 1;
    });
    expect(vertical).toBeLessThanOrEqual(1);
  }
  placed.forEach((a, i) => {
    for (const b of placed) {
      if (a !== b) for (let k = 0; k + 1 < a.path.length; k += 1) expect(segmentHitsBox(a.path[k], a.path[k + 1], b), `the leader of ${a.key} passes through ${b.key}`).toBe(false);
    }
    for (const b of placed.slice(i + 1)) expect(pathsCross(a.path, b.path), `the leaders of ${a.key} and ${b.key} cross`).toBe(false);
  });
}

function dots(seed: number, n = 10): CalloutRequest[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    // a point inside the ellipse
    const a = r() * 2 * Math.PI;
    const d = Math.sqrt(r()) * 0.85;
    return { key: `r${i}`, x: 640 + 280 * d * Math.cos(a), y: 380 + 250 * d * Math.sin(a), w: 110 + Math.round(r() * 90), h: 26 };
  });
}

describe("callout layout", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    it(`keeps the callouts apart, outside the silhouette and uncrossed (seed ${seed})`, () => {
      const placed = layoutCallouts(dots(seed), hull, { width: W, height: H, safe });
      expect(placed).toHaveLength(10);
      for (const p of placed) {
        expect(boxHitsPolygon(p, hull), `${p.key} meets the silhouette`).toBe(false);
        expect(p.left).toBeGreaterThanOrEqual(safe.left);
        expect(p.left + p.w).toBeLessThanOrEqual(W - safe.right);
        expect(p.top).toBeGreaterThanOrEqual(safe.top - 0.001);
        expect(p.top + p.h).toBeLessThanOrEqual(H - safe.bottom + 0.001);
      }
      placed.forEach((a, i) => {
        for (const b of placed.slice(i + 1)) {
          const apart = a.left + a.w <= b.left || b.left + b.w <= a.left || a.top + a.h + 6 - 0.001 <= b.top || b.top + b.h + 6 - 0.001 <= a.top;
          expect(apart, `${a.key} and ${b.key} are less than 6 pixels apart`).toBe(true);
          if (a.side === b.side) expect(pathsCross(a.path, b.path), `the leaders of ${a.key} and ${b.key} cross`).toBe(false);
        }
      });
    });
  }

  it("puts a callout on the side of the centre of the brain where its dot lies", () => {
    const placed = layoutCallouts(dots(3), hull, { width: W, height: H, safe });
    const centre = (Math.min(...hull.map((p) => p.x)) + Math.max(...hull.map((p) => p.x))) / 2;
    for (const p of placed) expect(p.side).toBe(p.dot.x < centre ? "left" : "right");
  });

  it("orders each column by the height of the dots", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const placed = layoutCallouts(dots(seed), hull, { width: W, height: H, safe });
      for (const side of ["left", "right"] as const) {
        const col = placed.filter((p) => p.side === side).sort((a, b) => a.top - b.top);
        const inversions = col.filter((p, i) => i > 0 && p.dot.y < col[i - 1].dot.y - 60).length;
        expect(inversions).toBe(0);
      }
    }
  });

  it("keeps a callout out of a box that another part of the window covers", () => {
    const blocked = { left: W - 200, top: H - 140, w: 192, h: 132 };
    for (let seed = 1; seed <= 10; seed += 1) {
      const placed = layoutCallouts(dots(seed), hull, { width: W, height: H, safe, blocked: [blocked] });
      for (const p of placed) {
        const hit = p.left < blocked.left + blocked.w && blocked.left < p.left + p.w && p.top < blocked.top + blocked.h && blocked.top < p.top + p.h;
        expect(hit, `${p.key} lies under the panel (seed ${seed})`).toBe(false);
      }
    }
  });

  it("stands the left column clear of an offset hull and leaves the free area to the right", () => {
    const off = ellipse(900, 380, 230, 230);
    const placed = layoutCallouts(dots(5), off, { width: W, height: H, safe: { ...safe, left: 400 } });
    for (const p of placed) expect(p.left).toBeGreaterThanOrEqual(400);
  });
});

describe("callout layout over a focus, a trail and a blocked control group", () => {
  // a focused region draws its neurons larger and the other regions fade, but the layout sees dots at the edge of each region that faces its column
  function withEdges(seed: number): CalloutRequest[] {
    const r = rng(seed + 500);
    return dots(seed).map((d) => ({
      ...d,
      edge: { left: { x: d.x - 20 - r() * 60, y: d.y + (r() - 0.5) * 50 }, right: { x: d.x + 20 + r() * 60, y: d.y + (r() - 0.5) * 50 } },
    }));
  }
  const offset = ellipse(840, 400, 230, 230);
  const blocked = [{ left: W - 200, top: H - 140, w: 192, h: 132 }, { left: 0, top: 44, w: 360, h: H - 52 }];
  for (let seed = 1; seed <= 40; seed += 1) {
    it(`keeps the leaders of one column uncrossed (seed ${seed})`, () => {
      for (const [h, opts] of [[hull, {}], [offset, { safe: { ...safe, left: 368 }, blocked }]] as const) {
        const placed = layoutCallouts(withEdges(seed), h, { width: W, height: H, safe, ...opts });
        placed.forEach((a, i) => {
          for (const b of placed.slice(i + 1)) {
            if (a.side === b.side) expect(pathsCross(a.path, b.path), `the leaders of ${a.key} and ${b.key} cross`).toBe(false);
          }
        });
      }
    });
  }

  it("keeps most leaders out of the control group over 40 layouts", () => {
    const control = [{ left: W - 200, top: H - 140, w: 192, h: 132 }];
    let hits = 0;
    let total = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      for (const p of layoutCallouts(withEdges(seed), hull, { width: W, height: H, safe, blocked: control })) {
        total += 1;
        if (p.path.slice(1).some((q, i) => segmentHitsBox(p.path[i], q, control[0]))) hits += 1;
      }
    }
    expect(hits / total).toBeLessThan(0.03);
  });

  it("ends each leader on the edge of its region that faces the column, which shortens it", () => {
    const req = withEdges(4);
    const placed = layoutCallouts(req, hull, { width: W, height: H, safe });
    for (const p of placed) {
      const r = req.find((q) => q.key === p.key)!;
      expect(p.dot).toEqual(r.edge![p.side]);
    }
  });
});

describe("orthogonal leaders in the rest, expanded and focused layouts", () => {
  const edgeOf = (d: CalloutRequest, r: () => number): CalloutRequest => ({ ...d, edge: { left: { x: d.x - 20 - r() * 60, y: d.y + (r() - 0.5) * 50 }, right: { x: d.x + 20 + r() * 60, y: d.y + (r() - 0.5) * 50 } } });
  for (let seed = 1; seed <= 40; seed += 1) {
    it(`rest (seed ${seed})`, () => {
      const r = rng(seed + 900);
      expectOrthogonal(layoutCallouts(dots(seed).map((d) => edgeOf(d, r)), hull, { width: W, height: H, safe }));
    });
    it(`expanded, the wider brain (seed ${seed})`, () => {
      const wide = ellipse(640, 380, 330, 270);
      const r = rng(seed + 300);
      const reqs = Array.from({ length: 10 }, (_, i) => edgeOf({ key: `r${i}`, x: 640 + 240 * (r() * 2 - 1), y: 380 + 250 * (r() * 2 - 1), w: 110 + Math.round(r() * 90), h: 26 }, r));
      expectOrthogonal(layoutCallouts(reqs, wide, { width: W, height: H, safe }));
    });
  }
  it("focused: one callout, on its side, with an orthogonal leader", () => {
    const placed = layoutCallouts([{ key: "r0", x: 500, y: 300, w: 150, h: 26 }], hull, { width: W, height: H, safe });
    expect(placed).toHaveLength(1);
    expect(placed[0].side).toBe("left");
    expectOrthogonal(placed);
  });
});

describe("geometry helpers", () => {
  it("finds the extent of a polygon in a band", () => {
    const e = extentX([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], 2, 4);
    expect(e).toEqual({ min: 0, max: 10 });
  });
  it("tests a box against a polygon", () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(boxHitsPolygon({ left: 12, top: 0, w: 5, h: 5 }, sq)).toBe(false);
    expect(boxHitsPolygon({ left: 8, top: 8, w: 5, h: 5 }, sq)).toBe(true);
    expect(boxHitsPolygon({ left: -5, top: 3, w: 30, h: 2 }, sq)).toBe(true);
    expect(boxHitsPolygon({ left: 3, top: 3, w: 2, h: 2 }, sq)).toBe(true);
  });
});

/** The distance from a box to the outline of a polygon, taken on points 2 pixels apart along its edges. */
function gapToOutline(box: { left: number; top: number; w: number; h: number }, poly: Pt[]): number {
  let gap = Infinity;
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 2));
    for (let k = 0; k <= n; k += 1) {
      const x = p.x + ((q.x - p.x) * k) / n;
      const y = p.y + ((q.y - p.y) * k) / n;
      gap = Math.min(gap, Math.hypot(Math.max(box.left - x, 0, x - (box.left + box.w)), Math.max(box.top - y, 0, y - (box.top + box.h))));
    }
  }
  return gap;
}

describe("clearance from the outline", () => {
  const regions = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  it("keeps every callout at least 24 pixels from the outline at its own height, at every window width", () => {
    const rand = rng(7);
    for (const width of [900, 1024, 1280, 1440, 1920, 2560]) {
      const height = Math.round((width * 9) / 16);
      // an egg that leaves the room for a caption of 190 pixels and its leader at each side, as the framing does
      const rx = (width - 2 * (190 + 44 + 60)) / 2;
      const ry = (height - 52) / 2;
      const outline = ellipse(width / 2, 44 + ry, rx, ry).map((p) => ({ x: p.x + (p.y - 44 - ry) * 0.08, y: p.y }));
      const requests: CalloutRequest[] = regions.map((key, i) => ({ key, x: width / 2 + (rand() - 0.5) * rx, y: 60 + rand() * (height - 120) + i, w: 190, h: 28 }));
      const placed = layoutCallouts(requests, outline, { width, height, safe: { left: 60, top: 44, right: 8, bottom: 8 }, clearance: 30 });
      expect(placed).toHaveLength(regions.length);
      for (const p of placed) {
        const e = extentX(outline, p.top, p.top + p.h);
        const gap = p.side === "left" ? e.min - (p.left + p.w) : p.left - e.max;
        expect(gap, `${p.key} at ${width}`).toBeGreaterThanOrEqual(24);
        expect(gapToOutline(p, outline), `${p.key} at ${width}`).toBeGreaterThanOrEqual(24);
      }
    }
  });

  it("puts every callout in the one column when a side is wanted", () => {
    const requests: CalloutRequest[] = regions.slice(0, 3).map((key, i) => ({ key, x: 900 + i * 20, y: 200 + i * 100, w: 190, h: 28 }));
    const placed = layoutCallouts(requests, hull, { width: W, height: H, safe, only: "left" });
    expect(placed.every((p) => p.side === "left")).toBe(true);
  });
});
