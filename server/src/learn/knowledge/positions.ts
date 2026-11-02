// Resting layout of the knowledge graph. One d3-force engine with fixed forces
// serves the settle after each merge, and the browser uses the same forces for
// the live view. The layout is deterministic: seeds derive from the node id, and
// the simulation runs a fixed number of ticks. docs/CONTRACTS.md, "Positions
// and render settings".

import { createHash } from "node:crypto";
import { forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import type { PositionsFile, RenderSettings } from "../../../../shared/learn/knowledge.ts";

export type Point = { x: number; y: number };
export type PositionMap = Record<string, Point>;

export const COORDINATE_LIMIT = 1_000_000;
export const SETTLE_TICKS = 300;
export const ALPHA_DECAY = 0.0228;
export const ANCHOR_KEEP = 0.85;
export const BOOTSTRAP_GRAVITY = 0.2;
export const BOOTSTRAP_BOX = 100;
export const JITTER = 4;

export interface LayoutInput {
  /** the canvas image: propositions and junctions */
  nodes: { id: string }[];
  /** the canvas arrows */
  links: { from: string; to: string }[];
  /** premise to conclusion over propositions, for the depth pass */
  logicalEdges: { from: string; to: string }[];
  /** one entry for each junction, to place it between its premises and its conclusion in depth */
  impLinks: { id: string; premises: string[]; conclusion: string }[];
  /** node id to cluster id, for the cluster pull */
  clusterOf?: ReadonlyMap<string, string>;
  /** positions that are kept as anchors */
  prior: PositionMap;
  physics: RenderSettings["physics"];
  ticks?: number;
}

/** A number in [0, 1) that depends only on the id and a salt. */
export function unit(id: string, salt: string): number {
  const h = createHash("sha256").update(`${salt}:${id}`).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function finitePoint(p: unknown): p is Point {
  return (
    typeof p === "object" &&
    p !== null &&
    Number.isFinite((p as Point).x) &&
    Number.isFinite((p as Point).y)
  );
}

function clampCoordinate(v: number): number {
  return Math.min(COORDINATE_LIMIT, Math.max(-COORDINATE_LIMIT, v));
}

/** Keeps the ids that are allowed and the values that are finite, clamped to plus or minus 1,000,000. */
export function sanitizePositions(raw: unknown, allowed?: ReadonlySet<string>): PositionMap {
  const out: PositionMap = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
    if (allowed && !allowed.has(id)) continue;
    if (!finitePoint(p)) continue;
    out[id] = { x: clampCoordinate(p.x), y: clampCoordinate(p.y) };
  }
  return out;
}

/** Reads a positions file. A value that is not finite is dropped. */
export function readPositionsFile(raw: unknown): PositionMap {
  if (typeof raw !== "object" || raw === null) return {};
  return sanitizePositions((raw as Partial<PositionsFile>).positions);
}

/** Depth of each proposition: the longest directed path from a base node, with a cycle sharing one depth. */
export function depthRanks(ids: string[], edges: { from: string; to: string }[]): Map<string, number> {
  const idx = new Map(ids.map((id, i) => [id, i]));
  const out: number[][] = ids.map(() => []);
  for (const e of edges) {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) out[a].push(b);
  }
  // iterative Tarjan
  const index = new Array<number>(ids.length).fill(-1);
  const low = new Array<number>(ids.length).fill(0);
  const onStack = new Array<boolean>(ids.length).fill(false);
  const comp = new Array<number>(ids.length).fill(-1);
  const stack: number[] = [];
  const emitted: number[][] = [];
  let counter = 0;
  for (let root = 0; root < ids.length; root++) {
    if (index[root] !== -1) continue;
    const work: { v: number; next: number }[] = [{ v: root, next: 0 }];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame.next < out[frame.v].length) {
        const w = out[frame.v][frame.next++];
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = true;
          work.push({ v: w, next: 0 });
        } else if (onStack[w]) {
          low[frame.v] = Math.min(low[frame.v], index[w]);
        }
        continue;
      }
      if (low[frame.v] === index[frame.v]) {
        const members: number[] = [];
        let w: number;
        do {
          w = stack.pop() as number;
          onStack[w] = false;
          comp[w] = emitted.length;
          members.push(w);
        } while (w !== frame.v);
        emitted.push(members);
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].v;
        low[parent] = Math.min(low[parent], low[frame.v]);
      }
    }
  }
  // Tarjan emits sinks first, so the reverse order is a topological order of the components
  const depth = new Array<number>(emitted.length).fill(0);
  for (let c = emitted.length - 1; c >= 0; c--) {
    for (const v of emitted[c]) {
      for (const w of out[v]) {
        if (comp[w] !== c) depth[comp[w]] = Math.max(depth[comp[w]], depth[c] + 1);
      }
    }
  }
  return new Map(ids.map((id, i) => [id, depth[comp[i]]]));
}

