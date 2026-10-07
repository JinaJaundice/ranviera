// The callouts of the region captions (docs/BRAIN.md, "Callouts"). Each region has a small dot at the edge of its visible
// neurons, a caption in a column to the left or right of the brain (the side of the dot from the centre of the brain on
// screen), and a leader between the two that runs horizontally from the caption to the x of the dot and then vertically to
// it, as in an anatomy plate. The captions stand outside the silhouette of the brain (the convex hull of its projected
// points), are ordered by the height of their dots so that the leaders do not cross, and keep a gap between them. Pure, and
// tested in callouts.test.ts.
import type { Safe } from "./labelplace";

export interface Pt {
  x: number;
  y: number;
}

interface Box {
  left: number;
  top: number;
  w: number;
  h: number;
}

export interface CalloutRequest {
  key: string;
  /** the dot: the centre of the region's visible neurons on screen */
  x: number;
  y: number;
  /** the size of the caption box in pixels */
  w: number;
  h: number;
  /** the point of the region's neurons nearest to each column, so that a leader ends on the edge of the region that faces its caption */
  edge?: { left: Pt; right: Pt };
}

export interface PlacedCallout extends Box {
  key: string;
  side: "left" | "right";
  dot: Pt;
  /** the point of the caption box where the leader line starts */
  join: Pt;
  /** the leader: from the caption horizontally to the x of the dot, then at most one vertical segment to the dot (as in an anatomy plate) */
  path: Pt[];
}

export interface CalloutOptions {
  width: number;
  height: number;
  safe: Safe;
  /** boxes that other parts of the window cover (the control group, the thought trail) */
  blocked?: Box[];
  /** the least space between 2 callouts */
  gap?: number;
  /** the least space between a callout and the silhouette */
  clearance?: number;
  /** puts every callout in the one column (a focus keeps its caption on the side of the free area that the framing leaves) */
  only?: "left" | "right";
}

/** The convex hull of a set of points, counter clockwise in a y-up frame (monotone chain). */
export function convexHull(points: Pt[]): Pt[] {
  const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i -= 1) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** True when the 2 segments cross at a point that is inside both. Segments that only touch at an end do not count. */
export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const side = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function inPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** True when the box and the polygon share any area. */
export function boxHitsPolygon(box: Box, poly: Pt[], pad = 0): boolean {
  const l = box.left - pad;
  const t = box.top - pad;
  const r = box.left + box.w + pad;
  const b = box.top + box.h + pad;
  const corners: Pt[] = [
    { x: l, y: t },
    { x: r, y: t },
    { x: r, y: b },
    { x: l, y: b },
  ];
  if (poly.some((p) => p.x > l && p.x < r && p.y > t && p.y < b)) return true;
  if (corners.some((c) => inPolygon(c, poly))) return true;
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    for (let k = 0; k < 4; k += 1) if (segmentsCross(p, q, corners[k], corners[(k + 1) % 4])) return true;
  }
  return false;
}

/** The smallest and largest x of the polygon within the band from y0 to y1. */
export function extentX(poly: Pt[], y0: number, y1: number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  const take = (x: number) => {
    if (x < min) min = x;
    if (x > max) max = x;
  };
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    if (p.y >= y0 && p.y <= y1) take(p.x);
    for (const y of [y0, y1]) {
      if ((p.y - y) * (q.y - y) < 0) take(p.x + ((q.x - p.x) * (y - p.y)) / (q.y - p.y));
    }
  }
  return { min, max };
}

