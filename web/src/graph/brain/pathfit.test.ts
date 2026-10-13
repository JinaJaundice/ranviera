import { describe, expect, it } from "vitest";
import { agentPath, buildPath, type V3 } from "./path";
import { fitPathCamera, projectToScreen, viewAxes, type FitRect, type FitView } from "./pathfit";
import { PATH_FRAME_MARGIN } from "./look";
import { RUN_0001, RUN_0012, promptSteps, volumeFor, worldOf } from "./pathfixtures";

// 1440 by 900: the trail panel takes the left 380 pixels, the control bar the right 64, the top bar 44
const WIDTH = 1440;
const HEIGHT = 900;
const FREE: FitRect = { left: 388, top: 44, right: WIDTH - 64, bottom: HEIGHT - 8 };
const FOV = 45;
const F = HEIGHT / (2 * Math.tan((FOV * Math.PI) / 360));
const VIEW: FitView = { sf: F, cx: (FREE.left + FREE.right) / 2, cy: (FREE.top + FREE.bottom) / 2 };
const OPTS = { margin: PATH_FRAME_MARGIN, minDist: 80, maxDist: 820 };

const norm = (v: V3): V3 => {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

/** Every waypoint and every sample point of the main line, with the knots and the tips of the branches. */
function pointsOf(g: ReturnType<typeof buildPath>): V3[] {
  const out: V3[] = g.waypoints.map((w) => w.pos);
  for (const k of g.knots) out.push(k.pos);
  for (const b of g.branches) out.push(b.tip);
  for (const s of g.stubs) out.push(s.from, s.to);
  const e = g.line.ends;
  for (let i = 0; i + 2 < e.length; i += 3) out.push({ x: e[i], y: e[i + 1], z: e[i + 2] });
  return out;
}

const CASES: [string, () => ReturnType<typeof buildPath>][] = [
  ["the prompt of 12 steps", () => buildPath(promptSteps(12), worldOf, { volume: volumeFor() })],
  ["the prompt of 45 steps", () => buildPath(promptSteps(45), worldOf, { volume: volumeFor() })],
  ["run AL-2026-0001", () => buildPath(agentPath(RUN_0001(), () => true).steps, worldOf, { volume: volumeFor() })],
  ["run AL-2026-0012", () => buildPath(agentPath(RUN_0012(), () => true).steps, worldOf, { volume: volumeFor() })],
];

describe("Show the whole path", () => {
  it.each([...CASES])("puts every waypoint and every point of the line of %s inside the free area, 48 pixels from its edges", (_name, make) => {
    const g = make();
    const pts = pointsOf(g);
    expect(pts.length).toBeGreaterThan(g.waypoints.length);
    for (const dir of [norm({ x: 190, y: 95, z: 215 }), norm({ x: -150, y: 60, z: 180 }), norm({ x: 0.2, y: 1, z: 0.1 })]) {
      const fit = fitPathCamera(pts, dir, VIEW, FREE, OPTS);
      expect(fit.inside).toBe(true);
      let outside = 0;
      for (const p of pts) {
        const s = projectToScreen(p, dir, fit.target, fit.dist, VIEW);
        if (!s || s.x < FREE.left + 48 - 0.5 || s.x > FREE.right - 48 + 0.5 || s.y < FREE.top + 48 - 0.5 || s.y > FREE.bottom - 48 + 0.5) outside += 1;
      }
      expect(outside).toBe(0);
      expect(fit.dist).toBeGreaterThanOrEqual(OPTS.minDist);
      expect(fit.dist).toBeLessThanOrEqual(OPTS.maxDist);
    }
  });

  it("fills the free area rather than standing far back from a small path", () => {
    const g = buildPath(promptSteps(12), worldOf, { volume: volumeFor() });
    const pts = pointsOf(g);
    const dir = norm({ x: 190, y: 95, z: 215 });
    const fit = fitPathCamera(pts, dir, VIEW, FREE, OPTS);
    const xs = pts.map((p) => projectToScreen(p, dir, fit.target, fit.dist, VIEW)!.x);
    const ys = pts.map((p) => projectToScreen(p, dir, fit.target, fit.dist, VIEW)!.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    // the larger side takes at least 85 per cent of the room that the margin leaves
    expect(Math.max(w / (FREE.right - FREE.left - 96), h / (FREE.bottom - FREE.top - 96))).toBeGreaterThan(0.85);
  });

  it("keeps the view axes at right angles", () => {
    const { right, up, back } = viewAxes({ x: 1, y: 2, z: 3 });
    const d = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
    expect(Math.abs(d(right, up))).toBeLessThan(1e-9);
    expect(Math.abs(d(right, back))).toBeLessThan(1e-9);
    expect(Math.abs(d(up, back))).toBeLessThan(1e-9);
  });
});
