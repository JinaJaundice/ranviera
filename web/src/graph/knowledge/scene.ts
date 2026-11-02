// The scene of the Knowledge layer: the snapshot of route 30 turned into discs, junctions, links and clusters with positions.
import type { GraphSnapshot } from "@shared/learn/knowledge";
import { boundsOf, centroid, clusterHull, clusterToken, junctionPoint, seedPositions, type Box, type Pt } from "./geometry";

export interface SceneNode {
  id: string;
  name: string;
  statement: string;
  kind: "proposition" | "junction";
  x: number;
  y: number;
  r: number;
  /** the arguments that the claim joins, as a premise or as the conclusion */
  chains: number;
  clusterId: string | null;
}

export interface SceneLink {
  from: string;
  to: string;
  /** only a line that ends on a claim has a head, the lines into a junction have none */
  arrow: boolean;
}

export interface SceneCluster {
  id: string;
  label: string;
  token: string;
  members: string[];
}

export interface Scene {
  nodes: SceneNode[];
  byId: Map<string, SceneNode>;
  links: SceneLink[];
  clusters: SceneCluster[];
  /** the joint arguments, by junction id, for placing the junctions again after a drag */
  joins: { id: string; premises: string[]; conclusion: string }[];
}

/** The radius of a claim in world units: larger for a claim that joins more arguments, and scaled by the node size setting. */
export function nodeRadius(chains: number, nodeSize: number): number {
  return nodeSize * (1.6 + 0.7 * Math.sqrt(Math.max(0, chains)));
}

/** The label of a cluster that has no name. */
export const UNNAMED_CLUSTER = "Unnamed source";

export function buildScene(snap: GraphSnapshot, nodeSize: number, override: Record<string, Pt> = {}): Scene {
  const ids = snap.nodes.map((n) => n.id);
  const known: Record<string, Pt> = {};
  for (const [id, p] of Object.entries(snap.positions ?? {})) if (Number.isFinite(p.x) && Number.isFinite(p.y)) known[id] = { x: p.x, y: p.y };
  for (const [id, p] of Object.entries(override)) if (Number.isFinite(p.x) && Number.isFinite(p.y)) known[id] = { x: p.x, y: p.y };
  const pos = seedPositions(ids, known);

  const counts = new Map<string, number>();
  for (const c of snap.chains) {
    for (const id of [...c.premises, c.conclusion]) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const clusterOf = new Map<string, string>();
  for (const c of snap.clusters) for (const m of c.members) clusterOf.set(m, c.id);

  const nodes: SceneNode[] = snap.nodes.map((n) => {
    const chains = n.kind === "proposition" ? (counts.get(n.id) ?? 0) : 0;
    const p = pos[n.id];
    return { id: n.id, name: n.name, statement: n.statement, kind: n.kind, x: p.x, y: p.y, r: n.kind === "junction" ? Math.max(nodeSize * 0.9, 1.2) : nodeRadius(chains, nodeSize), chains, clusterId: clusterOf.get(n.id) ?? null };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const junctions = new Set(nodes.filter((n) => n.kind === "junction").map((n) => n.id));
  const links: SceneLink[] = snap.edges.filter((e) => byId.has(e.from) && byId.has(e.to)).map((e) => ({ from: e.from, to: e.to, arrow: !junctions.has(e.to) }));
  const clusters: SceneCluster[] = snap.clusters.map((c) => ({ id: c.id, label: c.label ?? snap.sessions[c.id] ?? snap.fileSources[c.id] ?? UNNAMED_CLUSTER, token: clusterToken(c.id), members: c.members.filter((m) => byId.has(m)) }));
  const scene: Scene = { nodes, byId, links, clusters, joins: snap.impLinks };
  // a junction without a stored position sits between its premises and its conclusion
  for (const j of snap.impLinks) if (!known[j.id]) placeJunction(scene, j.id);
  return scene;
}

function placeJunction(scene: Scene, id: string): void {
  const j = scene.joins.find((x) => x.id === id);
  const node = scene.byId.get(id);
  if (!j || !node) return;
  const ps = j.premises.map((p) => scene.byId.get(p)).filter((n): n is SceneNode => !!n);
  const c = scene.byId.get(j.conclusion);
  if (!ps.length || !c) return;
  const at = junctionPoint(ps, c);
  node.x = at.x;
  node.y = at.y;
}

/** Puts every junction halfway between its premises and its conclusion again, after a claim has moved. */
export function settleJunctions(scene: Scene): void {
  for (const j of scene.joins) placeJunction(scene, j.id);
}

export function sceneBounds(scene: Scene): Box | null {
  return boundsOf(scene.nodes);
}

/** The outline of each cluster that has enough members, in world units. */
export function clusterOutlines(scene: Scene, pad: number): { cluster: SceneCluster; hull: Pt[]; centre: Pt }[] {
  const out: { cluster: SceneCluster; hull: Pt[]; centre: Pt }[] = [];
  for (const cluster of scene.clusters) {
    const pts = cluster.members.map((m) => scene.byId.get(m)).filter((n): n is SceneNode => !!n);
    const hull = clusterHull(pts, pad);
    if (hull) out.push({ cluster, hull, centre: centroid(pts) });
  }
  return out;
}

/** The positions to commit through route 34: every node of the view, junctions included. */
export function positionsOf(scene: Scene): Record<string, Pt> {
  const out: Record<string, Pt> = {};
  for (const n of scene.nodes) out[n.id] = { x: Math.round(n.x * 1000) / 1000, y: Math.round(n.y * 1000) / 1000 };
  return out;
}
