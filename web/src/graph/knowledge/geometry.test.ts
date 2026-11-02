import { describe, expect, it } from "vitest";
import {
  MAX_FIT_ZOOM,
  arrowGeometry,
  boundsOf,
  clusterAlpha,
  clusterHull,
  clusterToken,
  convexHull,
  fitCamera,
  hashText,
  junctionPoint,
  labelAlpha,
  panBy,
  pickNode,
  seedPositions,
  toScreen,
  toWorld,
  zoomAt,
  zoomRatio,
  CLUSTER_TOKENS,
} from "./geometry";

describe("camera (B-6-49, B-6-50)", () => {
  it("fits on the axis that runs out of room and centres the box", () => {
    const cam = fitCamera({ minX: 0, minY: 0, maxX: 200, maxY: 100 }, 400, 400, 0);
    expect(cam.k).toBe(2);
    expect(toScreen(cam, { x: 100, y: 50 })).toEqual({ x: 200, y: 200 });
    const tall = fitCamera({ minX: 0, minY: 0, maxX: 100, maxY: 400 }, 400, 400, 0);
    expect(tall.k).toBe(1);
  });

  it("caps the fit scale and reads a viewport with no size as 1", () => {
    const one = fitCamera({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, 800, 800, 0);
    expect(one.k).toBe(MAX_FIT_ZOOM);
    expect(fitCamera({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0, 0).k).toBe(1);
    expect(fitCamera(null, 300, 200)).toEqual({ x: 150, y: 100, k: 1 });
  });

  it("zooms about the focus point, clamps at the floor and the ceiling, and does nothing for an identical factor", () => {
    const cam = { x: 10, y: 20, k: 1 };
    const focus = { x: 100, y: 80 };
    const before = toWorld(cam, focus);
    const next = zoomAt(cam, 2, focus, 0.5);
    expect(next.k).toBe(2);
    expect(toWorld(next, focus).x).toBeCloseTo(before.x);
    expect(toWorld(next, focus).y).toBeCloseTo(before.y);
    expect(zoomAt(cam, 0.01, focus, 0.5).k).toBe(0.5);
    expect(zoomAt(cam, 1000, focus, 0.5, 24).k).toBe(24);
    expect(zoomAt({ x: 0, y: 0, k: 0.5 }, 0.5, focus, 0.5)).toEqual({ x: 0, y: 0, k: 0.5 });
    const same = { x: 3, y: 4, k: 1 };
    expect(zoomAt(same, 1, focus, 0.5)).toBe(same);
  });

  it("pans without changing the scale", () => {
    expect(panBy({ x: 1, y: 2, k: 3 }, 4, 5)).toEqual({ x: 5, y: 7, k: 3 });
  });
});

describe("label gate (B-6-33)", () => {
  it("reads 1 at the fit, below 1 zoomed in and above 1 zoomed out", () => {
    expect(zoomRatio({ x: 0, y: 0, k: 2 }, 2)).toBe(1);
    expect(zoomRatio({ x: 0, y: 0, k: 4 }, 2)).toBe(0.5);
    expect(zoomRatio({ x: 0, y: 0, k: 1 }, 2)).toBe(2);
  });

  it("fades the claim labels in and the cluster names out over one span, so they never show together", () => {
    for (const gate of [0.25, 0.5, 1]) {
      for (const ratio of [0.05, 0.2, 0.4, 0.5, 0.6, 1, 3]) {
        expect(labelAlpha(ratio, gate) + clusterAlpha(ratio, gate)).toBeCloseTo(1);
      }
      expect(labelAlpha(0.001, gate)).toBe(1);
      expect(labelAlpha(100, gate)).toBe(0);
    }
  });

  it("makes the span proportional to the gate", () => {
    const span = (gate: number) => {
      const lo = gate + gate * 0.25;
      const hi = gate - gate * 0.25;
      return lo - hi;
    };
    expect(labelAlpha(0.75 + 0.25 / 2, 0.5)).toBeCloseTo(0, 5);
    expect(span(1) / span(0.5)).toBeCloseTo(2);
    expect(labelAlpha(1 + 0.25, 1)).toBeCloseTo(0, 5);
    expect(labelAlpha(1 - 0.25, 1)).toBeCloseTo(1, 5);
  });
});

describe("hulls and cluster colour (B-6-51)", () => {
  it("draws no hull for fewer than three members and an outline for three or more", () => {
    expect(clusterHull([{ x: 0, y: 0 }, { x: 10, y: 0 }], 5)).toBeNull();
    const hull = clusterHull([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 30 }], 6);
    expect(hull).not.toBeNull();
    const box = boundsOf(hull!)!;
    expect(box.minX).toBeCloseTo(-6, 0);
    expect(box.maxX).toBeCloseTo(46, 0);
  });

  it("keeps the corners of the hull and drops the points inside", () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 },
      { x: 5, y: 0 },
    ]);
    expect(hull).toHaveLength(4);
  });

  it("chooses the same token for the same id and one of the six family tokens", () => {
    expect(clusterToken("src_ent")).toBe(clusterToken("src_ent"));
    expect(CLUSTER_TOKENS).toContain(clusterToken("anything"));
    expect(hashText("a")).not.toBe(hashText("b"));
    const seen = new Set(Array.from({ length: 60 }, (_, i) => clusterToken(`src_${i}`)));
    expect(seen.size).toBeGreaterThan(3);
  });
});

