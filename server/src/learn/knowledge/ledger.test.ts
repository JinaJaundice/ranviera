import { describe, expect, it } from "vitest";
import type { ChainLine, NodeLine } from "../../../../shared/learn/knowledge.ts";
import { MIN_CLUSTER_SIZE, birthSource, chainKey, deriveClusters, deriveView, fileLabel, isChainLine, isNodeLine, mergeChains, mergeNodes } from "./ledger.ts";
import { chain, node, prov, rng } from "./test-support.ts";

describe("node merge", () => {
  it("B-2-04 the first line fixes name, statement and time, and later lines add aliases", () => {
    const merged = mergeNodes([
      node("n_1", "First", "Statement one.", [prov("c1", "m1")], ["alias a"], "2026-10-01T00:00:00Z"),
      node("n_1", "Second", "Statement two.", [prov("c2")], ["alias a", "", "alias b"], "2026-10-02T00:00:00Z"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ name: "First", statement: "Statement one.", createdAt: "2026-10-01T00:00:00Z" });
    expect(merged[0].aliases).toEqual(["alias a", "Statement two.", "alias b"]);
    expect(merged[0].aliases).not.toContain("Second");
  });

  it("B-2-05 identical statements without a shared id stay separate nodes", () => {
    const merged = mergeNodes([node("n_1", "A", "Same words."), node("n_2", "B", "Same words.")]);
    expect(merged.map((n) => n.id)).toEqual(["n_1", "n_2"]);
  });

  it("unions provenance by the exact pair in first seen order", () => {
    const merged = mergeNodes([
      node("n_1", "A", "S", [prov("c1", "m1"), prov("c2")]),
      node("n_1", "A", "S", [prov("c2"), prov("c1", "m2"), prov("c1", "m1")]),
    ]);
    expect(merged[0].provenance).toEqual([prov("c1", "m1"), prov("c2"), prov("c1", "m2")]);
  });

  it("B-2-09 raw lines keep a repeated id as its own line while the merge folds them", () => {
    const raw = [node("n_1", "A", "S1"), node("n_1", "A", "S2")];
    expect(raw).toHaveLength(2);
    expect(mergeNodes(raw)).toHaveLength(1);
  });

  it("B-2-08 the guards accept a valid line and refuse a wrong shape", () => {
    expect(isNodeLine(node("n_1", "A", "S"))).toBe(true);
    expect(isNodeLine({ ...node("n_1", "A", "S"), aliases: "x" })).toBe(false);
    expect(isNodeLine({ ...node("n_1", "A", "S"), provenance: [{ chatId: "c" }] })).toBe(false);
    expect(isNodeLine(null)).toBe(false);
    expect(isChainLine(chain("arg_1", ["n_1"], "n_2"))).toBe(true);
    expect(isChainLine(chain("arg_1", [], "n_2"))).toBe(false);
    expect(isChainLine({ ...chain("arg_1", ["n_1"], "n_2"), conclusion: 3 })).toBe(false);
  });
});

describe("chain merge", () => {
  it("the key sorts the premises and joins them with a plus sign", () => {
    expect(chainKey(["n_b", "n_a"], "n_c")).toBe("n_a+n_b>n_c");
  });

  it("merges by key, keeps the first id and premise order, and unions provenance", () => {
    const merged = mergeChains([
      chain("arg_1", ["n_b", "n_a"], "n_c", [prov("c1")], "2026-10-01T00:00:00Z"),
      chain("arg_2", ["n_a", "n_b"], "n_c", [prov("c2"), prov("c1")], "2026-10-02T00:00:00Z"),
      chain("arg_3", ["n_a"], "n_c", [prov("c3")]),
    ]);
    expect(merged.map((c) => c.key)).toEqual(["n_a+n_b>n_c", "n_a>n_c"]);
    expect(merged[0]).toMatchObject({ id: "arg_1", premises: ["n_b", "n_a"], createdAt: "2026-10-01T00:00:00Z" });
    expect(merged[0].provenance).toEqual([prov("c1"), prov("c2")]);
  });
});

describe("property: merge idempotence", () => {
  function randomLines(seed: number): { nodes: NodeLine[]; chains: ChainLine[] } {
    const r = rng(seed);
    const ids = ["n_1", "n_2", "n_3", "n_4", "n_5"];
    const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
    const nodes: NodeLine[] = [];
    const chains: ChainLine[] = [];
    for (let i = 0; i < 25; i++) {
      nodes.push(node(pick(ids), `name ${i}`, `statement ${Math.floor(r() * 6)}`, [prov(pick(["c1", "c2", "s1"]), pick(["", "m1", "m2"]))], r() < 0.4 ? [`alias ${Math.floor(r() * 4)}`] : []));
      const premises = [...new Set([pick(ids), pick(ids), pick(ids)])];
      chains.push(chain(`arg_${i}`, premises, pick(ids), [prov(pick(["c1", "c2", "s1"]))]));
    }
    return { nodes, chains };
  }

  it("merging the lines twice gives the merge of the lines once, for 40 random ledgers", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { nodes, chains } = randomLines(seed);
      expect(mergeNodes([...nodes, ...nodes])).toEqual(mergeNodes(nodes));
      expect(mergeChains([...chains, ...chains])).toEqual(mergeChains(chains));
    }
  });

  it("writing a merged result back as lines and merging again changes nothing", () => {
    for (let seed = 50; seed < 70; seed++) {
      const { nodes, chains } = randomLines(seed);
      const mergedNodes = mergeNodes(nodes);
      const asLines: NodeLine[] = mergedNodes.map((n) => ({ ...n }));
      expect(mergeNodes(asLines)).toEqual(mergedNodes);
      const mergedChains = mergeChains(chains);
      const chainLines: ChainLine[] = mergedChains.map((c) => ({ id: c.id, premises: c.premises, conclusion: c.conclusion, createdAt: c.createdAt, provenance: c.provenance }));
      expect(mergeChains(chainLines)).toEqual(mergedChains);
    }
  });
});

