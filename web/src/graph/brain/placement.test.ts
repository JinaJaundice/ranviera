/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { REGION_IDS, regionOf } from "@shared/brain";
import { makeGraph } from "../fixtures";
import { farthestSeeds, placeNodes, type PlaceNode } from "./placement";
import type { BrainManifest } from "./types";

const dir = new URL("../../../../web/public/brain/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("brain-regions.json", dir), "utf8")) as BrainManifest;
const buf = readFileSync(new URL("brain-points.bin", dir));
const points = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

function nodesOf(count: number): PlaceNode[] {
  return makeGraph(count).nodes.map((n) => ({ id: n.id, region: regionOf(n, n.path), group: n.path ?? n.id }));
}

describe("placement", () => {
  it("reads the asset: 6 numbers for each point", () => {
    expect(points.length).toBe(manifest.points.count * 6);
  });

  it("gives the same positions for the same graph", () => {
    const a = placeNodes(nodesOf(2500), points, manifest.regions);
    const b = placeNodes(nodesOf(2500).reverse(), points, manifest.regions);
    expect(a.positions.size).toBe(new Set(nodesOf(2500).map((n) => n.id)).size);
    for (const [id, p] of a.positions) expect(b.positions.get(id)).toEqual(p);
  });

  it("gives every node a position of its own", () => {
    const { positions, overflow } = placeNodes(nodesOf(2500), points, manifest.regions);
    expect(overflow).toEqual({});
    const seen = new Set([...positions.values()].map((p) => `${p.x.toFixed(3)}|${p.y.toFixed(3)}|${p.z.toFixed(3)}`));
    expect(seen.size).toBe(positions.size);
  });

  it("keeps the language region on the left hemisphere, which lies at positive X", () => {
    const nodes = nodesOf(2500);
    const { positions } = placeNodes(nodes, points, manifest.regions);
    const language = nodes.filter((n) => n.region === "language");
    expect(language.length).toBeGreaterThan(50);
    for (const n of language) {
      expect(positions.get(n.id)!.hemisphere).toBe("L");
      expect(positions.get(n.id)!.x).toBeGreaterThan(0);
    }
  });

  it("keeps the nodes of one file together on one hemisphere and alternates the files", () => {
    const nodes: PlaceNode[] = [];
    for (let f = 0; f < 6; f += 1) for (let i = 0; i < 5; i += 1) nodes.push({ id: `rule:f${f}-${i}`, region: "prefrontal", group: `file${f}.md` });
    const { positions } = placeNodes(nodes, points, manifest.regions);
    const hemi = (f: number) => new Set([0, 1, 2, 3, 4].map((i) => positions.get(`rule:f${f}-${i}`)!.hemisphere));
    for (let f = 0; f < 6; f += 1) expect(hemi(f).size).toBe(1);
    expect([...hemi(0)][0]).not.toBe([...hemi(1)][0]);
    expect([...hemi(0)][0]).toBe([...hemi(2)][0]);
  });

  it("places the nodes of a file near each other", () => {
    const nodes: PlaceNode[] = [];
    for (let f = 0; f < 4; f += 1) for (let i = 0; i < 12; i += 1) nodes.push({ id: `rule:f${f}-${String(i).padStart(2, "0")}`, region: "parietal", group: `file${f}.md` });
    const { positions } = placeNodes(nodes, points, manifest.regions);
    const spread = (f: number) => {
      const ps = nodes.filter((n) => n.group === `file${f}.md`).map((n) => positions.get(n.id)!);
      const c = ps.reduce((s, p) => ({ x: s.x + p.x / ps.length, y: s.y + p.y / ps.length, z: s.z + p.z / ps.length }), { x: 0, y: 0, z: 0 });
      return Math.max(...ps.map((p) => Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z)));
    };
    for (let f = 0; f < 4; f += 1) expect(spread(f)).toBeLessThan(25);
  });

  it("reports a region with more nodes than sample points and reuses points", () => {
    const nodes: PlaceNode[] = Array.from({ length: 1100 }, (_, i) => ({ id: `n${i}`, region: "basal" as const, group: "g" }));
    const { positions, overflow } = placeNodes(nodes, points, manifest.regions);
    expect(positions.size).toBe(1100);
    // the one file sits on one hemisphere, which holds about 1,000 points
    expect(overflow.basal).toBeGreaterThan(50);
  });

  it("seeds farthest-point sampling in a sequence that does not depend on the count", () => {
    const entry = manifest.regions.find((r) => r.id === "motor" && r.hemisphere === "L")!;
    const pool = Array.from({ length: entry.pointCount }, (_, i) => entry.pointOffset + i);
    expect(farthestSeeds(points, pool, 12)).toEqual(farthestSeeds(points, pool, 30).slice(0, 12));
  });

  it("has enough points in the asset for every region", () => {
    for (const id of REGION_IDS) {
      const n = manifest.regions.filter((r) => r.id === id).reduce((s, r) => s + r.pointCount, 0);
      expect(n, id).toBeGreaterThanOrEqual(1500);
    }
  });
});
