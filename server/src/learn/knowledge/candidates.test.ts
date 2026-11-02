import { describe, expect, it } from "vitest";
import { B, CandidateIndex, CursorBook, K1, PAGE_SIZE, STOP_WORDS, tokenize } from "./candidates.ts";
import { mergeNodes } from "./ledger.ts";
import { node, prov } from "./test-support.ts";

const corpus = mergeNodes([
  node("n_01", "Heat flow", "Heat flows from hot bodies to cold bodies.", [prov("c1")]),
  node("n_02", "Heat engine", "A heat engine turns a flow of heat into work.", [prov("c1"), prov("s1")], ["Engines convert thermal energy into work"]),
  node("n_03", "Entropy", "Entropy measures how spread out energy is.", [prov("c2")]),
  node("n_04", "Second law", "The entropy of an isolated system never decreases.", [prov("c2")]),
  node("n_05", "Carnot limit", "No heat engine beats the Carnot efficiency.", [prov("s1")]),
  node("n_06", "Cold reservoir", "A heat engine rejects heat to a cold reservoir.", [prov("s1")]),
  node("n_07", "Hot reservoir", "A heat engine takes heat from a hot reservoir.", [prov("s1")]),
  node("n_08", "Not conserved", "Entropy is not conserved.", [prov("c2")]),
]);

describe("tokenize", () => {
  it("uses the constants of the contract and removes about 65 function words", () => {
    expect(K1).toBe(1.2);
    expect(B).toBe(0.75);
    expect(PAGE_SIZE).toBe(5);
    expect(STOP_WORDS.size).toBeGreaterThanOrEqual(60);
    expect(STOP_WORDS.size).toBeLessThanOrEqual(70);
  });

  it("lower cases, splits on anything but letters and digits, and keeps negations", () => {
    expect(tokenize("The Entropy is NOT conserved, in 2nd-law form.")).toEqual(["entropy", "not", "conserved", "2nd", "law", "form"]);
    expect(tokenize("Ｅｎｔｒｏｐｙ")).toEqual(["entropy"]);
  });
});

describe("candidate ranking", () => {
  const index = new CandidateIndex(corpus);

  it("ranks the paraphrase of a proposition first and the score only ranks", () => {
    const page = index.page({ name: "Engines", statement: "An engine converts heat flow into useful work." });
    expect(page.candidates[0].id).toBe("n_02");
    expect(page.candidates.length).toBeLessThanOrEqual(PAGE_SIZE);
    for (let i = 1; i < page.candidates.length; i++) expect(page.candidates[i].score).toBeLessThanOrEqual(page.candidates[i - 1].score);
  });

  it("scores the best text of a node, so an alias is matched without a penalty", () => {
    const page = index.page({ name: "x", statement: "thermal energy converted into work" });
    expect(page.candidates[0].id).toBe("n_02");
    expect(page.candidates[0].matchedAliases).toEqual(["Engines convert thermal energy into work"]);
    expect(page.candidates[0].sessions).toEqual(["c1", "s1"]);
  });

  it("breaks ties by identifier", () => {
    const twins = mergeNodes([node("n_b", "Same", "alpha beta"), node("n_a", "Same", "alpha beta"), node("n_c", "Other", "gamma")]);
    const ranked = new CandidateIndex(twins).rank({ name: "Same", statement: "alpha beta" });
    expect(ranked.map((c) => c.id)).toEqual(["n_a", "n_b"]);
  });

  it("pages five at a time and offers the next offset", () => {
    const first = index.page({ name: "heat engine", statement: "heat reservoir entropy" }, 0);
    expect(first.candidates).toHaveLength(5);
    expect(first.hasMore).toBe(true);
    const second = index.page({ name: "heat engine", statement: "heat reservoir entropy" }, first.nextOffset ?? 0);
    expect(second.offset).toBe(5);
    expect(new Set([...first.candidates, ...second.candidates].map((c) => c.id)).size).toBe(first.candidates.length + second.candidates.length);
    expect(index.page({ name: "heat engine", statement: "heat reservoir entropy" }, 0)).toEqual(first);
  });

  it("returns no candidate when no word matches, and excludes given ids", () => {
    expect(index.page({ name: "zzz", statement: "qqq" }).candidates).toEqual([]);
    expect(index.rank({ name: "entropy", statement: "entropy" }, new Set(["n_03"])).map((c) => c.id)).not.toContain("n_03");
  });

  it("refuses a bad offset", () => {
    expect(() => index.page({ name: "a", statement: "b" }, -1)).toThrowError(/offset/);
    expect(() => index.page({ name: "a", statement: "b" }, 1.5)).toThrowError(/offset/);
  });
});

describe("cursors", () => {
  it("walks the pages of one query and refuses an unknown cursor", () => {
    const index = new CandidateIndex(corpus);
    const book = new CursorBook(index);
    const first = book.first({ name: "heat engine", statement: "heat reservoir entropy" });
    expect(first.nextCursor).not.toBeNull();
    const second = book.next(first.nextCursor as string);
    expect(second.page.offset).toBe(5);
    expect(second.page.candidates.map((c) => c.id)).toEqual(index.rank({ name: "heat engine", statement: "heat reservoir entropy" }).slice(5, 10).map((c) => c.id));
    expect(() => book.next("nope")).toThrowError(/cursor/);
  });
});