/** The tops of boxes of the given heights, each at its wanted top, in the given order, with a gap and inside the bounds. */
function stack(wanted: number[], heights: number[], lo: number, hi: number, gap: number, forbidden: [number, number][]): number[] {
  const n = wanted.length;
  const tops = wanted.slice();
  const clear = (i: number, dir: 1 | -1) => {
    for (let pass = 0; pass < forbidden.length + 1; pass += 1) {
      for (const [a, b] of forbidden) {
        if (tops[i] < b && tops[i] + heights[i] > a) tops[i] = dir === 1 ? b + gap : a - gap - heights[i];
      }
    }
  };
  for (let i = 0; i < n; i += 1) {
    tops[i] = Math.max(tops[i], lo, i ? tops[i - 1] + heights[i - 1] + gap : lo);
    clear(i, 1);
    if (i) tops[i] = Math.max(tops[i], tops[i - 1] + heights[i - 1] + gap);
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    const limit = i === n - 1 ? hi - heights[i] : tops[i + 1] - gap - heights[i];
    if (tops[i] > limit) {
      tops[i] = limit;
      clear(i, -1);
      if (i < n - 1) tops[i] = Math.min(tops[i], tops[i + 1] - gap - heights[i]);
    }
  }
  return tops;
}

interface Row {
  req: CalloutRequest;
  top: number;
  left: number;
}

function place(order: CalloutRequest[], side: "left" | "right", hull: Pt[], o: Required<Omit<CalloutOptions, "blocked" | "only">> & { blocked: Box[] }): Row[] {
  const heights = order.map((r) => r.h);
  const lo = o.safe.top;
  const hi = o.height - o.safe.bottom;
  const columnX = (r: CalloutRequest, top: number): number => {
    const e = extentX(hull, top - o.clearance, top + r.h + o.clearance);
    if (!Number.isFinite(e.min)) return side === "left" ? o.safe.left : o.width - o.safe.right - r.w;
    return side === "left" ? Math.max(o.safe.left, e.min - o.clearance - r.w) : Math.min(o.width - o.safe.right - r.w, e.max + o.clearance);
  };
  const wanted = order.map((r) => r.y - r.h / 2);
  let tops = stack(wanted, heights, lo, hi, o.gap, []);
  let rows = order.map((req, i) => ({ req, top: tops[i], left: columnX(req, tops[i]) }));
  // a box that another part of the window covers is moved to the free part of the column
  const forbidden: [number, number][] = [];
  for (const b of o.blocked) {
    if (rows.some((r) => r.left < b.left + b.w && b.left < r.left + r.req.w && r.top < b.top + b.h && b.top < r.top + r.req.h)) forbidden.push([b.top, b.top + b.h]);
  }
  if (forbidden.length) {
    tops = stack(wanted, heights, lo, hi, o.gap, forbidden);
    rows = order.map((req, i) => ({ req, top: tops[i], left: columnX(req, tops[i]) }));
  }
  return rows;
}

const join = (row: Row, side: "left" | "right"): Pt => ({ x: side === "left" ? row.left + row.req.w : row.left, y: row.top + row.req.h / 2 });

/** True when the segment passes through the box. */
export function segmentHitsBox(a: Pt, b: Pt, box: Box): boolean {
  const inside = (p: Pt) => p.x > box.left && p.x < box.left + box.w && p.y > box.top && p.y < box.top + box.h;
  if (inside(a) || inside(b)) return true;
  const c: Pt[] = [
    { x: box.left, y: box.top },
    { x: box.left + box.w, y: box.top },
    { x: box.left + box.w, y: box.top + box.h },
    { x: box.left, y: box.top + box.h },
  ];
  return c.some((p, k) => segmentsCross(a, b, p, c[(k + 1) % 4]));
}

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) yield [items[i], ...tail];
  }
}

const pathOf = (row: Row, side: "left" | "right"): Pt[] => {
  const j = join(row, side);
  const d = row.req;
  if (Math.abs(j.y - d.y) < 0.5) return [j, { x: d.x, y: j.y }];
  return [j, { x: d.x, y: j.y }, { x: d.x, y: d.y }];
};

function pathsCross(a: Pt[], b: Pt[]): boolean {
  for (let i = 0; i + 1 < a.length; i += 1) for (let k = 0; k + 1 < b.length; k += 1) if (segmentsCross(a[i], a[i + 1], b[k], b[k + 1])) return true;
  return false;
}

function pathHitsBox(a: Pt[], box: Box): boolean {
  for (let i = 0; i + 1 < a.length; i += 1) if (segmentHitsBox(a[i], a[i + 1], box)) return true;
  return false;
}

