import { describe, expect, it } from "vitest";
import { regionAnchors, surfaceReach } from "./anchors";

// a ball of sample points of a given radius (x, y, z, then a normal), enough to give the surface a reach in every direction
function ball(radius: number): Float32Array {
  const out: number[] = [];
  for (let a = 0; a < 360; a += 6) {
    for (let b = -84; b <= 84; b += 6) {
      const t = (a * Math.PI) / 180;
      const u = (b * Math.PI) / 180;
      const x = Math.cos(u) * Math.cos(t);
      const y = Math.sin(u);
      const z = Math.cos(u) * Math.sin(t);
      out.push(x * radius, y * radius, z * radius, x, y, z);
    }
  }
  return Float32Array.from(out);
}

describe("region anchors", () => {
  const pts = ball(50);

  it("puts the centre of a region at the mean of its neurons", () => {
    const [a] = regionAnchors(
      [
        { region: "motor", hemisphere: "L", x: 40, y: 10, z: 0 },
        { region: "motor", hemisphere: "L", x: 30, y: 30, z: 0 },
      ],
      pts,
    );
    expect(a.centre).toEqual({ x: 35, y: 20, z: 0 });
    expect(a.count).toBe(2);
  });

  it("pushes the caption outwards along the line from the centre of the brain, clear of the surface", () => {
    const [a] = regionAnchors([{ region: "parietal", hemisphere: "R", x: 0, y: 45, z: 0 }], pts, 7);
    expect(a.caption.x).toBeCloseTo(0, 5);
    expect(a.caption.z).toBeCloseTo(0, 5);
    expect(a.caption.y).toBeGreaterThanOrEqual(50 + 7 - 1);
    expect(a.caption.y).toBeLessThan(50 + 7 + 3);
  });

  it("keeps a region of each hemisphere apart", () => {
    const list = regionAnchors(
      [
        { region: "memory", hemisphere: "L", x: 40, y: 0, z: 0 },
        { region: "memory", hemisphere: "R", x: -40, y: 0, z: 0 },
      ],
      pts,
    );
    expect(list).toHaveLength(2);
    expect(list[0].caption.x).toBeGreaterThan(0);
    expect(list[1].caption.x).toBeLessThan(0);
  });

  it("measures the reach of the surface in a direction", () => {
    expect(surfaceReach(pts, { x: 1, y: 0, z: 0 })).toBeCloseTo(50, 3);
    expect(surfaceReach(new Float32Array(0), { x: 1, y: 0, z: 0 })).toBe(0);
  });

  it("reports the spread of the neurons around their centre", () => {
    const [a] = regionAnchors(
      [
        { region: "motor", hemisphere: "L", x: 10, y: 0, z: 0 },
        { region: "motor", hemisphere: "L", x: 30, y: 0, z: 0 },
      ],
      pts,
    );
    expect(a.spread).toBeCloseTo(10, 5);
  });
});
