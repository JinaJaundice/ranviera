// Cortex's own layered layout for the plan map (no layout library), and the pan and zoom arithmetic of the plan popup.
// A node is placed in the row of its longest path from a node with no prerequisite, rows are ordered to shorten the edges,
// and each node takes the width of its wrapped title. Edges leave the foot of the prerequisite and enter the head of the
// node that follows, and an edge that spans several rows is routed through the rows between.
import type { PlanEdge, PlanNode } from "@shared/learn/sessions";

export const NODE_SEP = 24;
export const RANK_SEP = 48;
export const WRAP_AT = 28;
export const MIN_W = 96;
export const MIN_H = 44;
export const PAD_X = 16;
export const ARROW_GAP = 4;

const NARROW = new Set("ijlt1fI.,;:'!|() ");
const WIDE = new Set("mwMW@");

/** Pixels for one line of 11 pixel text, by the class of each character. */
export function lineWidth(line: string): number {
  let total = 0;
  for (const char of Array.from(line)) {
    let step = 5.4;
    if (NARROW.has(char)) step = 3.1;
    else if (WIDE.has(char)) step = 9.2;
    else if (/[A-Z0-9]/.test(char)) step = 6;
    total += step;
  }
  return total;
}

/** Greedy wrap at a number of characters. A word longer than the limit is cut, and nothing is dropped. */
export function wrapTitle(title: string, limit = WRAP_AT): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (let w of words) {
    while (w.length > limit) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      lines.push(w.slice(0, limit));
      w = w.slice(limit);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= limit) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

export function nodeSize(lines: string[]): { w: number; h: number } {
  const text = Math.max(...lines.map(lineWidth));
  return { w: Math.max(MIN_W, Math.ceil(text + PAD_X * 2)), h: MIN_H + 13 * Math.max(0, lines.length - 2) };
}

export interface LayoutNode {
  id: string;
  title: string;
  lines: string[];
  rank: number;
  /** the centre and the top edge */
  cx: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  d: string;
  points: { x: number; y: number }[];
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

function ranks(nodes: PlanNode[], edges: PlanEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const preds = new Map<string, string[]>();
  for (const e of edges) if (ids.has(e.from) && ids.has(e.to) && e.from !== e.to) preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const rank = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // a cycle cannot occur in a valid plan, and this keeps a bad one from looping
    visiting.add(id);
    const r = (preds.get(id) ?? []).reduce((m, p) => Math.max(m, rank(p) + 1), 0);
    visiting.delete(id);
    memo.set(id, r);
    return r;
  };
  for (const n of nodes) rank(n.id);
  return memo;
}

/** A smooth path through the points, with a vertical tangent at each one. */
export function pathOf(points: { x: number; y: number }[]): string {
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    const mid = (q.y - p.y) / 2;
    d += ` C ${p.x} ${p.y + mid} ${q.x} ${q.y - mid} ${q.x} ${q.y}`;
  }
  return d;
}