describe("derived view", () => {
  const nodes = mergeNodes([node("n_a", "A", "a"), node("n_b", "B", "b"), node("n_c", "C", "c")]);

  it("B-2-18 a single premise is one arrow, and several premises meet at a junction", () => {
    const view = deriveView(nodes, mergeChains([chain("arg_1", ["n_a"], "n_c"), chain("arg_2", ["n_b", "n_a"], "n_c")]));
    expect(view.edges).toEqual([
      { from: "n_a", to: "n_c" },
      { from: "n_b", to: "arg_2" },
      { from: "n_a", to: "arg_2" },
      { from: "arg_2", to: "n_c" },
    ]);
    const junction = view.nodes.find((n) => n.id === "arg_2");
    expect(junction).toMatchObject({ kind: "junction", name: "⇒", statement: "A, B → C" });
    expect(view.impLinks).toEqual([{ id: "arg_2", premises: ["n_b", "n_a"], conclusion: "n_c" }]);
  });

  it("B-2-18 two chains with a shared conclusion stay distinct", () => {
    const view = deriveView(nodes, mergeChains([chain("arg_1", ["n_a"], "n_c"), chain("arg_2", ["n_b"], "n_c")]));
    expect(view.live).toHaveLength(2);
    expect(view.logicalEdges).toEqual([{ from: "n_a", to: "n_c" }, { from: "n_b", to: "n_c" }]);
  });

  it("B-2-19 a chain with a missing member is left out of the image and the logical edges", () => {
    const view = deriveView(nodes, mergeChains([chain("arg_1", ["n_a", "n_missing"], "n_c"), chain("arg_2", ["n_a"], "n_missing")]));
    expect(view.live).toEqual([]);
    expect(view.edges).toEqual([]);
    expect(view.logicalEdges).toEqual([]);
    expect(view.nodes).toHaveLength(3);
  });
});

describe("birth sources and clusters", () => {
  const labels = (id: string): string | null => ({ c1: "Chat one", c2: "Chat two" })[id] ?? null;
  const many = (src: string, prefix: string, n: number, extra: Parameters<typeof node>[3] = []) =>
    Array.from({ length: n }, (_, i) => node(`${prefix}${i}`, `N ${prefix}${i}`, `S ${prefix}${i}`, [prov(src), ...extra]));

  it("B-2-20 a proposition belongs only to the source of its first surviving point", () => {
    const merged = mergeNodes([node("n_1", "A", "a", [prov("c2"), prov("c1")]), node("n_1", "A", "a", [prov("c1")])]);
    expect(birthSource(merged[0].provenance)).toBe("c2");
    expect(birthSource([])).toBeNull();
  });

  it("B-2-23 a cluster needs 3 propositions and takes the title as its label, with an unlabelled gap for a lost record", () => {
    const nodes = mergeNodes([...many("c1", "p", MIN_CLUSTER_SIZE), ...many("c2", "q", MIN_CLUSTER_SIZE - 1), ...many("gone", "r", 4)]);
    const clusters = deriveClusters(nodes, [], labels);
    expect(clusters.map((c) => [c.id, c.label, c.members.length])).toEqual([["gone", null, 4], ["c1", "Chat one", 3]]);
  });

  it("B-2-21 B-2-22 when a source is deleted its propositions fall to the earliest remaining contributor", () => {
    const before = mergeNodes(many("c1", "p", 3).map((n) => ({ ...n, provenance: [prov("c1"), prov("c2")] })));
    expect(deriveClusters(before, [], labels)[0].id).toBe("c1");
    const after = mergeNodes(many("c1", "p", 3).map((n) => ({ ...n, provenance: [prov("c2")] })));
    expect(deriveClusters(after, [], labels)[0].id).toBe("c2");
  });

  it("B-2-26 B-2-27 a junction joins the majority home, the tie goes to its own source, and a dangling junction mints nothing", () => {
    const nodes = mergeNodes([...many("c1", "a", 3), ...many("c2", "b", 3)]);
    const majority = chain("arg_1", ["a0", "a1", "b0"], "b1", [prov("c2")]);
    const tie = chain("arg_2", ["a0", "b0"], "b1", [prov("c2")]);
    const tieNoOwn = chain("arg_3", ["a0", "b0"], "b2", []);
    const none = chain("arg_4", ["zz1", "zz2"], "b2", [prov("c1")]);
    const clusters = deriveClusters(nodes, mergeChains([majority, tie, tieNoOwn, none]), labels);
    const members = (id: string) => clusters.find((c) => c.id === id)!.members;
    expect(members("c1")).toEqual(["a0", "a1", "a2", "arg_1", "arg_3"]);
    expect(members("c2")).toEqual(["b0", "b1", "b2", "arg_2"]);
    expect([...members("c1"), ...members("c2")]).not.toContain("arg_4");
  });
});

describe("labels", () => {
  it("removes only the last extension of a file name", () => {
    expect(fileLabel("Physics/Entropy notes.md")).toBe("Entropy notes");
    expect(fileLabel("notes/archive.tar.gz")).toBe("archive.tar");
    expect(fileLabel("README")).toBe("README");
    expect(fileLabel(".hidden")).toBe(".hidden");
  });
});
