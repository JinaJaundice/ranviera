import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChainLine, NodeLine } from "../../../../shared/learn/knowledge.ts";
import type { LocatorLine } from "../../../../shared/learn/sources.ts";
import { cleanupTempDirs, node, open, prov, tempDir } from "../knowledge/test-support.ts";
import { locatorContext } from "./locate.ts";
import { mergeRun, PostMergeError, type MergeInput } from "./merge-run.ts";
import { appendSourceUsage, foldCosts, RunTally } from "./usage.ts";
import type { Findings } from "./types.ts";

cleanupTempDirs();

const NOW = new Date("2026-11-02T09:00:00.000Z");

function setup() {
  const dir = tempDir();
  const knowledge = open(dir);
  let n = 0;
  const deps = { knowledge, now: () => NOW, newKey: () => (++n).toString(16).padStart(12, "0") };
  const read = <T>(f: string): T[] => {
    const file = `${dir}/${f}`;
    return fs.existsSync(file) ? (fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) as T[]) : [];
  };
  return { dir, knowledge, deps, nodes: () => read<NodeLine>("graph/nodes.jsonl"), chains: () => read<ChainLine>("graph/chains.jsonl"), locators: () => read<LocatorLine>("cortex/locators.jsonl") };
}

const p = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Name ${id}`, statement: `Statement of ${id}.`, aliases: [] as string[], ...extra });
const input = (sourceId: string, findings: Findings, over: Partial<MergeInput> = {}): MergeInput => ({
  sourceId,
  shape: "notes",
  findings,
  links: new Map(),
  chunk: null,
  locator: null,
  fileSha256: "sha",
  ...over,
});

describe("resolution", () => {
  // B-2-01, B-2-03
  it("creates a node for each new proposition, resolves a repeated local id once and rebuilds the provenance", () => {
    const s = setup();
    const r = mergeRun(s.deps, input("src_a", { propositions: [p("p1"), p("p1", { statement: "A second use of the label." }), p("p2")], chains: [] }));
    expect(r.stats).toEqual({ nodes: 2, chains: 0 });
    expect(s.nodes().map((n) => n.id)).toEqual(["n_000000000001", "n_000000000002"]);
    expect(s.nodes()[0]).toMatchObject({ createdAt: NOW.toISOString(), provenance: [{ chatId: "src_a", messageId: "" }] });
  });

  it("appends a link line that adds the statement as an alias, with the anchor of the proposition", () => {
    const s = setup();
    s.knowledge.appendNodes([node("n_existing0001", "Rate", "A bucket refills at a fixed rate.", [prov("src_a")])]);
    const r = mergeRun(
      s.deps,
      input("chat_1", { propositions: [p("p1", { statement: "Buckets refill steadily.", messageId: "msg_7" })], chains: [] }, { shape: "session", links: new Map([["p1", "n_existing0001"]]) }),
    );
    expect(r.stats.nodes).toBe(1);
    expect(r.nodeIds).toEqual(["n_existing0001"]);
    const last = s.nodes()[1];
    expect(last).toMatchObject({ id: "n_existing0001", statement: "Buckets refill steadily.", provenance: [{ chatId: "chat_1", messageId: "msg_7" }] });
  });

  // B-5-31: a redundant arrival is skipped silently
  it("skips a link that adds nothing and counts appends only", () => {
    const s = setup();
    s.knowledge.appendNodes([node("n_existing0001", "Rate", "A bucket refills.", [prov("src_a")], ["Buckets refill."])]);
    const same = { propositions: [p("p1", { statement: "Buckets refill.", aliases: ["A bucket refills."] })], chains: [] };
    const r = mergeRun(s.deps, input("src_a", same, { links: new Map([["p1", "n_existing0001"]]) }));
    expect(r.stats).toEqual({ nodes: 0, chains: 0 });
    expect(s.nodes()).toHaveLength(1);
  });

  it("makes a new node when the link names an id that is not in the graph", () => {
    const s = setup();
    const r = mergeRun(s.deps, input("src_a", { propositions: [p("p1")], chains: [] }, { links: new Map([["p1", "n_gone"]]) }));
    expect(r.stats.nodes).toBe(1);
    expect(s.nodes()[0].id).toBe("n_000000000001");
  });
});

describe("chains", () => {
  const props = ["a", "b", "c", "x", "y"].map((id) => p(id));

  // B-5-16, B-5-17
  it("stores co premises as one argument, collapses duplicates and drops a premise equal to the conclusion", () => {
    const s = setup();
    const r = mergeRun(
      s.deps,
      input("src_a", { propositions: props, chains: [{ premises: ["a", "b", "a", "x"], conclusion: "x" }, { premises: ["a", "b"], conclusion: "x" }, { premises: ["a", "b"], conclusion: "x" }, { premises: ["x"], conclusion: "x" }] }),
    );
    expect(r.stats.chains).toBe(1);
    expect(s.chains()[0].premises).toHaveLength(2);
  });

  it("skips a chain whose conclusion resolves nowhere", () => {
    const s = setup();
    const r = mergeRun(s.deps, input("src_a", { propositions: props, chains: [{ premises: ["a"], conclusion: "n_unknown" }] }));
    expect(r.stats.chains).toBe(0);
  });

  it("lets a chain name a proposition of the graph, skips a chain this source already asserted and unions a chain of another source", () => {
    const s = setup();
    s.knowledge.appendNodes([node("n_old000000001", "Old", "An old proposition.", [prov("src_a")])]);
    const first = mergeRun(s.deps, input("src_a", { propositions: [p("a")], chains: [{ premises: ["n_old000000001"], conclusion: "a" }] }));
    expect(first.stats.chains).toBe(1);
    const id = s.chains()[0].id;
    const again = mergeRun(s.deps, input("src_a", { propositions: [], chains: [{ premises: ["n_old000000001"], conclusion: s.nodes()[1].id }] }));
    expect(again.stats.chains).toBe(0);
    const other = mergeRun(s.deps, input("src_b", { propositions: [], chains: [{ premises: ["n_old000000001"], conclusion: s.nodes()[1].id }] }));
    expect(other.stats.chains).toBe(1);
    expect(s.chains()[1].id).toBe(id);
    expect(s.chains()[1].provenance).toEqual([{ chatId: "src_b", messageId: "" }]);
  });

  // B-5-29, B-5-30
  it("drops the argument that the ancestry of another argument covers, and reports the count", () => {
    const s = setup();
    mergeRun(s.deps, input("src_a", { propositions: props, chains: [{ premises: ["a", "b"], conclusion: "x" }, { premises: ["x", "c"], conclusion: "y" }] }));
    const r = mergeRun(s.deps, input("src_a", { propositions: [], chains: [{ premises: [s.nodes()[0].id, s.nodes()[1].id, s.nodes()[2].id], conclusion: s.nodes()[4].id }] }));
    expect(r.stats).toMatchObject({ nodes: 0, chains: 1, droppedChains: 1 });
    expect(s.chains()).toHaveLength(2);
    // the dropped lines are archived before they leave the ledger
    expect(fs.readdirSync(`${s.dir}/archive`)).toHaveLength(1);
  });
});

describe("the last writes", () => {
  it("writes the coverage and the checkpoint after the appends, so a failure leaves the batch uncovered", () => {
    const s = setup();
    s.knowledge.appendCoverage = () => {
      throw new Error("The coverage file is locked.");
    };
    let thrown: unknown;
    try {
      mergeRun(s.deps, input("chat_1", { propositions: [p("p1", { messageId: "m1" })], chains: [] }, { shape: "session", coverage: [{ fp: "fp1", tokens: 5 }] }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PostMergeError);
    expect((thrown as PostMergeError).committed).toMatchObject({ nodes: 1 });
    expect(s.nodes()).toHaveLength(1);
    expect(s.knowledge.readCoverage("chat_1")).toEqual([]);
  });

  it("appends one coverage line for each message and the whole file checkpoint", () => {
    const s = setup();
    mergeRun(s.deps, input("chat_1", { propositions: [], chains: [] }, { shape: "session", coverage: [{ fp: "fp1", tokens: 5 }, { fp: "fp2", tokens: 7 }], checkpoint: true }));
    expect(s.knowledge.readCoverage("chat_1")).toMatchObject([{ fp: "fp1", tokens: 5, foldedAt: NOW.toISOString() }, { fp: "fp2", tokens: 7 }]);
    expect(s.knowledge.readCheckpoints()).toEqual([{ chatId: "chat_1", foldedAt: NOW.toISOString() }]);
  });

  it("writes a locator for each proposition and source once, and a changed quote writes a new line", () => {
    const s = setup();
    const text = "# Head\n\nA bucket refills.\nIt has a capacity.";
    const ctx = locatorContext("notes", text);
    const run = (quote: string) => mergeRun(s.deps, input("src_a", { propositions: [p("p1", { quote })], chains: [] }, { chunk: { text, firstLine: 1 }, locator: ctx, links: new Map(s.nodes().length ? [["p1", s.nodes()[0].id]] : []) }));
    run("A bucket refills.");
    run("A bucket refills.");
    expect(s.locators()).toHaveLength(1);
    run("It has a capacity.");
    expect(s.locators().map((l) => [l.startLine, l.found])).toEqual([[3, true], [4, true]]);
    expect(s.locators()[0]).toMatchObject({ heading: "Head", fileSha256: "sha", at: NOW.toISOString() });
  });
});

describe("usage and costs", () => {
  it("appends a usage record once for each start time and does nothing for an unknown source", () => {
    const s = setup();
    s.knowledge.store.writeGraphJson("sources.json", { src_a: { id: "src_a", filePath: "Notes/a.md", importedAt: "t" } });
    const tally = new RunTally();
    tally.stage("extractor", "faux:m1")({ inputTokens: 100, outputTokens: 10 });
    const usage = tally.record(1000, "t", 5, { nodes: 1, chains: 0 });
    expect(appendSourceUsage(s.knowledge, "src_a", usage)).toBe(true);
    expect(appendSourceUsage(s.knowledge, "src_a", usage)).toBe(false);
    expect(appendSourceUsage(s.knowledge, "src_none", usage)).toBe(false);
    const saved = JSON.parse(fs.readFileSync(`${s.dir}/graph/sources.json`, "utf8"));
    expect(saved.src_a.extractions).toHaveLength(1);
    expect(saved.src_a.extractions[0]).toMatchObject({ startedAt: 1000, stages: { extractor: { model: "faux:m1", steps: [{ inputTokens: 100, outputTokens: 10 }] } } });
    expect(saved.src_a.extractions[0].stages.auditor).toBeUndefined();
  });

  // B-5-47 to B-5-50
  it("sums the priced runs, counts the unpriced, shows an unknown total when nothing is priced and caps the list at ten", () => {
    const priced = { provider: "p", id: "m", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
    const lookup = (provider: string, id: string) => (provider === "p" && id === "m" ? (priced as never) : undefined);
    const row = (i: number, model: string, steps: object[]) => ({ id: `r${i}`, title: `Run ${i}`, usage: { startedAt: i, at: `t${i}`, durationMs: 1, stats: { nodes: i, chains: 0 }, stages: steps.length ? { extractor: { model, steps } } : {} } });
    const step = { inputTokens: 1_000_000, outputTokens: 500_000, cacheWriteTokens: 0 };
    const folded = foldCosts([row(1, "p:m", [step]), row(2, "q:other", [step]), row(3, "p:m", []) ], lookup);
    expect(folded.cost).toBeCloseTo(2);
    expect(folded.unpriced).toBe(1);
    expect(folded.runs.map((r) => [r.id, r.cost])).toEqual([["r3", 0], ["r2", null], ["r1", 2]]);
    expect(foldCosts([row(1, "q:other", [step])], lookup)).toMatchObject({ cost: null, unpriced: 1 });
    expect(foldCosts([], lookup)).toEqual({ cost: 0, unpriced: 0, runs: [] });
    expect(foldCosts(Array.from({ length: 14 }, (_, i) => row(i + 1, "p:m", [step])), lookup).runs).toHaveLength(10);
  });
});
