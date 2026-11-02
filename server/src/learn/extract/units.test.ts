import { describe, expect, it } from "vitest";
import { visibleMessage } from "../knowledge/coverage.ts";
import type { MergedNode } from "../knowledge/ledger.ts";
import { runAuditor } from "./auditor.ts";
import { batchTag, chunkBudget, chunkFile, linesOf, messageBatches, messageStartLines } from "./chunk.ts";
import { buildDigest, checkFindings, healSubmission, runExtractor } from "./extractor.ts";
import { locateQuote, locatorContext, locatorLine } from "./locate.ts";
import { auditorPrompt, extractorPrompt } from "./prompts/index.ts";
import { AbortedError, Semaphore } from "./semaphore.ts";
import { auditorReply, scriptedEngine, type Call } from "./test-support.ts";

describe("chunk budget", () => {
  // B-5-20 and the limits table
  it("reads the setting, keeps a floor of 500 and falls back to 4096", () => {
    expect(chunkBudget()).toBe(4096);
    expect(chunkBudget({ graph: { extractionChunkTokens: 9000 } })).toBe(9000);
    expect(chunkBudget({ graph: { extractionChunkTokens: 100 } })).toBe(500);
    expect(chunkBudget({ graph: { extractionChunkTokens: Number.NaN } })).toBe(4096);
    expect(chunkBudget({ graph: { extractionChunkTokens: "x" as never } })).toBe(4096);
  });
});

