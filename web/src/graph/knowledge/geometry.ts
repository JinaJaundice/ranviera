// The geometry of the Knowledge layer: the camera, hulls, junctions, arrowheads, picking and seeding. Everything here is
// pure, so that it is tested without a canvas. World units are those of the positions that the server stores.

export interface Pt {
  x: number;
  y: number;
}

/** screen = world * k + (x, y) */
export interface Camera {
  x: number;
  y: number;
  k: number;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const MAX_FIT_ZOOM = 4;
export const MAX_ZOOM = 24;

export function toScreen(cam: Camera, p: Pt): Pt {
  return { x: p.x * cam.k + cam.x, y: p.y * cam.k + cam.y };
}

export function toWorld(cam: Camera, p: Pt): Pt {
  return { x: (p.x - cam.x) / cam.k, y: (p.y - cam.y) / cam.k };
}

export function boundsOf(points: Pt[]): Box | null {
  if (!points.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The camera that centres a box in a viewport with padding. The scale binds on the axis that runs out of room, is capped at
 * `MAX_FIT_ZOOM`, and is never zero or negative: a viewport with no size reads as a scale of 1.
 */
export function fitCamera(box: Box | null, width: number, height: number, pad = 48): Camera {
  if (!box || width <= 0 || height <= 0) return { x: Math.max(0, width) / 2, y: Math.max(0, height) / 2, k: 1 };
  const w = Math.max(box.maxX - box.minX, 1e-6);
  const h = Math.max(box.maxY - box.minY, 1e-6);
  const availW = Math.max(width - pad * 2, 1);
  const availH = Math.max(height - pad * 2, 1);
  const k = Math.min(Math.max(Math.min(availW / w, availH / h), 1e-6), MAX_FIT_ZOOM);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  return { x: width / 2 - cx * k, y: height / 2 - cy * k, k };
}

/**
 * Zooms by a factor and keeps the world point under `focus` (a screen point) where it is. The scale stops at `floor` (the
 * fitted scale, so the reader cannot lose the graph) and at `ceiling`. A factor that changes nothing returns the same object.
 */
export function zoomAt(cam: Camera, factor: number, focus: Pt, floor: number, ceiling = MAX_ZOOM): Camera {
  const lo = Math.max(floor, 1e-6);
  const k = Math.min(Math.max(cam.k * factor, lo), Math.max(ceiling, lo));
  if (k === cam.k) return cam;
  const world = toWorld(cam, focus);
  return { k, x: focus.x - world.x * k, y: focus.y - world.y * k };
}

export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, x: cam.x + dx, y: cam.y + dy };
}

/** How far the camera is from the fit: 1 at the fit, below 1 when zoomed in and above 1 when zoomed out. */
export function zoomRatio(cam: Camera, fitK: number): number {
  return cam.k > 0 ? fitK / cam.k : 1;
}

/**
 * One gate fades the claim labels in and the cluster names out over the same span, so that the two never show together. The
 * gate is a ratio from the render settings, and the span is proportional to it. Returns the opacity of the claim labels.
 */
export function labelAlpha(ratio: number, gate: number): number {
  const span = Math.max(gate * 0.5, 1e-6);
  const a = (gate + span / 2 - ratio) / span;
  return Math.min(Math.max(a, 0), 1);
}

export function clusterAlpha(ratio: number, gate: number): number {
  return 1 - labelAlpha(ratio, gate);
}

/** Andrew's monotone chain. Collinear points are dropped, and fewer than three distinct points return what is left. */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y).filter((p, i, a) => i === 0 || p.x !== a[i - 1].x || p.y !== a[i - 1].y);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export const MIN_CLUSTER_MEMBERS = 3;

/**
 * The outline of a cluster: the hull of a small circle drawn around each member, so that the outline stands off the nodes by
 * `pad` and has rounded corners. A cluster of fewer than three members has no hull.
 */
