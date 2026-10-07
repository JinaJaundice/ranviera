import { describe, expect, it } from "vitest";
import { boundsOf, calloutRegions, FOCUS_FADE, FOCUS_SHRINK, framingDistance, glowOf, HALO_REST, regionTint } from "./look";
import { NODE_FRAGMENT } from "./shaders";
import type { RegionId } from "@shared/brain";

const ALL = ["prefrontal", "language", "motor", "memory"] as RegionId[];

describe("the look of the brain", () => {
  it("tints no region at rest and only the focused region over a focus", () => {
    for (const id of ALL) expect(regionTint(id, null)).toBe(0);
    expect(regionTint("motor", "motor")).toBe(1);
    expect(regionTint("language", "motor")).toBe(0);
    expect(regionTint("shell", null)).toBe(1);
  });

  it("keeps the halo of a resting neuron faint and gives the glow to a firing or selected neuron only", () => {
    expect(HALO_REST).toBeLessThanOrEqual(0.15);
    expect(NODE_FRAGMENT).toContain("HALO_REST");
    expect(glowOf(0, false, false)).toBe(0);
    expect(glowOf(0.6, false, false)).toBe(0.6);
    expect(glowOf(0, true, false)).toBe(1);
    expect(glowOf(0.9, true, true)).toBe(0);
    expect(FOCUS_FADE).toBeLessThanOrEqual(0.05);
    expect(FOCUS_SHRINK).toBeLessThan(1);
  });

  it("shows the callouts of the focused region alone, of the regions of the current step over the trail, and all at rest", () => {
    expect(calloutRegions(ALL, { focused: null, trail: false, stepRegions: new Set() })).toEqual(ALL);
    expect(calloutRegions(ALL, { focused: "motor", trail: false, stepRegions: new Set() })).toEqual(["motor"]);
    expect(calloutRegions(ALL, { focused: null, trail: true, stepRegions: new Set<RegionId>(["language", "memory"]) })).toEqual(["language", "memory"]);
    expect(calloutRegions(ALL, { focused: null, trail: true, stepRegions: new Set() })).toEqual([]);
  });

  it("finds the bounds of a set of points and a distance that frames them inside the free area", () => {
    const b = boundsOf([0, 0, 0, 10, 20, 0, 4, 4, 4])!;
    expect(b.centre).toEqual([5, 10, 2]);
    expect(b.radius).toBeCloseTo(Math.hypot(10, 20, 4) / 2);
    expect(boundsOf([])).toBeNull();
    // a radius of 20 units that must fill at most 200 pixels, at 1,000 pixels per unit at distance 1: the camera stands at 100
    expect(framingDistance(20, 200, 1000, 10, 800)).toBe(100);
    expect(framingDistance(1, 200, 1000, 120, 800)).toBe(120);
    expect(framingDistance(500, 100, 1000, 10, 800)).toBe(800);
  });
});