describe("chunking a file", () => {
  const text = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} ${"a".repeat(90)}`).join("\n");

  it("never splits a line, labels each chunk with the file and the part, and keeps the line numbers", () => {
    const chunks = chunkFile("Vault/a.md", text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    const all = linesOf(text);
    let next = 1;
    for (const [i, c] of chunks.entries()) {
      expect(c.segment.firstLine).toBe(next);
      expect(c.segment.lines).toEqual(all.slice(next - 1, next - 1 + c.segment.lines.length));
      expect(c.view.startsWith(`File: Vault/a.md (part ${i + 1} of ${chunks.length})\n\n`)).toBe(true);
      expect(Math.ceil(c.text.length / 4)).toBeLessThanOrEqual(500);
      next += c.segment.lines.length;
    }
    expect(next - 1).toBe(all.length);
  });

  it("puts a line that is over the budget in a chunk of its own, and names no part for one chunk", () => {
    const big = "b".repeat(5000);
    const chunks = chunkFile("a.md", `small\n${big}\nsmall`, 500);
    expect(chunks.map((c) => c.segment.lines.length)).toEqual([1, 1, 1]);
    expect(chunks[1].text).toBe(big);
    expect(chunkFile("a.md", "one\ntwo", 500)[0].view).toBe("File: a.md\n\none\ntwo");
  });

  it("gives no chunk for a text with no visible character", () => {
    expect(chunkFile("a.md", "  \n\n\t", 500)).toEqual([]);
    expect(chunkFile("a.md", "", 500)).toEqual([]);
  });
});

describe("batches of messages", () => {
  const msg = (id: string, chars: number) => visibleMessage("USER", id, ["z".repeat(chars)]);

  it("fills batches greedily with whole messages, leaves out covered ones and gives an oversize message its own batch", () => {
    const view = [msg("m1", 1000), msg("m2", 1000), msg("m3", 4000), msg("m4", 100)];
    const out = messageBatches(view, [{ fp: view[0].fp }], 500);
    expect(out.map((b) => b.ids)).toEqual([["m2"], ["m3"], ["m4"]]);
    expect(out[0].view).toBe(view[1].lines.join("\n"));
    expect(messageBatches(view, [], 10_000).map((b) => b.ids)).toEqual([["m1", "m2", "m3", "m4"]]);
    expect(messageBatches([], [], 500)).toEqual([]);
  });

  // B-5-40
  it("tags a batch by the fingerprints in order", () => {
    const a = msg("m1", 10);
    const b = msg("m2", 10);
    expect(batchTag([a, b])).toMatch(/^[0-9a-f]{12}$/);
    expect(batchTag([a, b])).toBe(batchTag([a, b]));
    expect(batchTag([a, b])).not.toBe(batchTag([b, a]));
  });

  it("finds the first line of each message in the joined view", () => {
    expect(messageStartLines(["a\nb", "c", "d\ne\nf"])).toEqual([1, 4, 6]);
  });
});

describe("locating a quote", () => {
  const chunk = "alpha beta\n\ngamma   delta\nepsilon";

  it("collapses white space, keeps case and maps the match to lines of the whole text", () => {
    expect(locateQuote(chunk, "gamma delta", 10)).toEqual({ found: true, startLine: 12, endLine: 12 });
    expect(locateQuote(chunk, "beta gamma", 10)).toEqual({ found: true, startLine: 10, endLine: 12 });
    expect(locateQuote(chunk, "delta\n epsilon", 1)).toEqual({ found: true, startLine: 3, endLine: 4 });
    expect(locateQuote(chunk, "Gamma", 1).found).toBe(false);
    expect(locateQuote(chunk, "", 1).found).toBe(false);
    expect(locateQuote(chunk, undefined, 1).found).toBe(false);
    expect(locateQuote(chunk, "x".repeat(281), 1).found).toBe(false);
  });

  it("finds the nearest heading and the page of a PDF marker", () => {
    const text = "# One\n--- Page 1 ---\nfirst\n## Two\n--- Page 2 ---\nsecond words here";
    const ctx = locatorContext("pdf", text);
    const where = locateQuote(text, "second words", 1);
    const line = locatorLine("n_1", "src_1", "h", "second words", where, ctx, "t");
    expect(line).toMatchObject({ found: true, startLine: 6, heading: "Two", page: 2 });
    const none = locatorLine("n_1", "src_1", "h", "absent words", locateQuote(text, "absent words", 1), ctx, "t");
    expect(none).toMatchObject({ found: false, startLine: null, endLine: null, heading: null, page: null, quote: "absent words" });
  });
});

describe("the semaphore", () => {
  it("serves waiters in the order they came", async () => {
    const s = new Semaphore(1);
    const order: number[] = [];
    const first = await s.acquire();
    const waits = [1, 2, 3].map((n) => s.acquire().then((release) => (order.push(n), release)));
    expect(s.waiting).toBe(3);
    first();
    for (const w of waits) (await w)();
    expect(order).toEqual([1, 2, 3]);
    expect(s.active).toBe(0);
  });

  // the double count that once deadlocked LearnHarness
  it("hands the permit of an aborted waiter to the next live waiter without counting it twice", async () => {
    const s = new Semaphore(1);
    const holder = await s.acquire();
    const ac = new AbortController();
    const dead = s.acquire(ac.signal);
    const live = s.acquire();
    ac.abort();
    await expect(dead).rejects.toBeInstanceOf(AbortedError);
    expect(s.waiting).toBe(1);
    holder();
    const release = await live;
    expect(s.active).toBe(1);
    release();
    release();
    expect(s.active).toBe(0);
    const again = await s.acquire();
    expect(s.active).toBe(1);
    again();
  });

  it("ignores an abort that comes after the permit was handed over", async () => {
    const s = new Semaphore(1);
    const holder = await s.acquire();
    const ac = new AbortController();
    const waiter = s.acquire(ac.signal);
    holder();
    const release = await waiter;
    ac.abort();
    expect(s.active).toBe(1);
    release();
    expect(s.active).toBe(0);
    await expect(s.acquire(ac.signal)).rejects.toBeInstanceOf(AbortedError);
    expect(s.active).toBe(0);
  });

  it("rejects a limit below one", () => {
    expect(() => new Semaphore(0)).toThrow();
  });
});

describe("the rules of submit_findings", () => {
  const ctx = (extra: Record<string, unknown> = {}) => ({ shape: "notes" as const, existingIds: new Set(["n_aaaaaaaaaaaa"]), ...extra });
  const prop = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Name ${id}`, statement: `Statement of ${id}.`, ...extra });

  // B-5-18, B-5-21
  it("needs both fields and rejects an empty chain, a conclusion among the premises and an unknown endpoint", () => {
    expect(checkFindings({ propositions: [] }, ctx())).toMatchObject({ ok: false });
    expect(checkFindings({ propositions: [], chains: [] }, ctx())).toMatchObject({ ok: true });
    const bad = (chains: unknown[]) => checkFindings({ propositions: [prop("p1"), prop("p2")], chains }, ctx());
    expect(bad([{ premises: [], conclusion: "p1" }])).toMatchObject({ ok: false });
    expect(bad([{ premises: ["p1", "p2"], conclusion: "p2" }])).toMatchObject({ ok: false, errors: [expect.stringContaining("among its premises")] });
    expect(bad([{ premises: ["p1"], conclusion: "p3" }])).toMatchObject({ ok: false, errors: [expect.stringContaining("p3")] });
    expect(bad([{ premises: ["p1", "n_aaaaaaaaaaaa"], conclusion: "p2" }])).toMatchObject({ ok: true });
    expect(bad([{ edges: [] }])).toMatchObject({ ok: false });
  });

  it("strips a stray messageId from a note and requires a valid one for a transcript or a session", () => {
    const notes = checkFindings({ propositions: [prop("p1", { messageId: "m1" })], chains: [] }, ctx());
    expect(notes.ok && notes.findings.propositions[0].messageId).toBeUndefined();
    const anchors = new Set(["m1", "m2"]);
    const session = (messageId?: string) => checkFindings({ propositions: [prop("p1", messageId === undefined ? {} : { messageId })], chains: [] }, ctx({ shape: "session", anchors }));
    expect(session()).toMatchObject({ ok: false, errors: [expect.stringContaining("needs a messageId")] });
    expect(session("")).toMatchObject({ ok: false });
    expect(session("m9")).toMatchObject({ ok: false, errors: [expect.stringContaining("Use one of: m1, m2")] });
    expect(session("m2")).toMatchObject({ ok: true });
  });

  // B-5-04
  it("heals a stringified array and fills missing aliases", () => {
    const healed = healSubmission({ propositions: JSON.stringify([{ ...prop("p1"), aliases: '["a","b"]' }]), chains: "[]" }) as never;
    const r = checkFindings(healed, ctx());
    expect(r.ok && r.findings.propositions[0].aliases).toEqual(["a", "b"]);
    const none = checkFindings({ propositions: [prop("p1")], chains: [] }, ctx());
    expect(none.ok && none.findings.propositions[0].aliases).toEqual([]);
  });

  it("reports a proposition without a name or a statement", () => {
    const r = checkFindings({ propositions: [{ id: "p1", name: "", statement: "x" }, { id: "p2", name: "y", statement: " " }], chains: [] }, ctx());
    expect(r).toMatchObject({ ok: false, errors: [expect.stringContaining("no name"), expect.stringContaining("no statement")] });
  });
});