const boxOf = (r: Row): Box => ({ left: r.left, top: r.top, w: r.req.w, h: r.req.h });

/** The total length of the leaders of a column, with a heavy charge for each pair that crosses, each leader through a box and each swap of the height order. */
function leaderCost(rows: Row[], side: "left" | "right", blocked: Box[]): number {
  let cost = 0;
  const paths = rows.map((r) => pathOf(r, side));
  for (let i = 0; i < rows.length; i += 1) {
    for (let k = 0; k + 1 < paths[i].length; k += 1) cost += Math.abs(paths[i][k + 1].x - paths[i][k].x) + Math.abs(paths[i][k + 1].y - paths[i][k].y);
    for (const b of blocked) if (pathHitsBox(paths[i], b)) cost += 1e4;
    for (let k = 0; k < rows.length; k += 1) {
      if (k === i) continue;
      // the first segment starts on the edge of the own box, so the others are tested against the rest
      if (pathHitsBox(paths[i], boxOf(rows[k]))) cost += 1e4;
    }
    for (let k = i + 1; k < rows.length; k += 1) {
      if (pathsCross(paths[i], paths[k])) cost += 1e5;
      if (rows[i].req.y > rows[k].req.y) cost += 1e3;
    }
  }
  return cost;
}

/**
 * Lay out the callouts. A region goes to the left column when its dot lies left of the centre of the brain on screen and to
 * the right column otherwise. Each column is ordered by the height of the dots, and the order with the shortest leaders that
 * cross none is kept (a column of 7 or fewer is tried in every order, a longer one by swaps).
 */
export function layoutCallouts(requests: CalloutRequest[], hull: Pt[], options: CalloutOptions): PlacedCallout[] {
  const o = { gap: 6, clearance: 18, blocked: [], ...options };
  const xs = hull.map((p) => p.x);
  const centreX = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : o.width / 2;
  const out: PlacedCallout[] = [];
  for (const side of ["left", "right"] as const) {
    const members = requests
      .filter((r) => (o.only ?? (r.x < centreX ? "left" : "right")) === side)
      .map((r) => (r.edge ? { ...r, x: r.edge[side].x, y: r.edge[side].y } : r));
    const sorted = members.slice().sort((a, b) => a.y - b.y || (a.key < b.key ? -1 : 1));
    let order = sorted;
    let rows = place(order, side, hull, o);
    if (sorted.length <= 7) {
      let best = Infinity;
      for (const perm of permutations(sorted)) {
        const cand = place(perm, side, hull, o);
        const cost = leaderCost(cand, side, o.blocked);
        if (cost < best) {
          best = cost;
          rows = cand;
        }
      }
    } else {
      for (let pass = 0; pass < 40; pass += 1) {
        const paths = rows.map((r) => pathOf(r, side));
        let swap: [number, number] | null = null;
        for (let i = 0; i < rows.length && !swap; i += 1) {
          for (let j = i + 1; j < rows.length; j += 1) {
            if (pathsCross(paths[i], paths[j])) {
              swap = [i, j];
              break;
            }
          }
        }
        if (!swap) break;
        order = order.slice();
        [order[swap[0]], order[swap[1]]] = [order[swap[1]], order[swap[0]]];
        rows = place(order, side, hull, o);
      }
    }
    for (const r of rows) out.push({ key: r.req.key, left: r.left, top: r.top, w: r.req.w, h: r.req.h, side, dot: { x: r.req.x, y: r.req.y }, join: join(r, side), path: pathOf(r, side) });
  }
  return out;
}

export interface FocusCalloutOptions {
  width: number;
  height: number;
  safe: Safe;
  blocked?: Box[];
  /** the least space between the caption and a neuron or a covered box (default 12) */
  clearance?: number;
  /** the radius of a neuron in pixels, added to the clearance */
  radius?: number;
  /** the area that a leader may end in: a neuron outside it is not a target (the canvas less its safe margins by default) */
  view?: Box;
}

const gapToBox = (p: Pt, b: Box): number => Math.hypot(Math.max(b.left - p.x, 0, p.x - (b.left + b.w)), Math.max(b.top - p.y, 0, p.y - (b.top + b.h)));

