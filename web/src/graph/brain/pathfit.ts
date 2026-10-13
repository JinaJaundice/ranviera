// The camera for Show the whole path (docs/BRAIN.md, "The thought trail panel and the line"). The camera looks at `target` from the
// direction `dir` at the distance `dist`, and the view puts the principal point at the centre of the free area of the canvas. The fit
// finds the distance and the target at which every point of the path projects inside the free rectangle, less a margin, and then
// checks it point by point. Pure, and tested in pathfit.test.ts, which projects every point itself.
import type { V3 } from "./path";

/** The view: pixels for one scene unit at depth 1, and the principal point in pixels. */
export interface FitView {
  sf: number;
  cx: number;
  cy: number;
}

export interface FitRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FitOptions {
  margin: number;
  minDist: number;
  maxDist: number;
}

export interface FitResult {
  dist: number;
  target: V3;
  /** every point lies inside the free rectangle less the margin */
  inside: boolean;
}

const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a: V3): V3 => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const add = (a: V3, b: V3, k = 1): V3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });

/** The screen axes of a camera that looks along -dir with the world up axis: right, up and the view direction. */
export function viewAxes(dir: V3): { right: V3; up: V3; back: V3 } {
  const back = norm(dir);
  let right = { x: back.z, y: 0, z: -back.x };
  if (Math.hypot(right.x, right.y, right.z) < 1e-6) right = { x: 1, y: 0, z: 0 };
  right = norm(right);
  const up = { x: back.y * right.z - back.z * right.y, y: back.z * right.x - back.x * right.z, z: back.x * right.y - back.y * right.x };
  return { right, up: norm(up), back };
}

/** A point on the screen, in pixels from the top left of the canvas, or null where it lies behind the camera. */
export function projectToScreen(p: V3, dir: V3, target: V3, dist: number, view: FitView): { x: number; y: number; depth: number } | null {
  const { right, up, back } = viewAxes(dir);
  const rel = { x: p.x - target.x, y: p.y - target.y, z: p.z - target.z };
  const depth = dist - dot(rel, back);
  if (depth < 1) return null;
  return { x: view.cx + (view.sf * dot(rel, right)) / depth, y: view.cy - (view.sf * dot(rel, up)) / depth, depth };
}

/** The distance and target at which the points, seen from `dir`, fill the free rectangle less the margin, and all lie inside it. */
export function fitPathCamera(points: V3[], dir: V3, view: FitView, free: FitRect, opts: FitOptions): FitResult {
  const inner = { left: free.left + opts.margin, top: free.top + opts.margin, right: free.right - opts.margin, bottom: free.bottom - opts.margin };
  const w = Math.max(10, inner.right - inner.left);
  const h = Math.max(10, inner.bottom - inner.top);
  const wantX = (inner.left + inner.right) / 2;
  const wantY = (inner.top + inner.bottom) / 2;
  const { right, up, back } = viewAxes(dir);
  if (!points.length) return { dist: opts.minDist, target: { x: 0, y: 0, z: 0 }, inside: true };
  // a long path is sampled for the search and checked in full at the end
  const stride = Math.max(1, Math.floor(points.length / 3000));
  const sample = points.filter((_, i) => i % stride === 0);
  let lo = { x: Infinity, y: Infinity, z: Infinity };
  let hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    const c = { x: dot(p, right), y: dot(p, up), z: dot(p, back) };
    lo = { x: Math.min(lo.x, c.x), y: Math.min(lo.y, c.y), z: Math.min(lo.z, c.z) };
    hi = { x: Math.max(hi.x, c.x), y: Math.max(hi.y, c.y), z: Math.max(hi.z, c.z) };
  }
  let target: V3 = add(add({ x: 0, y: 0, z: 0 }, right, (lo.x + hi.x) / 2), up, (lo.y + hi.y) / 2);
  target = add(target, back, (lo.z + hi.z) / 2);
  const depthSpan = hi.z - lo.z;
  let dist = Math.min(opts.maxDist, Math.max(opts.minDist, (Math.max((hi.x - lo.x) * view.sf / w, (hi.y - lo.y) * view.sf / h) + depthSpan / 2) * 1.1));

  const box = (list: V3[]): { x0: number; x1: number; y0: number; y1: number; behind: boolean } => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let behind = false;
    for (const p of list) {
      const s = projectToScreen(p, dir, target, dist, view);
      if (!s) {
        behind = true;
        continue;
      }
      x0 = Math.min(x0, s.x);
      x1 = Math.max(x1, s.x);
      y0 = Math.min(y0, s.y);
      y1 = Math.max(y1, s.y);
    }
    return { x0, x1, y0, y1, behind };
  };

  for (let pass = 0; pass < 60; pass += 1) {
    const b = box(sample);
    if (b.behind) {
      dist = Math.min(opts.maxDist, dist * 1.25);
      continue;
    }
    // the target moves so that the middle of the projected box lands on the middle of the free area, and the distance follows the larger ratio
    const depth = Math.max(10, dist);
    target = add(target, right, (((b.x0 + b.x1) / 2 - wantX) * depth) / view.sf);
    target = add(target, up, (-((b.y0 + b.y1) / 2 - wantY) * depth) / view.sf);
    const need = Math.max((b.x1 - b.x0) / w, (b.y1 - b.y0) / h);
    dist = Math.max(opts.minDist, Math.min(opts.maxDist, dist * (1 + (need - 1) * 0.8)));
  }

  const fits = (): boolean => {
    for (const p of points) {
      const s = projectToScreen(p, dir, target, dist, view);
      if (!s || s.x < inner.left - 0.5 || s.x > inner.right + 0.5 || s.y < inner.top - 0.5 || s.y > inner.bottom + 0.5) return false;
    }
    return true;
  };
  // a point that is still outside is brought in by standing back, and by centring the full set once more
  for (let guard = 0; guard < 200 && !fits(); guard += 1) {
    const b = box(points);
    if (!b.behind) {
      const depth = Math.max(10, dist);
      target = add(target, right, (((b.x0 + b.x1) / 2 - wantX) * depth) / view.sf);
      target = add(target, up, (-((b.y0 + b.y1) / 2 - wantY) * depth) / view.sf);
    }
    if (dist >= opts.maxDist) break;
    dist = Math.min(opts.maxDist, dist * 1.015);
  }
  return { dist, target, inside: fits() };
}