describe("the digest of a source", () => {
  const node = (id: string, name: string, chat: string): MergedNode => ({ id, name, statement: `${name} is stated.`, aliases: [], createdAt: "t", provenance: [{ chatId: chat, messageId: "" }] });

  it("lists the propositions and arguments of that source only, with ids verbatim, and is empty for a barren source", () => {
    const nodes = [node("n_1", "One", "src_a"), node("n_2", "Two", "src_a"), node("n_3", "Three", "src_b")];
    const chains = [
      { id: "arg_1", premises: ["n_1"], conclusion: "n_2", createdAt: "t", provenance: [{ chatId: "src_a", messageId: "" }], key: "n_1>n_2" },
      { id: "arg_2", premises: ["n_3"], conclusion: "n_2", createdAt: "t", provenance: [{ chatId: "src_b", messageId: "" }], key: "n_3>n_2" },
    ];
    const d = buildDigest("src_a", nodes, chains);
    expect(d).toContain("- n_1 | One | One is stated.");
    expect(d).toContain("- n_2 | Two | Two is stated.");
    expect(d).not.toContain("n_3");
    expect(d).toContain("n_1 (One) => n_2 (Two)");
    expect(buildDigest("src_none", nodes, chains)).toBe("");
  });
});

describe("the prompts", () => {
  it("write the core and a framing for each kind of source, and the auditor rules", () => {
    for (const shape of ["notes", "transcript", "session"] as const) {
      const p = extractorPrompt(shape);
      expect(p).toContain("submit_findings");
      expect(p).toContain("quote");
      expect(p).toContain("never holds a statement about the learner");
    }
    expect(extractorPrompt("session")).toContain("TEACHER");
    expect(extractorPrompt("transcript")).toContain("USER");
    expect(extractorPrompt("notes")).not.toContain("messageId");
    expect(auditorPrompt()).toContain("submit_review");
    expect(auditorPrompt()).toContain("find_candidates");
    for (const p of [extractorPrompt("notes"), auditorPrompt()]) {
      expect(p).not.toMatch(/;/);
      expect(p).not.toMatch(/—|–/);
    }
  });
});

describe("the extractor agent", () => {
  it("gives the model the digest before the passage and ends after the first clean call", async () => {
    const { engine, calls } = scriptedEngine(() => ({ tool: "submit_findings", args: { propositions: [], chains: [] } }));
    const out = await runExtractor({ engine, ctx: { shape: "notes", existingIds: new Set() }, digest: "Record of earlier work", view: "File: a.md\n\ntext" });
    expect(out.findings).toEqual({ propositions: [], chains: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].user.startsWith("Record of earlier work\n\n---\n\nFile: a.md")).toBe(true);
  });

  it("nudges a model that answers in prose", async () => {
    const { engine, calls } = scriptedEngine((c: Call) => (c.turn === 0 ? { text: "Here is my answer." } : { tool: "submit_findings", args: { propositions: [], chains: [] } }));
    const out = await runExtractor({ engine, ctx: { shape: "notes", existingIds: new Set() }, digest: "", view: "x" });
    expect(out.findings).not.toBeNull();
    expect(calls).toHaveLength(2);
  });
});