/**
 * The caption of a focused region. It goes in the free margin beside the framed neurons, at the height of the region where it
 * can, and when no margin is wide enough at the top left of the free area. It stays at least `clearance` pixels (and the radius
 * of a neuron) from every neuron and covered box. The leader is orthogonal and ends on the neuron nearest to the caption.
 */
export function layoutFocusCallout(req: CalloutRequest, neurons: Pt[], o: FocusCalloutOptions): PlacedCallout {
  const clearance = (o.clearance ?? 12) + (o.radius ?? 4);
  const blocked = o.blocked ?? [];
  const minTop = o.safe.top;
  const maxTop = Math.max(minTop, o.height - o.safe.bottom - req.h);
  const minLeft = o.safe.left;
  const maxLeft = Math.max(minLeft, o.width - o.safe.right - req.w);
  const fits = (left: number, top: number): boolean => {
    const box = { left, top, w: req.w, h: req.h };
    if (blocked.some((b) => box.left < b.left + b.w + 12 && b.left < box.left + box.w + 12 && box.top < b.top + b.h + 12 && b.top < box.top + box.h + 12)) return false;
    for (const n of neurons) if (gapToBox(n, box) < clearance) return false;
    return true;
  };
  let at: { left: number; top: number } | null = null;
  // the margin: the left edge of the free area, from the height of the region outwards
  const want = Math.min(maxTop, Math.max(minTop, req.y - req.h / 2));
  const ys: number[] = [];
  for (let d = 0; want - d >= minTop || want + d <= maxTop; d += 8) {
    if (want + d <= maxTop) ys.push(want + d);
    if (d && want - d >= minTop) ys.push(want - d);
  }
  for (const top of ys) {
    if (fits(minLeft, top)) {
      at = { left: minLeft, top };
      break;
    }
  }
  // no margin is wide enough: the top left of the free area, moved right and down until it is clear
  if (!at) {
    scan: for (let top = minTop; top <= maxTop; top += 8) {
      for (let left = minLeft; left <= maxLeft; left += 8) {
        if (fits(left, top)) {
          at = { left, top };
          break scan;
        }
      }
    }
  }
  const spot = at ?? { left: minLeft, top: minTop };
  const row = { req, top: spot.top, left: spot.left };
  const j = join(row, "left");
  // the target is the nearest neuron (by the length of the 2 legs) that stands right of the caption and in view
  const view = o.view ?? { left: o.safe.left, top: o.safe.top, w: o.width - o.safe.left - o.safe.right, h: o.height - o.safe.top - o.safe.bottom };
  let target: Pt = { x: req.x, y: req.y };
  let best = Infinity;
  for (const n of neurons) {
    if (n.x <= j.x || n.x < view.left || n.x > view.left + view.w || n.y < view.top || n.y > view.top + view.h) continue;
    const d = Math.abs(n.x - j.x) + Math.abs(n.y - j.y);
    if (d < best) {
      best = d;
      target = n;
    }
  }
  const path: Pt[] = Math.abs(j.y - target.y) < 0.5 ? [j, { x: target.x, y: j.y }] : [j, { x: target.x, y: j.y }, { x: target.x, y: target.y }];
  return { key: req.key, left: spot.left, top: spot.top, w: req.w, h: req.h, side: "left", dot: { x: target.x, y: target.y }, join: j, path };
}

/** The boxes that a label keeps out of: the callout and each segment of its leader, each grown by `gap` pixels. */
export function keepOutBoxes(callout: Box, path: Pt[], gap: number): Box[] {
  const out: Box[] = [{ left: callout.left - gap, top: callout.top - gap, w: callout.w + 2 * gap, h: callout.h + 2 * gap }];
  for (let i = 0; i + 1 < path.length; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    out.push({ left: Math.min(a.x, b.x) - gap, top: Math.min(a.y, b.y) - gap, w: Math.abs(a.x - b.x) + 2 * gap, h: Math.abs(a.y - b.y) + 2 * gap });
  }
  return out;
}