export function clusterHull(members: Pt[], pad: number): Pt[] | null {
  if (members.length < MIN_CLUSTER_MEMBERS) return null;
  const ring: Pt[] = [];
  const steps = 10;
  for (const m of members) {
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      ring.push({ x: m.x + Math.cos(a) * pad, y: m.y + Math.sin(a) * pad });
    }
  }
  const hull = convexHull(ring);
  return hull.length >= 3 ? hull : null;
}

export function centroid(points: Pt[]): Pt {
  if (!points.length) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/** The point inside a polygon test, used to pick a cluster name. */
export function insidePolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A stable small number from a text, for the choice of a cluster colour. */
export function hashText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const CLUSTER_TOKENS = [
  "--color-fam-instruction",
  "--color-fam-machinery",
  "--color-fam-record",
  "--color-fam-work",
  "--color-fam-world",
  "--color-fam-language",
] as const;

/** The token of a cluster, one of the six family tokens chosen by a stable hash of the cluster id. */
export function clusterToken(id: string): (typeof CLUSTER_TOKENS)[number] {
  return CLUSTER_TOKENS[hashText(id) % CLUSTER_TOKENS.length];
}

/**
 * Where the junction of a multi premise argument sits: halfway between the middle of its premises and its conclusion, so that
 * the joint lines converge on it and one line leaves it.
 */
export function junctionPoint(premises: Pt[], conclusion: Pt): Pt {
  const c = centroid(premises);
  return { x: (c.x + conclusion.x) / 2, y: (c.y + conclusion.y) / 2 };
}

export interface Arrow {
  /** where the shaft starts, outside the source disc */
  tail: Pt;
  /** the point of the head, on the edge of the target disc */
  tip: Pt;
  left: Pt;
  right: Pt;
}

/** The shaft and head of an arrow between two discs. Coincident ends, or ends inside each other, give no arrow. */
export function arrowGeometry(from: Pt, to: Pt, rFrom: number, rTo: number, headLength: number, headWidth = headLength * 0.7): Arrow | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9 || d <= rFrom + rTo) return null;
  const ux = dx / d;
  const uy = dy / d;
  const tail = { x: from.x + ux * rFrom, y: from.y + uy * rFrom };
  const tip = { x: to.x - ux * rTo, y: to.y - uy * rTo };
  const base = { x: tip.x - ux * headLength, y: tip.y - uy * headLength };
  const nx = -uy * (headWidth / 2);
  const ny = ux * (headWidth / 2);
  return { tail, tip, left: { x: base.x + nx, y: base.y + ny }, right: { x: base.x - nx, y: base.y - ny } };
}

export interface Pickable {
  id: string;
  x: number;
  y: number;
  r: number;
  kind: "proposition" | "junction";
}

/** The nearest claim whose disc, widened by `pad`, holds the point. A junction is never picked. A tie goes to the smaller id. */
export function pickNode(nodes: Pickable[], p: Pt, pad: number): string | null {
  let best: { id: string; d: number } | null = null;
  for (const n of nodes) {
    if (n.kind !== "proposition") continue;
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d > n.r + pad) continue;
    if (!best || d < best.d || (d === best.d && n.id < best.id)) best = { id: n.id, d };
  }
  return best ? best.id : null;
}

/**
 * Positions for the nodes that the server has none for: on a ring around the middle of the known ones, at an angle taken from
 * a hash of the id. A known position is returned untouched, and nothing missing returns the same object.
 */
export function seedPositions(ids: string[], known: Record<string, Pt>): Record<string, Pt> {
  const missing = ids.filter((id) => !known[id]);
  if (!missing.length) return known;
  const centre = centroid(Object.values(known));
  const radius = Math.max(60, Math.sqrt(ids.length) * 24);
  const out: Record<string, Pt> = { ...known };
  for (const id of missing) {
    const a = ((hashText(id) % 3600) / 3600) * Math.PI * 2;
    out[id] = { x: centre.x + Math.cos(a) * radius, y: centre.y + Math.sin(a) * radius };
  }
  return out;
}