export function layoutPlan(nodesIn: PlanNode[], edgesIn: PlanEdge[]): Layout {
  const ids = new Set(nodesIn.map((n) => n.id));
  const edges = edgesIn.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const rankOf = ranks(nodesIn, edges);
  const rows: LayoutNode[][] = [];
  const byId = new Map<string, LayoutNode>();
  for (const n of nodesIn) {
    const lines = wrapTitle(n.title);
    const size = nodeSize(lines);
    const ln: LayoutNode = { id: n.id, title: n.title, lines, rank: rankOf.get(n.id) ?? 0, cx: 0, y: 0, ...size };
    (rows[ln.rank] ??= []).push(ln);
    byId.set(n.id, ln);
  }
  for (let r = 0; r < rows.length; r++) rows[r] ??= [];

  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
  }
  // order each row by the mean position of its neighbours in the rows next to it
  const order = new Map<string, number>();
  const setOrder = () => rows.forEach((row) => row.forEach((n, i) => order.set(n.id, i)));
  setOrder();
  for (let pass = 0; pass < 4; pass++) {
    const seq = pass % 2 === 0 ? rows.map((_, i) => i) : rows.map((_, i) => rows.length - 1 - i);
    for (const r of seq) {
      const row = rows[r];
      const score = new Map<string, number>();
      for (const n of row) {
        const ns = (neighbours.get(n.id) ?? []).filter((id) => (byId.get(id)?.rank ?? r) !== r);
        score.set(n.id, ns.length ? ns.reduce((s, id) => s + (order.get(id) ?? 0), 0) / ns.length : (order.get(n.id) ?? 0));
      }
      row.sort((a, b) => (score.get(a.id) ?? 0) - (score.get(b.id) ?? 0) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      row.forEach((n, i) => order.set(n.id, i));
    }
  }

  // place the rows: centre each row, then pull nodes towards their neighbours without breaking the separation
  rows.forEach((row) => {
    const total = row.reduce((s, n) => s + n.w, 0) + NODE_SEP * Math.max(0, row.length - 1);
    let x = -total / 2;
    for (const n of row) {
      n.cx = x + n.w / 2;
      x += n.w + NODE_SEP;
    }
  });
  for (let pass = 0; pass < 6; pass++) {
    for (const row of rows) {
      if (row.length === 0) continue;
      const want = row.map((n) => {
        const ns = (neighbours.get(n.id) ?? []).map((id) => byId.get(id)).filter((m): m is LayoutNode => !!m && m.rank !== n.rank);
        return ns.length ? ns.reduce((s, m) => s + m.cx, 0) / ns.length : n.cx;
      });
      const placed = row.map((n, i) => want[i] ?? n.cx);
      for (let i = 1; i < row.length; i++) placed[i] = Math.max(placed[i], placed[i - 1] + (row[i - 1].w + row[i].w) / 2 + NODE_SEP);
      const shift = row.reduce((s, _n, i) => s + (want[i] - placed[i]), 0) / row.length;
      row.forEach((n, i) => (n.cx = placed[i] + shift));
    }
  }

  let y = 0;
  for (const row of rows) {
    const h = row.reduce((m, n) => Math.max(m, n.h), 0);
    for (const n of row) n.y = y + (h - n.h) / 2;
    y += h + RANK_SEP;
  }
  const all = [...byId.values()];
  const rowTop = rows.map((row) => (row.length ? Math.min(...row.map((n) => n.y)) : 0));

  const out: LayoutEdge[] = edges.map((e) => {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    const points = [{ x: a.cx, y: a.y + a.h }];
    for (let r = a.rank + 1; r < b.rank; r++) {
      const t = (r - a.rank) / (b.rank - a.rank);
      let x = a.cx + (b.cx - a.cx) * t;
      const my = rowTop[r] + 1;
      for (const n of rows[r] ?? []) {
        if (Math.abs(x - n.cx) < n.w / 2 + 12) x = n.cx + n.w / 2 + 16;
      }
      points.push({ x, y: my });
    }
    points.push({ x: b.cx, y: b.y - ARROW_GAP });
    return { from: e.from, to: e.to, d: pathOf(points), points };
  });

  const xs = [...all.flatMap((n) => [n.cx - n.w / 2, n.cx + n.w / 2]), ...out.flatMap((e) => e.points.map((p) => p.x))];
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) : 0;
  const pad = 12;
  const dx = pad - minX;
  for (const n of all) n.cx += dx;
  for (const e of out) {
    e.points.forEach((p) => (p.x += dx));
    e.d = pathOf(e.points);
  }
  return { nodes: all, edges: out, width: Math.max(0, maxX - minX) + pad * 2, height: Math.max(0, y - RANK_SEP) + pad * 2 + ARROW_GAP };
}

/* Pan and zoom -------------------------------------------------------------------------------------------------- */

export const MAX_ZOOM = 4;
export const FIT_PADDING = 16;
export const FIT_CEILING = 1.5;
export const ZOOM_FLOOR_MIN = 0.02;

export interface Size {
  w: number;
  h: number;
}
export interface View {
  x: number;
  y: number;
  k: number;
}

/** The zoom at which the whole box fits the viewport with padding, never above 1.5 so that a small plan is not blown up. */
export function fitZoomFor(box: Size, vp: Size): number {
  if (vp.w <= 0 || vp.h <= 0 || box.w <= 0 || box.h <= 0) return 1;
  return Math.max(ZOOM_FLOOR_MIN, Math.min((vp.w - FIT_PADDING * 2) / box.w, (vp.h - FIT_PADDING * 2) / box.h, FIT_CEILING));
}

/** The view that centres the box at a zoom. */
export function fitView(box: Size, vp: Size, k: number): View {
  return { k, x: (vp.w - box.w * k) / 2, y: (vp.h - box.h * k) / 2 };
}

/** A wheel step around a point. The zoom stays between the floor and the maximum. At the floor the box is centred, because there is nothing to move. */
export function zoomedView(view: View, factor: number, floor: number, focus: { x: number; y: number }, box: Size, vp: Size): View {
  const k = Math.min(MAX_ZOOM, Math.max(floor, view.k * factor));
  if (k === view.k) return view;
  if (k <= floor) return fitView(box, vp, floor);
  const ratio = k / view.k;
  return { k, x: focus.x - (focus.x - view.x) * ratio, y: focus.y - (focus.y - view.y) * ratio };
}
