// Spreading activation. The same algorithm as kg/cortex_kg/activation.py.
import path from "node:path";
import type { Activation, GraphEdge, RelationDef } from "../../shared/types.ts";
import { readJsonFile } from "./util.ts";

export interface ActivationParams {
  decay: number;
  max_hops: number;
  threshold: number;
  fan_exponent: number;
}

export const DEFAULT_PARAMS: ActivationParams = { decay: 0.6, max_hops: 2, threshold: 0.05, fan_exponent: 0.5 };

export interface RelationWeight {
  weight: number;
  reverse_weight: number;
}

export type Adjacency = Map<string, { id: string; w: number }[]>;

/**
 * Reads the weights in the order of the compiler: the defaults folder (the ontology folder itself only where the defaults file is
 * missing), then the person's profile folder, then the overlay folder of the data folder. A later file wins.
 */
export function loadParams(ontologyRoot: string, profileDir?: string | null, dataDir?: string | null): ActivationParams {
  let out: ActivationParams = { ...DEFAULT_PARAMS };
  const defaults = path.join(ontologyRoot, "defaults");
  const base = readJsonFile<unknown>(path.join(defaults, "weights.json")) ? defaults : ontologyRoot;
  const dirs = [base, ...(profileDir ? [profileDir] : []), ...(dataDir ? [path.join(dataDir, "overlay")] : [])];
  for (const d of dirs) {
    const file = readJsonFile<{ activation?: Partial<ActivationParams> }>(path.join(d, "weights.json"));
    if (file?.activation) out = { ...out, ...file.activation };
  }
  return out;
}

/** Accepts the relation list of graph.json, a map of relation id to weights, or an object that holds either. */
export function relationWeights(source: unknown): Map<string, RelationWeight> {
  const out = new Map<string, RelationWeight>();
  const add = (id: string, v: unknown) => {
    if (typeof v === "number") out.set(id, { weight: v, reverse_weight: v });
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const fwd = Number(o.weight ?? o.forward ?? o.w);
      const rev = Number(o.reverse_weight ?? o.backward ?? o.reverse ?? fwd);
      if (Number.isFinite(fwd)) out.set(id, { weight: fwd, reverse_weight: Number.isFinite(rev) ? rev : fwd });
    }
  };
  if (Array.isArray(source)) {
    for (const r of source as RelationDef[]) add(r.id, r);
  } else if (source && typeof source === "object") {
    const o = source as Record<string, unknown>;
    const inner = o.relations ?? o.weights;
    if (inner && typeof inner === "object") return relationWeights(inner);
    for (const [k, v] of Object.entries(o)) add(k, v);
  }
  return out;
}

export function buildAdjacency(edges: Pick<GraphEdge, "s" | "r" | "t" | "w">[], weights: Map<string, RelationWeight>): Adjacency {
  const adj: Adjacency = new Map();
  const push = (from: string, id: string, w: number) => {
    const list = adj.get(from);
    if (list) list.push({ id, w });
    else adj.set(from, [{ id, w }]);
  };
  for (const e of edges) {
    const rel = weights.get(e.r);
    push(e.s, e.t, rel ? rel.weight : e.w);
    push(e.t, e.s, rel ? rel.reverse_weight : e.w);
  }
  for (const list of adj.values()) list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return adj;
}

const byAThenId = (x: Activation, y: Activation) => y.a - x.a || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

export function spread(adj: Adjacency, fired: [string, number][], params: ActivationParams = DEFAULT_PARAMS): Activation[] {
  const best = new Map<string, Activation>();
  for (const [id, a0] of fired) {
    const cur = best.get(id);
    if (!cur || a0 > cur.a) best.set(id, { id, a: a0, hop: 0, via: null });
  }
  for (let hop = 1; hop <= params.max_hops; hop++) {
    const frontier = [...best.values()].filter((x) => x.hop === hop - 1).sort(byAThenId);
    for (const u of frontier) {
      const neighbours = adj.get(u.id);
      if (!neighbours || neighbours.length === 0) continue;
      const factor = params.decay / Math.pow(neighbours.length, params.fan_exponent);
      for (const v of neighbours) {
        const a = u.a * v.w * factor;
        if (a < params.threshold) continue;
        const cur = best.get(v.id);
        if (!cur || a > cur.a) best.set(v.id, { id: v.id, a, hop, via: u.id });
      }
    }
  }
  return [...best.values()].sort(byAThenId);
}
