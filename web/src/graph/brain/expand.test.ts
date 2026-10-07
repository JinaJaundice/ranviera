/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { RegionId } from "@shared/brain";
import { CORTICAL_SPREAD, DEEP_SPREAD, expandKey, expandOffset, expandOffsets, type RegionCentre } from "./expand";

const manifest = JSON.parse(readFileSync(new URL("../../../public/brain/brain-regions.json", import.meta.url), "utf8")) as {
  regions: { id: string; hemisphere: "L" | "R"; centroid: [number, number, number] | null }[];
};
const centres: RegionCentre[] = manifest.regions
  .filter((r) => r.centroid)
  .map((r) => ({ region: r.id as RegionId, hemisphere: r.hemisphere, centre: { x: r.centroid![0], y: r.centroid![1], z: r.centroid![2] } }));

const at = (e: RegionCentre, expand: number) => {
  const o = expandOffset(e, expand);
  return { x: e.centre.x + o.x, y: e.centre.y + o.y, z: e.centre.z + o.z };
};
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const len = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);

describe("expand", () => {
  it("moves nothing at 0", () => {
    for (const e of centres) expect(len(expandOffset(e, 0))).toBe(0);
  });

  it("clamps the value to the range 0 to 1 and ignores a value that is not a number", () => {
    const e = centres[0];
    expect(len(expandOffset(e, 5))).toBeCloseTo(len(expandOffset(e, 1)), 6);
    expect(len(expandOffset(e, -1))).toBe(0);
    expect(len(expandOffset(e, Number.NaN))).toBe(0);
  });

  it("moves a region by the spread of its kind at 1, and halfway at 0.5", () => {
    for (const e of centres) {
      const deep = ["thalamus", "basal", "cerebellum", "brainstem"].includes(e.region);
      const spread = deep ? DEEP_SPREAD : CORTICAL_SPREAD;
      expect(len(expandOffset(e, 1))).toBeCloseTo(spread, 6);
      expect(len(expandOffset(e, 0.5))).toBeCloseTo(spread / 2, 6);
    }
  });

  it("moves a cortical region along its own centre, away from the middle of the brain", () => {
    for (const e of centres.filter((c) => ["prefrontal", "language", "occipital", "motor", "parietal", "memory"].includes(c.region))) {
      const o = expandOffset(e, 1);
      const cos = (o.x * e.centre.x + o.y * e.centre.y + o.z * e.centre.z) / (len(o) * len(e.centre));
      expect(cos).toBeGreaterThan(0.999);
    }
  });

  it("mirrors the deep directions for the other hemisphere", () => {
    for (const region of ["thalamus", "basal", "cerebellum", "brainstem"] as RegionId[]) {
      const l = centres.find((c) => c.region === region && c.hemisphere === "L")!;
      const r = centres.find((c) => c.region === region && c.hemisphere === "R")!;
      const ol = expandOffset(l, 1);
      const or = expandOffset(r, 1);
      expect(or.x).toBeCloseTo(-ol.x, 6);
      expect(or.y).toBeCloseTo(ol.y, 6);
      expect(or.z).toBeCloseTo(ol.z, 6);
    }
  });

  it("brings each deep region out of the cortex, away from the centre of its own cluster", () => {
    for (const e of centres.filter((c) => ["thalamus", "basal", "cerebellum", "brainstem"].includes(c.region))) {
      expect(len(at(e, 1))).toBeGreaterThan(len(e.centre) + 55);
    }
  });

  it("separates every pair of regions by at least 45 units at 1, and by more than at 0 for the deep regions", () => {
    for (let i = 0; i < centres.length; i += 1) {
      for (let j = i + 1; j < centres.length; j += 1) {
        const a = centres[i];
        const b = centres[j];
        // the two hemispheres of one region are meant to lie side by side
        if (a.region === b.region) continue;
        const open = dist(at(a, 1), at(b, 1));
        expect(open, `${expandKey(a.region, a.hemisphere)} and ${expandKey(b.region, b.hemisphere)}`).toBeGreaterThan(45);
        if (["thalamus", "basal", "cerebellum", "brainstem"].includes(a.region) && ["thalamus", "basal", "cerebellum", "brainstem"].includes(b.region)) {
          expect(open).toBeGreaterThan(dist(at(a, 0), at(b, 0)));
        }
      }
    }
  });

  it("gives every region and hemisphere an offset under its key", () => {
    const all = expandOffsets(centres, 1);
    expect(all.size).toBe(centres.length);
    expect(all.get(expandKey("thalamus", "L"))!.y).toBeGreaterThan(80);
    expect(all.get(expandKey("brainstem", "R"))!.y).toBeLessThan(-80);
  });
});