describe("junction and arrow geometry (B-6-35, B-6-43)", () => {
  it("places a junction halfway between the middle of the premises and the conclusion", () => {
    const at = junctionPoint([{ x: 0, y: 0 }, { x: 40, y: 0 }], { x: 20, y: 60 });
    expect(at).toEqual({ x: 20, y: 30 });
  });

  it("lands the tip on the edge of the target, starts the shaft outside the source and is symmetric", () => {
    const a = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 5, 8, 10, 6)!;
    expect(a.tail.x).toBe(5);
    expect(a.tip.x).toBe(92);
    expect(a.left.x).toBe(a.right.x);
    expect(a.left.y).toBe(-a.right.y);
  });

  it("returns null for coincident ends and for discs that touch", () => {
    expect(arrowGeometry({ x: 3, y: 3 }, { x: 3, y: 3 }, 1, 1, 5)).toBeNull();
    expect(arrowGeometry({ x: 0, y: 0 }, { x: 8, y: 0 }, 5, 5, 5)).toBeNull();
  });
});

describe("picking and seeding (B-6-36, B-6-47)", () => {
  const nodes = [
    { id: "n_b", x: 0, y: 0, r: 5, kind: "proposition" as const },
    { id: "n_a", x: 0, y: 0, r: 5, kind: "proposition" as const },
    { id: "arg_1", x: 30, y: 0, r: 3, kind: "junction" as const },
    { id: "n_far", x: 100, y: 0, r: 5, kind: "proposition" as const },
  ];

  it("picks the nearest claim inside the pad and never a junction", () => {
    expect(pickNode(nodes, { x: 98, y: 0 }, 0)).toBe("n_far");
    expect(pickNode(nodes, { x: 30, y: 0 }, 2)).toBeNull();
    expect(pickNode(nodes, { x: 50, y: 50 }, 4)).toBeNull();
    expect(pickNode(nodes, { x: 8, y: 0 }, 4)).toBe("n_a");
  });

  it("breaks a tie by the smaller id", () => {
    expect(pickNode(nodes, { x: 1, y: 0 }, 0)).toBe("n_a");
  });

  it("seeds the missing positions on a ring and keeps the known ones as they were", () => {
    const known = { a: { x: 10, y: 10 }, b: { x: -10, y: -10 } };
    const out = seedPositions(["a", "b", "c", "d"], known);
    expect(out.a).toBe(known.a);
    expect(out.c).toEqual(seedPositions(["a", "b", "c", "d"], known).c);
    expect(out.c).not.toEqual(out.d);
    expect(seedPositions(["a", "b"], known)).toBe(known);
  });
});