interface SimNode extends SimulationNodeDatum {
  id: string;
}

/** Seeds the nodes that have no anchor. Returns the start points and the extra anchors of the rim. */
function seed(input: LayoutInput, adjacency: Map<string, string[]>): { start: PositionMap; anchors: PositionMap } {
  const ids = input.nodes.map((n) => n.id).sort();
  const anchors: PositionMap = {};
  const start: PositionMap = {};
  for (const id of ids) {
    const p = input.prior[id];
    if (p && finitePoint(p)) {
      anchors[id] = { x: p.x, y: p.y };
      start[id] = { x: p.x, y: p.y };
    }
  }
  const prior = Object.keys(anchors);
  if (prior.length === 0) {
    for (const id of ids) {
      start[id] = { x: (unit(id, "x") - 0.5) * BOOTSTRAP_BOX, y: (unit(id, "y") - 0.5) * BOOTSTRAP_BOX };
    }
    return { start, anchors: {} };
  }
  let pending = ids.filter((id) => !start[id]);
  for (;;) {
    const placed: PositionMap = {};
    for (const id of pending) {
      const near = (adjacency.get(id) ?? []).filter((n) => start[n]);
      if (near.length === 0) continue;
      const mx = near.reduce((s, n) => s + start[n].x, 0) / near.length;
      const my = near.reduce((s, n) => s + start[n].y, 0) / near.length;
      placed[id] = { x: mx + (unit(id, "jx") * 2 - 1) * JITTER, y: my + (unit(id, "jy") * 2 - 1) * JITTER };
    }
    const added = Object.keys(placed);
    if (added.length === 0) break;
    for (const id of added) start[id] = placed[id];
    pending = pending.filter((id) => !placed[id]);
  }
  if (pending.length > 0) {
    const connected = prior.filter((id) => (adjacency.get(id) ?? []).length > 0);
    let rim: number;
    if (connected.length > 0) {
      rim = 1.7 * (connected.reduce((s, id) => s + Math.hypot(anchors[id].x, anchors[id].y), 0) / connected.length) + 4;
    } else {
      rim = 1.15 * Math.max(0, ...prior.map((id) => Math.hypot(anchors[id].x, anchors[id].y)));
    }
    for (const id of pending) {
      const angle = unit(id, "rim") * 2 * Math.PI;
      const p = { x: rim * Math.cos(angle), y: rim * Math.sin(angle) };
      start[id] = p;
      anchors[id] = { x: p.x, y: p.y };
    }
  }
  return { start, anchors };
}

