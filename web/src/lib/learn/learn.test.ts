import { afterEach, describe, expect, it, vi } from "vitest";
import { claimOf, costWords, learnKnowledge, statusWords } from "./knowledge";
import { LearnApiError } from "./models";
import { ensureFocus, moveFocus, type NavRow } from "./nav";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";
import { consentExplanation, dateWord, learnSources, parseGlobs } from "./sources";

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const sent = typeof init.body === "string" && init.body !== "" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method: init.method ?? "GET", body: sent });
      const r = handler(url, init);
      const status = r.status ?? 200;
      return { ok: status >= 200 && status < 300, status, text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)) } as Response;
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("sources client (routes 38, 40 to 46)", () => {
  it("sends each call to its route with its method and body", async () => {
    const calls = fakeFetch((url) => (url.includes("/files") ? { body: { files: [] } } : url.endsWith("/sources") ? { body: { roots: [], root: { id: "root_1" } } } : { body: { ok: true } }));
    await learnSources.roots();
    await learnSources.add({ kind: "notes", path: "C:/n" });
    await learnSources.change("root_1", { enabled: false, hostedConsent: true });
    await learnSources.remove("root_1", "delete-nodes");
    await learnSources.scan("root_1");
    await learnSources.extract("root_1", { paths: ["a.md"] });
    await learnSources.extract("root_1", { confirm: true });
    await learnSources.files("root_1");
    await learnSources.passage("src_1", 3, 9);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/learn/sources",
      "POST /api/learn/sources",
      "PATCH /api/learn/sources/root_1",
      "DELETE /api/learn/sources/root_1?mode=delete-nodes",
      "POST /api/learn/sources/root_1/scan",
      "POST /api/learn/sources/root_1/extract",
      "POST /api/learn/sources/root_1/extract",
      "GET /api/learn/sources/root_1/files",
      "GET /api/learn/passage?source=src_1&from=3&to=9",
    ]);
    expect(calls[2].body).toEqual({ enabled: false, hostedConsent: true });
    expect(calls[5].body).toEqual({ paths: ["a.md"] });
    expect(calls[6].body).toEqual({ confirm: true });
  });

  it("raises the sentence of the server on a refusal, with its code", async () => {
    fakeFetch(() => ({ status: 403, body: { error: "The path is not allowed.", code: "forbidden_path" } }));
    const err = await learnSources.add({ kind: "notes", path: "C:/Windows" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LearnApiError);
    expect((err as Error).message).toBe("The path is not allowed.");
  });

  it("encodes an id that holds odd characters", async () => {
    const calls = fakeFetch(() => ({ body: { files: [] } }));
    await learnSources.files("a/b c");
    expect(calls[0].url).toBe("/api/learn/sources/a%2Fb%20c/files");
  });
});

describe("knowledge client (routes 30 to 37 and 50)", () => {
  it("sends each call to its route", async () => {
    const calls = fakeFetch((url) => (url.endsWith("/status") ? { body: { runs: [{ phase: "extracting", title: "entropy.md" }] } } : url.endsWith("/positions") ? { body: { positions: { a: { x: 1, y: 2 } } } } : { body: {} }));
    await learnKnowledge.graph();
    await learnKnowledge.graph("internal");
    expect(await learnKnowledge.status()).toEqual([{ phase: "extracting", title: "entropy.md" }]);
    await learnKnowledge.costs();
    expect(await learnKnowledge.commitPositions({ a: { x: 1, y: 2 } })).toEqual({ a: { x: 1, y: 2 } });
    await learnKnowledge.renderSettings();
    await learnKnowledge.deleteNode("n_1");
    await learnKnowledge.ratify({ claim: claimOf("n_0123456789ab"), status: "rejected", reason: "Wrong." });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/learn/graph",
      "GET /api/learn/graph?max=internal",
      "GET /api/learn/graph/status",
      "GET /api/learn/graph/costs",
      "PUT /api/learn/graph/positions",
      "GET /api/learn/graph/render-settings",
      "DELETE /api/learn/graph/nodes/n_1",
      "POST /api/learn/graph/ratify",
    ]);
    expect(calls[7].body).toEqual({ claim: "claim:0123456789ab", status: "rejected", reason: "Wrong." });
  });

  it("reads the locators of a proposition and leaves a missing route to the caller", async () => {
    const calls = fakeFetch(() => ({ body: { locators: [{ nodeId: "n_1" }] } }));
    expect(await learnKnowledge.locators("n_1")).toHaveLength(1);
    expect(calls[0].url).toBe("/api/learn/locators?node=n_1");
    fakeFetch(() => ({ status: 404, body: { error: "The route is not available in this build.", code: "not_found" } }));
    await expect(learnKnowledge.locators("n_1")).rejects.toThrow(/not available/);
  });

  it("words the status and the cost, with words for what is not known", () => {
    expect(statusWords(null)).toBe("Status not read");
    expect(statusWords([])).toBe("No extraction running");
    expect(statusWords([{ phase: "auditing", title: "risk.md" } as never])).toBe("Checking: risk.md");
    expect(statusWords([{ phase: "queued", title: "a" }, { phase: "queued", title: "b" }] as never)).toBe("2 extractions running");
    expect(costWords(null)).toBe("Cost not read");
    expect(costWords({ cost: null, unpriced: 0, runs: [] })).toBe("No runs yet");
    expect(costWords({ cost: null, unpriced: 2, runs: [{ id: "r", title: "t", at: "x", cost: null }] })).toBe("Not priced");
    expect(costWords({ cost: 0.004, unpriced: 0, runs: [] })).toBe("Under $0.01");
    expect(costWords({ cost: 1.234, unpriced: 1, runs: [] })).toBe("$1.23, 1 not priced");
  });
});

