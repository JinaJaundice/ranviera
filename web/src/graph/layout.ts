// Layout, sizing and filtering for the graph canvas. Pure functions, tested in layout.test.ts.
import type { Family, GraphEdge, GraphNode, Sensitivity } from "@shared/types";
import { FAMILIES, heatOfNode } from "./palette";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const ANCHOR_RADIUS = 260;

/**
 * One anchor for each family, on the 6 vertices of an octahedron, so that no two anchors are closer than
 * radius times the square root of 2 and the families form separate lobes.
 */
export function familyAnchors(radius = ANCHOR_RADIUS): Record<Family, Vec3> {
  const dirs: Vec3[] = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
  ];
  const out = {} as Record<Family, Vec3>;
  FAMILIES.forEach((f, i) => {
    out[f] = { x: dirs[i].x * radius, y: dirs[i].y * radius, z: dirs[i].z * radius };
  });
  return out;
}

export interface AnchoredNode {
  family: Family;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
}

export interface AnchorForce {
  (alpha: number): void;
  initialize: (nodes: AnchoredNode[]) => void;
}

/** A d3 force that pulls each node gently towards the anchor of its family. */
export function anchorForce(anchors: Record<Family, Vec3>, strength = 0.09): AnchorForce {
  let nodes: AnchoredNode[] = [];
  const force = ((alpha: number) => {
    const k = strength * alpha;
    for (const n of nodes) {
      const a = anchors[n.family];
      if (!a) continue;
      n.vx = (n.vx ?? 0) + (a.x - (n.x ?? 0)) * k;
      n.vy = (n.vy ?? 0) + (a.y - (n.y ?? 0)) * k;
      n.vz = (n.vz ?? 0) + (a.z - (n.z ?? 0)) * k;
    }
  }) as AnchorForce;
  force.initialize = (list) => {
    nodes = list;
  };
  return force;
}

// ---------------------------------------------------------------- filtering

export const SENSITIVITY_RANK: Record<Sensitivity, number> = { public: 0, internal: 1, "client-confidential": 2 };

export interface ViewFilter {
  families: Record<Family, boolean>;
  cap: Sensitivity;
}

/** Nodes whose family is switched on and whose sensitivity is at or below the cap. */
export function filterNodes(nodes: GraphNode[], view: ViewFilter): GraphNode[] {
  const limit = SENSITIVITY_RANK[view.cap];
  return nodes.filter((n) => view.families[n.family] && SENSITIVITY_RANK[n.sensitivity] <= limit);
}

/** Edges whose two ends are both shown. */
export function filterEdges(edges: GraphEdge[], shown: Set<string>): GraphEdge[] {
  return edges.filter((e) => shown.has(e.s) && shown.has(e.t));
}

export function countByFamily(nodes: GraphNode[]): Record<Family, number> {
  const out = Object.fromEntries(FAMILIES.map((f) => [f, 0])) as Record<Family, number>;
  for (const n of nodes) out[n.family] += 1;
  return out;
}

// ------------------------------------------------------------------- sizing

interface SizeClass {
  mult: number;
  floor: number;
  cap: number;
}

const FILES = new Set(["MapFile", "RuleFile", "OutputStyle", "Skill", "ReferenceFile", "GuideFile"]);
const KEY = new Set(["TaskType", "Agent", "Project"]);

/** Radius bounds for each class. Rules stay below the floor of every file, and key classes stay visible. */
export function sizeClassOf(type: string): SizeClass {
  if (type === "Rule") return { mult: 0.6, floor: 1.2, cap: 2.6 };
  if (KEY.has(type)) return { mult: 1.8, floor: 5, cap: 10 };
  if (FILES.has(type)) return { mult: 1.5, floor: 4, cap: 8 };
  return { mult: 1, floor: 2, cap: 5 };
}

/** The size value before the class bounds: 1 + 4 * sigmoid(base level) for heat, 1 + 1.2 * log2(1 + degree) for degree. */
export function sizeValue(node: GraphNode, sizeBy: "heat" | "degree"): number {
  if (sizeBy === "degree") return 1 + 1.2 * Math.log2(1 + Math.max(0, node.metrics.degree));
  return node.metrics.base_level === null ? 1 : 1 + 4 * heatOfNode(node);
}

export function nodeRadius(node: GraphNode, sizeBy: "heat" | "degree"): number {
  const c = sizeClassOf(node.type);
  return Math.min(c.cap, Math.max(c.floor, sizeValue(node, sizeBy) * c.mult));
}

// ----------------------------------------------------------------- positions

/** Copy the positions of the nodes to a store, keyed by id, so that a reload keeps the layout. */
export function rememberPositions(
  store: Map<string, Vec3>,
  nodes: { id?: string | number; x?: number; y?: number; z?: number }[],
): void {
  for (const n of nodes) {
    if (n.id === undefined || n.x === undefined || n.y === undefined || n.z === undefined) continue;
    store.set(String(n.id), { x: n.x, y: n.y, z: n.z });
  }
}

/** Give a node its stored position when it has one. Returns whether a position was restored. */
export function restorePosition(store: Map<string, Vec3>, id: string, target: Partial<Vec3>): boolean {
  const p = store.get(id);
  if (!p) return false;
  target.x = p.x;
  target.y = p.y;
  target.z = p.z;
  return true;
}
