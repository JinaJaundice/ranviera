import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAdjacency, relationWeights, spread, DEFAULT_PARAMS } from "./activation.ts";
import { REPO_ROOT } from "./config.ts";

const dir = path.join(REPO_ROOT, "kg", "tests", "fixtures", "activation");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];

describe("activation fixtures", () => {
  if (files.length === 0) {
    it.skip("kg/tests/fixtures/activation holds no fixtures yet, so the Python and server results are not compared", () => {});
  }
  for (const f of files) {
    it(`matches the reference result for ${f}`, () => {
      const fx = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const adj = buildAdjacency(fx.graph.edges, relationWeights(fx.weights));
      const got = spread(adj, fx.fired, { ...DEFAULT_PARAMS, ...fx.params });
      expect(got.map((x) => x.id)).toEqual(fx.expected.map((x: { id: string }) => x.id));
      got.forEach((x, i) => {
        const e = fx.expected[i];
        expect(x.a).toBeCloseTo(e.a, 6);
        if (e.hop !== undefined) expect(x.hop).toBe(e.hop);
        if (e.via !== undefined) expect(x.via).toBe(e.via);
      });
    });
  }
});

describe("spread", () => {
  it("applies the relation weight, the decay and the fan out", () => {
    const edges = [
      { s: "a", r: "x", t: "b", w: 0.5 },
      { s: "a", r: "x", t: "c", w: 0.5 },
    ];
    const adj = buildAdjacency(edges, relationWeights([{ id: "x", weight: 1, reverse_weight: 0.5 }]));
    const got = spread(adj, [["a", 1]]);
    const b = got.find((x) => x.id === "b");
    expect(b?.a).toBeCloseTo(1 * 1 * 0.6 / Math.sqrt(2), 9);
    expect(b?.hop).toBe(1);
    expect(b?.via).toBe("a");
  });
});