describe("helpers", () => {
  it("splits a pattern list typed on lines or with commas", () => {
    expect(parseGlobs("a/**\n b/** ,, c")).toEqual(["a/**", "b/**", "c"]);
  });

  it("explains what a hosted provider may receive, which needs consent only for a confidential root", () => {
    expect(consentExplanation({ sensitivity: "internal", hostedConsentAt: null })).toMatch(/not client confidential, so the model that you chose may read it/);
    expect(consentExplanation({ sensitivity: "public", hostedConsentAt: null })).toMatch(/not client confidential/);
    expect(consentExplanation({ sensitivity: "client-confidential", hostedConsentAt: null })).toMatch(/only Claude Code, which runs under your own agreement with Anthropic, or a model on your own computer or network may read it/);
    expect(consentExplanation({ sensitivity: "client-confidential", hostedConsentAt: "2026-11-01T10:00:00Z" })).toMatch(/Switch it off to stop any further text going to a hosted provider/);
    expect(dateWord("2026-11-01T10:05:00Z")).toBe("1 November 2026 at 10:05 UTC");
    expect(dateWord(null)).toBe("Not recorded");
  });

  it("matches fuzzily, ranks exact above prefix above substring, and matches everything for an empty query (B-6-52)", () => {
    expect(fuzzyScore("", ["a"])).toBe(0);
    expect(fuzzyScore("HEAT", ["heat flow"])).not.toBeNull();
    const exact = fuzzyScore("heat", ["heat"])!;
    const prefix = fuzzyScore("heat", ["heating"])!;
    const sub = fuzzyScore("heat", ["the heat"])!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(sub);
    expect(fuzzyScore("heat flow", ["heat", "flow"])).not.toBeNull();
    expect(fuzzyScore("heat zzz", ["heat"])).toBeNull();
    expect(fuzzyScore("eaf", ["heat flow"])!).toBeGreaterThan(fuzzyScore("etf", ["heat flow"])!);
    expect(fuzzyFilter(["heating", "heat", "the heat"], "heat", (s) => [s])).toEqual(["heat", "heating", "the heat"]);
  });
});

describe("keyboard navigation of the tree (B-6-01 to B-6-04)", () => {
  const rows: NavRow[] = [
    { id: "a", parentId: null, hasChildren: true, open: true },
    { id: "a1", parentId: "a", hasChildren: true, open: true },
    { id: "a1x", parentId: "a1", hasChildren: false, open: false },
    { id: "a2", parentId: "a", hasChildren: false, open: false },
    { id: "b", parentId: null, hasChildren: true, open: false },
  ];

  it("starts at the first top level row when focus is empty or stale", () => {
    expect(ensureFocus(rows, null)).toBe("a");
    expect(ensureFocus(rows, "gone")).toBe("a");
    expect(ensureFocus(rows, "a2")).toBe("a2");
    expect(ensureFocus([], null)).toBeNull();
  });

  it("moves among siblings, skips open descendants, stops at the ends and never crosses a parent", () => {
    expect(moveFocus(rows, "a", "ArrowDown").focus).toBe("b");
    expect(moveFocus(rows, "b", "ArrowDown").focus).toBe("b");
    expect(moveFocus(rows, "a", "ArrowUp").focus).toBe("a");
    expect(moveFocus(rows, "a1", "ArrowDown").focus).toBe("a2");
    expect(moveFocus(rows, "a2", "ArrowDown").focus).toBe("a2");
    expect(moveFocus(rows, "a1x", "ArrowUp").focus).toBe("a1x");
  });

  it("opens a closed row on Right, enters the first child of an open row and does nothing on a leaf", () => {
    expect(moveFocus(rows, "b", "ArrowRight")).toEqual({ focus: "b", toggle: { id: "b", open: true } });
    expect(moveFocus(rows, "a", "ArrowRight").focus).toBe("a1");
    expect(moveFocus(rows, "a2", "ArrowRight")).toEqual({ focus: "a2" });
  });

  it("closes an open row on Left, and from any other row returns to the parent and closes it", () => {
    expect(moveFocus(rows, "a", "ArrowLeft")).toEqual({ focus: "a", toggle: { id: "a", open: false } });
    expect(moveFocus(rows, "a2", "ArrowLeft")).toEqual({ focus: "a", toggle: { id: "a", open: false } });
    expect(moveFocus(rows, "b", "ArrowLeft")).toEqual({ focus: "b" });
  });

  it("follows the rows that are on show and not a separate inventory", () => {
    const filtered = rows.filter((r) => r.id === "b" || r.id === "a");
    expect(moveFocus(filtered, "a", "ArrowDown").focus).toBe("b");
    expect(moveFocus(filtered, "a1", "ArrowUp").focus).toBe("a");
  });
});