/** Lays out the canvas image. The same input always gives the same output. */
export function layout(input: LayoutInput): PositionMap {
  const ids = new Set(input.nodes.map((n) => n.id));
  const links = input.links.filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to);
  const adjacency = new Map<string, string[]>();
  for (const l of links) {
    (adjacency.get(l.from) ?? adjacency.set(l.from, []).get(l.from)!).push(l.to);
    (adjacency.get(l.to) ?? adjacency.set(l.to, []).get(l.to)!).push(l.from);
  }
  const { start, anchors } = seed(input, adjacency);
  const bootstrap = Object.keys(anchors).length === 0 && Object.keys(input.prior).length === 0;
  const phys = input.physics;
  const gravity = bootstrap ? BOOTSTRAP_GRAVITY : phys.gravity;

  const sorted = [...ids].sort();
  const nodes: SimNode[] = sorted.map((id) => ({ id, x: start[id].x, y: start[id].y }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.from, (degree.get(l.from) ?? 0) + 1);
    degree.set(l.to, (degree.get(l.to) ?? 0) + 1);
  }
  const junction = (id: string): boolean => id.startsWith("arg_");
  type Link = SimulationLinkDatum<SimNode> & { a: string; b: string };
  const simLinks: Link[] = [...links]
    .sort((p, q) => (p.from + p.to < q.from + q.to ? -1 : 1))
    .map((l) => ({ source: l.from, target: l.to, a: l.from, b: l.to }));

  // depth of every node that has an edge
  const propositionIds = sorted.filter((id) => !junction(id));
  const rank = depthRanks(propositionIds, input.logicalEdges);
  const depth = new Map<string, number>();
  for (const id of propositionIds) if ((degree.get(id) ?? 0) > 0) depth.set(id, rank.get(id) ?? 0);
  for (const j of input.impLinks) {
    if (!ids.has(j.id)) continue;
    const top = Math.max(0, ...j.premises.map((p) => rank.get(p) ?? 0));
    depth.set(j.id, (top + (rank.get(j.conclusion) ?? 0)) / 2);
  }

  const sim = forceSimulation<SimNode>(nodes)
    .alphaDecay(ALPHA_DECAY)
    .velocityDecay(phys.velocityDecay)
    .randomSource(lcg(0x9e3779b9))
    .stop();
  sim.force(
    "link",
    forceLink<SimNode, Link>(simLinks)
      .id((d) => d.id)
      .distance((l) => phys.linkDistance * (junction(l.a) || junction(l.b) ? 0.5 : 1))
      .strength((l) => phys.linkStrength / Math.min(degree.get(l.a) ?? 1, degree.get(l.b) ?? 1)),
  );
  sim.force("charge", forceManyBody<SimNode>().strength(phys.chargeStrength));
  const mode = phys.depthMode;
  sim.force("gravity", (alpha: number) => {
    for (const n of nodes) {
      n.vx = (n.vx ?? 0) - (n.x ?? 0) * gravity * alpha;
      if (mode !== "vertical") n.vy = (n.vy ?? 0) - (n.y ?? 0) * gravity * alpha;
    }
  });
  if (phys.clusterPull > 0 && input.clusterOf && input.clusterOf.size > 0) {
    const clusterOf = input.clusterOf;
    sim.force("cluster", (alpha: number) => {
      const sums = new Map<string, { x: number; y: number; n: number }>();
      for (const n of nodes) {
        const c = clusterOf.get(n.id);
        if (c === undefined) continue;
        const s = sums.get(c) ?? { x: 0, y: 0, n: 0 };
        s.x += n.x ?? 0;
        s.y += n.y ?? 0;
        s.n += 1;
        sums.set(c, s);
      }
      for (const n of nodes) {
        const c = clusterOf.get(n.id);
        if (c === undefined) continue;
        const s = sums.get(c) as { x: number; y: number; n: number };
        const dx = s.x / s.n - (n.x ?? 0);
        const dy = s.y / s.n - (n.y ?? 0);
        const k = phys.clusterPull * alpha;
        if (mode === "vertical") {
          n.vx = (n.vx ?? 0) + dx * k;
        } else if (mode === "radial") {
          const r = Math.hypot(n.x ?? 0, n.y ?? 0) || 1;
          const tangent = (-(n.y ?? 0) * dx + (n.x ?? 0) * dy) / r;
          n.vx = (n.vx ?? 0) + (-(n.y ?? 0) / r) * tangent * k;
          n.vy = (n.vy ?? 0) + ((n.x ?? 0) / r) * tangent * k;
        } else {
          n.vx = (n.vx ?? 0) + dx * k;
          n.vy = (n.vy ?? 0) + dy * k;
        }
      }
    });
  }
  if (mode !== "off" && depth.size > 0) {
    sim.force("depth", (alpha: number) => {
      for (const n of nodes) {
        const d = depth.get(n.id);
        if (d === undefined) continue;
        if (mode === "vertical") {
          const target = -d * phys.depthSpacing;
          n.vy = (n.vy ?? 0) + (target - (n.y ?? 0)) * phys.depthStrength * alpha;
        } else {
          const r = Math.hypot(n.x ?? 0, n.y ?? 0) || 1;
          const pull = ((phys.depthBaseRadius + d * phys.depthSpacing - r) / r) * phys.depthStrength * alpha;
          n.vx = (n.vx ?? 0) + (n.x ?? 0) * pull;
          n.vy = (n.vy ?? 0) + (n.y ?? 0) * pull;
        }
      }
    });
  }

  const ticks = input.ticks ?? SETTLE_TICKS;
  for (let t = 0; t < ticks; t++) {
    sim.tick();
    for (const [id, a] of Object.entries(anchors)) {
      const n = byId.get(id);
      if (!n) continue;
      n.x = a.x + ANCHOR_KEEP * ((n.x ?? 0) - a.x);
      n.y = a.y + ANCHOR_KEEP * ((n.y ?? 0) - a.y);
    }
  }
  const out: PositionMap = {};
  for (const n of nodes) {
    const x = Number.isFinite(n.x) ? (n.x as number) : start[n.id].x;
    const y = Number.isFinite(n.y) ? (n.y as number) : start[n.id].y;
    out[n.id] = { x: Math.round(clampCoordinate(x) * 1000) / 1000, y: Math.round(clampCoordinate(y) * 1000) / 1000 };
  }
  return out;
}