describe("the auditor agent", () => {
  const node = (i: number, extra = ""): MergedNode => ({
    id: `n_${String(i).padStart(12, "0")}`,
    name: `Alpha idea ${i}`,
    statement: `The alpha rule number ${i} applies to every bucket ${extra}`,
    aliases: [],
    createdAt: "t",
    provenance: [{ chatId: "src_x", messageId: "" }],
  });
  const nodes = Array.from({ length: 12 }, (_, i) => node(i + 1, i === 11 ? "zeta" : ""));
  const finding = { id: "p1", name: "Alpha bucket rule", statement: "The alpha rule applies to every bucket", aliases: [] };

  // B-5-44, B-5-45
  it("makes no model call when there is nothing to compare", async () => {
    const { engine, calls } = scriptedEngine(() => auditorReply());
    expect(await runAuditor({ engine, findings: [finding], nodes: [] })).toMatchObject({ ran: false, done: true });
    expect(await runAuditor({ engine, findings: [], nodes })).toMatchObject({ ran: false });
    expect(calls).toHaveLength(0);
  });

  it("shows five candidates a page, continues with a cursor without overlap, and returns bad calls as errors", async () => {
    const results: string[] = [];
    const { engine, calls } = scriptedEngine((c) => {
      if (c.turn > 0) results.push(c.result);
      switch (c.turn) {
        case 0:
          return { tool: "find_candidates", args: { propositions: [{ id: "p1" }], cursor: "x" } };
        case 1:
          return { tool: "find_candidates", args: { propositions: [{ id: "nope" }] } };
        case 2:
          return { tool: "find_candidates", args: { propositions: [{ id: "p1", hints: ["zeta"] }] } };
        case 3: {
          const first = JSON.parse(c.result) as { findings: { cursor: string }[] };
          return { tool: "find_candidates", args: { cursor: first.findings[0].cursor } };
        }
        case 4:
          return { tool: "find_candidates", args: { cursor: "unknown" } };
        case 5:
          return { tool: "submit_review", args: { links: [{ id: "p1", linkTo: "n_missing" }] } };
        default:
          return auditorReply([{ id: "p1", linkTo: nodes[0].id }]);
      }
    });
    const out = await runAuditor({ engine, findings: [finding], nodes });
    expect(out).toMatchObject({ ran: true, done: true });
    expect(out.links.get("p1")).toBe(nodes[0].id);
    // the first message already holds the first page
    const first = JSON.parse(calls[0].user.split(/\r?\n/).pop() as string) as { findings: { candidates: string[]; total: number; hasMore: boolean; cursor: string | null }[] };
    expect(first.findings[0].candidates).toHaveLength(5);
    expect(first.findings[0]).toMatchObject({ total: 12, hasMore: true });
    expect(first.findings[0].cursor).not.toBeNull();
    expect(results[0]).toContain("either propositions or a cursor");
    expect(results[1]).toContain("not a new proposition");
    // the hint brings the zeta proposition into the first page
    const hinted = JSON.parse(results[2]) as { findings: { candidates: string[] }[] };
    expect(hinted.findings[0].candidates[0]).toBe(nodes[11].id);
    // the cursor continues a search without repeating a candidate
    const next = JSON.parse(results[3]) as { findings: { candidates: string[]; offset: number }[] };
    expect(next.findings[0].offset).toBe(5);
    expect(next.findings[0].candidates.filter((id) => hinted.findings[0].candidates.includes(id))).toEqual([]);
    expect(results[4]).toContain("cursor is not known");
    expect(results[5]).toContain("was not offered");
  });

  it("lists each candidate body once when two propositions share it", async () => {
    const { engine, calls } = scriptedEngine(() => auditorReply());
    await runAuditor({ engine, findings: [finding, { ...finding, id: "p2" }], nodes: nodes.slice(0, 2) });
    const shown = JSON.parse(calls[0].user.split(/\r?\n/).pop() as string) as { candidates: Record<string, unknown>; findings: { candidates: string[] }[] };
    expect(Object.keys(shown.candidates)).toHaveLength(2);
    expect(shown.findings.map((f) => f.candidates.length)).toEqual([2, 2]);
  });

  it("reports a model that never submits a review", async () => {
    const { engine } = scriptedEngine(() => ({ text: "I would link nothing." }));
    const out = await runAuditor({ engine, findings: [finding], nodes });
    expect(out).toMatchObject({ ran: true, done: false });
  });
});
