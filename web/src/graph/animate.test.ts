import { describe, expect, it } from "vitest";
import { GlowTracker, HALF_LIFE_MS, PREVIEW_HALF_LIFE_MS, boost, decay, orbitSpeed, planFiring, ringState } from "./animate";
import { heatOf, parseCssColor, readPalette, restingBrightness, rgbToHex, shade } from "./palette";

describe("glow decay", () => {
  it("halves after one half-life", () => {
    expect(decay(1, HALF_LIFE_MS, HALF_LIFE_MS)).toBeCloseTo(0.5, 9);
    expect(decay(1, PREVIEW_HALF_LIFE_MS, PREVIEW_HALF_LIFE_MS)).toBeCloseTo(0.5, 9);
  });

  it("raises brightness and size by up to 1.8 times", () => {
    expect(boost(0)).toBe(1);
    expect(boost(1)).toBeCloseTo(1.8, 9);
    expect(boost(5)).toBeCloseTo(1.8, 9);
  });

  it("converts the orbit period to a control speed", () => {
    expect(orbitSpeed(240)).toBeCloseTo(0.25, 9);
  });
});

describe("firing plan", () => {
  it("schedules each entry at hop times 180 ms", () => {
    const plan = planFiring(
      [
        { id: "a", a: 1, hop: 0, via: null },
        { id: "b", a: 0.5, hop: 1, via: "a" },
        { id: "c", a: 0.2, hop: 2, via: "b" },
      ],
      false,
    );
    expect(plan.map((p) => p.at)).toEqual([0, 180, 360]);
    expect(plan[1].via).toBe("a");
    expect(plan[0].halfLife).toBe(1600);
  });

  it("gives a preview the longer half-life", () => {
    expect(planFiring([{ id: "a", a: 1, hop: 0, via: null }], true)[0].halfLife).toBe(2400);
  });

  it("scales the ring out over 600 ms", () => {
    expect(ringState(0)).toEqual({ scale: 1, opacity: 0.8 });
    expect(ringState(300)?.scale).toBeCloseTo(2.5, 9);
    expect(ringState(600)).toBeNull();
  });
});

describe("glow tracker", () => {
  it("keeps the larger of the current glow and a new value", () => {
    const t = new GlowTracker();
    t.add("a", 0.8, 1600);
    t.add("a", 0.3, 1600);
    expect(t.glow("a")).toBe(0.8);
    t.add("a", 0.9, 1600);
    expect(t.glow("a")).toBe(0.9);
  });

  it("decays, reports the nodes that ended, and empties", () => {
    const t = new GlowTracker();
    t.add("a", 1, 1600);
    let ended: string[] = [];
    let steps = 0;
    while (t.size > 0 && steps < 1000) {
      ended = ended.concat(t.step(16).ended);
      steps += 1;
    }
    expect(ended).toEqual(["a"]);
    expect(t.size).toBe(0);
    // 1 falls below 0.01 after log2(100) half-lives, about 10.6 seconds
    expect(steps * 16).toBeGreaterThan(10000);
    expect(steps * 16).toBeLessThan(11200);
  });
});

describe("palette", () => {
  it("parses hex and rgb colours", () => {
    expect(parseCssColor("#ffffff")).toEqual([1, 1, 1]);
    expect(rgbToHex(parseCssColor("#6ee7ff"))).toBe("#6ee7ff");
    expect(parseCssColor("rgb(255, 0, 0)")).toEqual([1, 0, 0]);
    expect(parseCssColor("nonsense")).toEqual([0.5, 0.5, 0.5]);
  });

  it("gives resting brightness 0.35 to 0.9 and no heat to a null base level", () => {
    expect(heatOf(null)).toBe(0);
    expect(restingBrightness(heatOf(null))).toBeCloseTo(0.35, 9);
    expect(restingBrightness(1)).toBeCloseTo(0.9, 9);
  });

  it("shades towards the void colour", () => {
    expect(shade([1, 1, 1], [0, 0, 0], 0.5)).toEqual([0.5, 0.5, 0.5]);
    expect(shade([1, 1, 1], [0, 0, 0], 1.8)[0]).toBeCloseTo(1.8, 9);
  });

  it("reads a palette from a token reader", () => {
    const p = readPalette((n) => (n.includes("void") ? "#000000" : "#ffffff"), true);
    expect(p.void).toEqual([0, 0, 0]);
    expect(p.families.work).toEqual([1, 1, 1]);
  });
});
