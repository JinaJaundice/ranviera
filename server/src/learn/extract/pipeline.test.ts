import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChainLine, NodeLine } from "../../../../shared/learn/knowledge.ts";
import type { LocatorLine } from "../../../../shared/learn/sources.ts";
import { LearnError } from "../models/errors.ts";
import { Semaphore } from "./semaphore.ts";
import {
  auditorReply,
  cleanupEnvs,
  deferred,
  extractorReply,
  lines,
  linkFirst,
  scanned,
  setupEnv,
  shownCandidates,
  untilAborted,
  write,
  type Call,
  type Deferred,
  type Env,
  type Reply,
} from "./test-support.ts";

cleanupEnvs();

const NOTE = "# Rates\n\nA token bucket refills at a fixed rate up to a fixed capacity.\nA full bucket cannot hold more tokens than its capacity.\n";

const bucket = (extra: Record<string, unknown> = {}) => ({
  id: "p1",
  name: "Token bucket refill",
  statement: "A token bucket refills at a fixed rate up to a fixed capacity.",
  quote: "A token bucket refills at a fixed rate up to a fixed capacity.",
  ...extra,
});
const capacity = () => ({
  id: "p2",
  name: "Bucket capacity",
  statement: "A full token bucket cannot hold more tokens than its capacity.",
  quote: "A full bucket cannot hold more tokens than its capacity.",
});

const nodes = (e: Env) => lines(`${e.learnDir}/graph/nodes.jsonl`) as NodeLine[];
const chains = (e: Env) => lines(`${e.learnDir}/graph/chains.jsonl`) as ChainLine[];
const locators = (e: Env) => lines(`${e.learnDir}/cortex/locators.jsonl`) as LocatorLine[];

/** The default script: the extractor finds the two propositions of NOTE with one argument, and the auditor links to the first candidate. */
function standard(call: Call): Reply {
  if (call.role === "auditor") return linkFirst(call);
  return extractorReply([bucket(), capacity()], [{ premises: ["p1"], conclusion: "p2" }]);
}

describe("one notes file from chunk to merge", () => {
  // B-5-03, B-5-20
  it("extracts, merges with provenance and locators, checkpoints last and updates the file record", async () => {
    const e = setupEnv({ handler: standard });
    write(e.notes, "rates.md", NOTE);
    const id = await scanned(e, "rates.md");
    const result = await e.svc.fileResult(id);
    expect(result.outcome).toBe("completed");
    expect(result.stats).toMatchObject({ nodes: 2, chains: 1 });
    const ns = nodes(e);
    expect(ns).toHaveLength(2);
    expect(ns[0].id).toMatch(/^n_[0-9a-f]{12}$/);
    expect(ns[0].provenance).toEqual([{ chatId: id, messageId: "" }]);
    expect(chains(e)[0]).toMatchObject({ id: expect.stringMatching(/^arg_[0-9a-f]{12}$/), premises: [ns[0].id], conclusion: ns[1].id });
    expect(chains(e)[0].provenance).toEqual([{ chatId: id, messageId: "" }]);
    // the locators carry the line range and the heading, and the second quote is cut across a line break
    const ls = locators(e);
    expect(ls).toHaveLength(2);
    expect(ls[0]).toMatchObject({ nodeId: ns[0].id, sourceId: id, startLine: 3, endLine: 3, heading: "Rates", found: true, page: null });
    expect(ls[1]).toMatchObject({ nodeId: ns[1].id, startLine: 4, endLine: 4, found: true });
    // the checkpoint is written, and the file record says what happened
    expect(lines(`${e.learnDir}/graph/sessions.jsonl`)).toMatchObject([{ chatId: id }]);
    const rec = e.sources.file(id)!.record;
    expect(rec).toMatchObject({ state: "current", outcome: "completed", chunks: 1, stats: { nodes: 2, chains: 1 } });
    expect(rec.lastExtractedSha256).toBe(rec.sha256);
    expect(rec.lastExtractedAt).not.toBeNull();
    // the usage is stored on the source record, and the signals were sent
    const sourceRecords = JSON.parse(fs.readFileSync(`${e.learnDir}/graph/sources.json`, "utf8"));
    expect(sourceRecords[id].extractions).toHaveLength(1);
    expect(sourceRecords[id].extractions[0].stats).toMatchObject({ nodes: 2, chains: 1 });
    expect(sourceRecords[id].extractions[0].stages.extractor.model).toBe("faux:m1");
    expect(e.events).toContain("graph-changed");
    expect(e.events).toContain("activity-changed");
    expect(e.fires).toHaveLength(1);
    expect(e.fires[0].nodeIds).toEqual(ns.map((n) => n.id));
    expect(e.svc.registered()).toBe(false);
    // the first run found nothing to compare, so the auditor made no call
    expect(e.calls.map((c) => c.role)).toEqual(["extractor"]);
  });

  // B-5-26, B-5-27: the auditor sees candidates and no source text or argument
  it("gives the auditor the first page of candidates and never the source text or the arguments", async () => {
    const e = setupEnv({
      handler: (call) => {
        if (call.role === "auditor") return linkFirst(call);
        return extractorReply([bucket({ id: "q1" })], []);
      },
    });
    write(e.notes, "rates.md", NOTE);
    const id = await scanned(e, "rates.md");
    await e.svc.fileResult(id);
    write(e.notes, "again.md", "# Again\n\nA token bucket refills steadily.\n");
    const id2 = await scanned(e, "again.md");
    await e.svc.fileResult(id2);
    const audit = e.calls.find((c) => c.role === "auditor")!;
    const shown = shownCandidates(audit);
    expect(Object.keys(shown.candidates)).toHaveLength(1);
    expect(shown.findings[0]).toMatchObject({ id: "q1", offset: 0, hasMore: false });
    expect(audit.user).not.toContain("A token bucket refills steadily");
    expect(audit.user).not.toContain("# Again");
    expect(audit.user).not.toContain("=>");
    expect(audit.system).toContain("submit_review");
    // the single proposition was linked, so the graph holds one node with the second source in its provenance
    const ns = nodes(e);
    expect(new Set(ns.map((n) => n.id)).size).toBe(1);
    expect(ns.flatMap((n) => n.provenance.map((p) => p.chatId))).toEqual([id, id2]);
  });

  // B-5-26: the digest of the same source reaches the second chunk
  it("gives the extractor a digest of what the source already produced, with ids verbatim", async () => {
    let seen = "";
    const e = setupEnv({
      graph: { extractionChunkTokens: 500 },
      handler: (call) => {
        if (call.role === "auditor") return linkFirst(call);
        if (call.user.includes("part 1 of")) return extractorReply([bucket()]);
        seen = call.user;
        return extractorReply([]);
      },
    });
    write(e.notes, "long.md", Array.from({ length: 40 }, (_, i) => `Line ${i} ${"word ".repeat(18)}`).join("\n"));
    const id = await scanned(e, "long.md");
    await e.svc.fileResult(id);
    const first = nodes(e)[0];
    expect(seen).toContain("Record of earlier work on this source");
    expect(seen).toContain(`${first.id} | Token bucket refill |`);
  });
});

describe("the findings of the extractor", () => {
  // B-5-04, B-5-18
  it("returns a rule violation to the model and accepts the corrected call within the turns", async () => {
    const e = setupEnv({
      handler: (call) => {
        if (call.role === "auditor") return auditorReply();
        if (call.turn === 0) return extractorReply([bucket()], [{ premises: ["p1"], conclusion: "p9" }]);
        if (call.turn === 1) return { tool: "submit_findings", args: { propositions: JSON.stringify([bucket()]), chains: "[]" } };
        return extractorReply([]);
      },
    });
    write(e.notes, "rates.md", NOTE);
    const id = await scanned(e, "rates.md");
    const r = await e.svc.fileResult(id);
    expect(r.outcome).toBe("completed");
    expect(e.calls.filter((c) => c.role === "extractor")).toHaveLength(2);
    expect(nodes(e)).toHaveLength(1);
  });

  it("fails the chunk when the model uses its four turns without a clean call", async () => {
    const e = setupEnv({ handler: () => extractorReply([bucket()], [{ premises: ["p1"], conclusion: "p1" }]) });
    write(e.notes, "rates.md", NOTE);
    const id = await scanned(e, "rates.md");
    const r = await e.svc.fileResult(id);
    expect(r.outcome).toBe("failed");
    expect(e.calls.filter((c) => c.role === "extractor")).toHaveLength(4);
    expect(nodes(e)).toHaveLength(0);
    expect(e.sources.file(id)!.record).toMatchObject({ outcome: "failed", state: "pending" });
  });
});

describe("a quote that is not found", () => {
  it("keeps the proposition and writes a locator with found false and null lines", async () => {
    const e = setupEnv({ handler: (c) => (c.role === "auditor" ? auditorReply() : extractorReply([bucket({ quote: "A token bucket refills very slowly." }), capacity()])) });
    write(e.notes, "rates.md", NOTE);
    const id = await scanned(e, "rates.md");
    await e.svc.fileResult(id);
    expect(nodes(e)).toHaveLength(2);
    const ls = locators(e);
    expect(ls[0]).toMatchObject({ found: false, startLine: null, endLine: null, heading: null, quote: "A token bucket refills very slowly." });
    expect(ls[1].found).toBe(true);
  });

  it("finds a quote after white space collapses, and keeps case", async () => {
    const e = setupEnv({ handler: (c) => (c.role === "auditor" ? auditorReply() : extractorReply([bucket({ quote: "a  full\n bucket cannot hold" }), bucket({ id: "p2", quote: "A FULL BUCKET cannot hold" })])) });
    write(e.notes, "rates.md", NOTE);
    const id = await scanned(e, "rates.md");
    await e.svc.fileResult(id);
    const ls = locators(e);
    expect(ls[0].found).toBe(false);
    expect(ls[1].found).toBe(false);
    // a quote with the right case but different spacing is found
    const f = setupEnv({ handler: (c) => (c.role === "auditor" ? auditorReply() : extractorReply([bucket({ quote: "A full   bucket\ncannot hold" })])) });
    write(f.notes, "rates.md", NOTE);
    await f.svc.fileResult(await scanned(f, "rates.md"));
    expect(locators(f)[0]).toMatchObject({ found: true, startLine: 4, endLine: 4 });
  });

  it("does not locate a quote of more than 280 characters", async () => {
    const long = "A token bucket refills at a fixed rate up to a fixed capacity. ".repeat(6);
    const e = setupEnv({ handler: (c) => (c.role === "auditor" ? auditorReply() : extractorReply([bucket({ quote: long })])) });
    write(e.notes, "rates.md", long);
    await e.svc.fileResult(await scanned(e, "rates.md"));
    expect(locators(e)[0]).toMatchObject({ found: false, startLine: null });
    expect(locators(e)[0].quote.length).toBe(280);
  });
});

describe("a second run", () => {
  // B-5-21, B-5-31: an identical re-run
  it("adds nothing to the graph when the text is identical, and still runs the whole file", async () => {
    const e = setupEnv({ handler: (c) => (c.role === "auditor" ? linkFirst(c) : standard(c)) });
    write(e.notes, "rates.md", NOTE);
    const id = await scanned(e, "rates.md");
    await e.svc.fileResult(id);
    const before = [nodes(e).length, chains(e).length, locators(e).length];
    // the second extractor repeats the first answer, and the auditor links each proposition to its twin
    const second = await e.svc.fileResult(id, true);
    expect(second.outcome).toBe("completed");
    expect(second.stats).toMatchObject({ nodes: 0, chains: 0 });
    expect([nodes(e).length, chains(e).length, locators(e).length]).toEqual(before);
    expect(e.calls.filter((c) => c.role === "extractor")).toHaveLength(2);
    // both runs keep their usage record
    const sourceRecords = JSON.parse(fs.readFileSync(`${e.learnDir}/graph/sources.json`, "utf8"));
    expect(sourceRecords[id].extractions).toHaveLength(2);
    expect(sourceRecords[id].extractions[1].startedAt).toBeGreaterThan(sourceRecords[id].extractions[0].startedAt);
  });

  it("appends only the new proposition when the text grows, and the old ones keep one node", async () => {
    let round = 0;
    const e = setupEnv({
      handler: (c) => {
        if (c.role === "auditor") return linkFirst(c);
        return round === 0 ? extractorReply([bucket()]) : extractorReply([bucket(), capacity()]);
      },
    });
    write(e.notes, "rates.md", NOTE);
    const id = await scanned(e, "rates.md");
    await e.svc.fileResult(id);
    round = 1;
    write(e.notes, "rates.md", `${NOTE}\nMore text.\n`);
    await scanned(e, "rates.md");
    expect(e.sources.file(id)!.record.state).toBe("pending");
    const r = await e.svc.fileResult(id);
    expect(r.outcome).toBe("completed");
    expect(new Set(nodes(e).map((n) => n.id)).size).toBe(2);
  });
});

describe("exclusion", () => {
  // B-5-34: busy before any metadata changes
  it("answers busy for a source that is in flight and leaves its record alone", async () => {
    const gate = deferred();
    const e = setupEnv({
      handler: async (c) => {
        if (c.role === "auditor") return auditorReply();
        await gate.promise;
        return extractorReply([bucket()]);
      },
    });
    write(e.notes, "rates.md", NOTE);
    const id = await scanned(e, "rates.md");
    const filesBefore = lines(`${e.learnDir}/cortex/files.jsonl`).length;
    const first = e.svc.fileResult(id);
    await Promise.resolve();
    expect(e.svc.registered()).toBe(true);
    const busy = await e.svc.fileResult(id);
    expect(busy).toEqual({ outcome: "busy" });
    expect(lines(`${e.learnDir}/cortex/files.jsonl`).length).toBe(filesBefore);
    expect(e.sources.file(id)!.record.outcome).toBeNull();
    gate.resolve();
    expect((await first).outcome).toBe("completed");
    // the exclusion is released, so a retry runs
    expect((await e.svc.fileResult(id, true)).outcome).toBe("completed");
  });
});

/** A file of three chunks at the floor budget. */
const THREE_CHUNKS = Array.from({ length: 60 }, (_, i) => `Fact ${i} ${"w".repeat(80)}`).join("\n");
const FLOOR = { extractionChunkTokens: 500 };

const partAnswer = (part: number, extra: Record<string, unknown> = {}) =>
  extractorReply([{ id: "p1", name: `Fact ${part}`, statement: `Part ${part} states one distinct fact about the subject number ${part}.`, ...extra }]);
const partOf = (c: Call): number => Number(/part (\d+) of/.exec(c.user)?.[1] ?? 1);

describe("failure and abort", () => {
  // B-5-33: an ordinary failed chunk is isolated
  it("isolates a failed chunk, reports the file as partial and keeps the other merges", async () => {
    const e = setupEnv({
      graph: FLOOR,
      handler: (c) => {
        if (c.role === "auditor") return auditorReply();
        const part = partOf(c);
        return part === 2 ? extractorReply([{ id: "p1" }]) : partAnswer(part);
      },
    });
    write(e.notes, "long.md", THREE_CHUNKS);
    const id = await scanned(e, "long.md");
    const r = await e.svc.fileResult(id);
    expect(r.outcome).toBe("partial");
    expect(r.stats).toMatchObject({ nodes: 2 });
    expect(nodes(e).map((n) => n.name)).toEqual(["Fact 1", "Fact 3"]);
    // the file is not covered, so it has no checkpoint and stays pending
    expect(lines(`${e.learnDir}/graph/sessions.jsonl`)).toHaveLength(0);
    expect(e.sources.file(id)!.record).toMatchObject({ outcome: "partial", state: "pending", chunks: 3 });
  });

  // B-5-35: a chunk with no findings plus a failed chunk is partial
  it("counts a chunk with no findings as a success when the outcome is judged", async () => {
    const e = setupEnv({
      graph: FLOOR,
      handler: (c) => {
        if (c.role === "auditor") return auditorReply();
        const part = partOf(c);
        if (part === 1) return extractorReply([]);
        return part === 2 ? { text: "no tool call" } : partAnswer(part);
      },
    });
    write(e.notes, "long.md", THREE_CHUNKS);
    const r = await e.svc.fileResult(await scanned(e, "long.md"));
    expect(r.outcome).toBe("partial");
  });

  it("completes a file whose chunks all find nothing", async () => {
    const e = setupEnv({ handler: () => extractorReply([]) });
    write(e.notes, "empty.md", NOTE);
    const id = await scanned(e, "empty.md");
    const r = await e.svc.fileResult(id);
    expect(r).toMatchObject({ outcome: "completed", stats: { nodes: 0, chains: 0 } });
    expect(e.sources.file(id)!.record.state).toBe("current");
    expect(nodes(e)).toHaveLength(0);
    expect(lines(`${e.learnDir}/graph/sessions.jsonl`)).toHaveLength(1);
  });

  // B-5-10, B-5-22, B-5-33: an abort keeps earlier merges and stops spend
  it("keeps the merges that committed, starts no later chunk and saves the partial usage", async () => {
    const e = setupEnv({
      graph: FLOOR,
      handler: async (c) => {
        if (c.role === "auditor") return auditorReply();
        const part = partOf(c);
        if (part === 1) return partAnswer(1);
        await untilAborted(c.signal);
        return partAnswer(part);
      },
    });
    write(e.notes, "long.md", THREE_CHUNKS);
    const id = await scanned(e, "long.md");
    const run = e.svc.fileResult(id);
    while (e.calls.filter((c) => c.role === "extractor").length < 2) await new Promise((r) => setTimeout(r, 5));
    expect(e.svc.runs()).toHaveLength(1);
    expect(e.svc.runs()[0]).toMatchObject({ sourceId: id, phase: "extracting" });
    expect(e.svc.abort({ sourceId: id })).toBe(1);
    const r = await run;
    expect(r.outcome).toBe("aborted");
    expect(r.stats).toMatchObject({ nodes: 1 });
    expect(nodes(e).map((n) => n.name)).toEqual(["Fact 1"]);
    expect(lines(`${e.learnDir}/graph/sessions.jsonl`)).toHaveLength(0);
    expect(e.calls.filter((c) => c.role === "extractor")).toHaveLength(2);
    expect(e.svc.runs()).toHaveLength(0);
    expect(e.sources.file(id)!.record).toMatchObject({ outcome: "aborted", state: "pending" });
    const rec = JSON.parse(fs.readFileSync(`${e.learnDir}/graph/sources.json`, "utf8"))[id].extractions;
    expect(rec).toHaveLength(1);
    expect(rec[0].stages.extractor.steps.length).toBeGreaterThanOrEqual(1);
  });

  // B-5-35: a failure after the node append is reported with the committed figures
  it("reports a failure after the append as failed with the committed lines and no rollback", async () => {
    const e = setupEnv({ handler: standard });
    e.knowledge.settle = () => {
      throw new Error("The layout could not be written.");
    };
    write(e.notes, "rates.md", NOTE);
    const id = await scanned(e, "rates.md");
    const r = await e.svc.fileResult(id);
    expect(r.outcome).toBe("failed");
    expect(r.stats).toMatchObject({ nodes: 2, chains: 1 });
    expect(r.notice).toContain("The layout could not be written.");
    expect(nodes(e)).toHaveLength(2);
    expect(chains(e)).toHaveLength(1);
    // the checkpoint is not written for a failed file
    expect(lines(`${e.learnDir}/graph/sessions.jsonl`)).toHaveLength(0);
    expect(e.sources.file(id)!.record).toMatchObject({ outcome: "failed", state: "pending", stats: { nodes: 2 } });
  });

  it("fails a file whose text cannot be read, without a model call", async () => {
    const e = setupEnv({ handler: standard });
    write(e.notes, "rates.md", NOTE);
    const id = await scanned(e, "rates.md");
    fs.rmSync(`${e.notes}/rates.md`);
    const r = await e.svc.fileResult(id);
    expect(r.outcome).toBe("failed");
    expect(e.calls).toHaveLength(0);
  });
});

describe("the sensitivity gate and the checks before a model call", () => {
  it("refuses a client-confidential root for a hosted model before any call, and lets consent through", async () => {
    const e = setupEnv({ handler: standard, cls: "hosted", sensitivity: "client-confidential" });
    write(e.notes, "rates.md", NOTE);
    await e.sources.scan(e.root.id);
    const err = (await e.svc.extractRoot(e.root.id).catch((x: unknown) => x)) as LearnError;
    expect(err).toBeInstanceOf(LearnError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("sensitivity_refused");
    expect(err.extra).toMatchObject({ sensitivity: "client-confidential", providerClass: "hosted", roots: [e.root.id] });
    expect(e.calls).toHaveLength(0);
    // a run that is started directly meets the same gate
    const id = e.sources.files(e.root.id)[0].sourceId;
    const direct = await e.svc.fileResult(id);
    expect(direct.outcome).toBe("failed");
    expect(e.calls).toHaveLength(0);
    // consent for this root lets a hosted model read it
    e.sources.update(e.root.id, { hostedConsent: true });
    await e.svc.extractRoot(e.root.id);
    await e.svc.idle();
    expect(e.calls.length).toBeGreaterThan(0);
  });

  it("allows the same root for the Claude Code CLI and for a local model", async () => {
    for (const cls of ["claude-code", "local"] as const) {
      const e = setupEnv({ handler: standard, cls, sensitivity: "client-confidential" });
      write(e.notes, "rates.md", NOTE);
      await e.sources.scan(e.root.id);
      await expect(e.svc.extractRoot(e.root.id)).resolves.toMatchObject({ started: 1 });
      await e.svc.idle();
    }
  });

  it("hides a client-confidential proposition from a hosted auditor", async () => {
    const e = setupEnv({ handler: (c) => (c.role === "auditor" ? linkFirst(c) : extractorReply([bucket({ id: "q1" })])), cls: "hosted", sensitivity: "internal" });
    // the graph already holds a proposition that rests on a client-confidential source
    fs.mkdirSync(`${e.dir}/secret`, { recursive: true });
    const secret = e.sources.add({ kind: "notes", path: `${e.dir}/secret`, label: "Secret", sensitivity: "client-confidential" } as never);
    write(`${e.dir}/secret`, "s.md", "A token bucket refills at a fixed rate up to a fixed capacity.");
    await e.sources.scan(secret.id);
    const secretId = e.sources.files(secret.id)[0].sourceId;
    e.knowledge.appendNodes([
      { id: "n_000000000001", name: "Token bucket refill", statement: "A token bucket refills at a fixed rate up to a fixed capacity.", aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [{ chatId: secretId, messageId: "" }] },
    ]);
    write(e.notes, "rates.md", NOTE);
    const id = await scanned(e, "rates.md");
    await e.svc.fileResult(id);
    // no candidate was shown and the auditor made no call, so the new proposition is a new node
    expect(e.calls.filter((c) => c.role === "auditor")).toHaveLength(0);
    expect(new Set(nodes(e).map((n) => n.id)).size).toBe(2);
  });

  it("answers the refusal of the model layer from route 45 and does nothing", async () => {
    const refusal = new LearnError(503, "models_not_configured", "No model is chosen for cheap.", { missing: ["cheap"] });
    const e = setupEnv({ handler: standard, preflight: refusal });
    write(e.notes, "rates.md", NOTE);
    await e.sources.scan(e.root.id);
    await expect(e.svc.extractRoot(e.root.id)).rejects.toBe(refusal);
    expect(e.svc.registered()).toBe(false);
  });

  it("refuses when extraction is switched off in the settings", async () => {
    const e = setupEnv({ handler: standard, graph: { enabled: false } });
    write(e.notes, "rates.md", NOTE);
    await e.sources.scan(e.root.id);
    await expect(e.svc.extractRoot(e.root.id)).rejects.toMatchObject({ status: 400 });
  });
});

describe("concurrency", () => {
  // The 3 permit limit
  it("runs at most three extractors at once for all sources, and shares the permits", async () => {
    let active = 0;
    let peak = 0;
    const release = deferred();
    const e = setupEnv({
      fileLimit: 6,
      semaphore: new Semaphore(3),
      handler: async (c) => {
        if (c.role === "auditor") return auditorReply();
        active++;
        peak = Math.max(peak, active);
        await release.promise;
        active--;
        return extractorReply([]);
      },
    });
    for (let i = 0; i < 6; i++) write(e.notes, `n${i}.md`, `# N${i}\n\nSome text ${i}.\n`);
    await e.sources.scan(e.root.id);
    const ids = e.sources.files(e.root.id).map((f) => f.sourceId);
    const runs = ids.map((id) => e.svc.fileResult(id));
    while (e.calls.length < 3) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 40));
    expect(peak).toBe(3);
    expect(e.svc.semaphore.active).toBe(3);
    expect(e.svc.semaphore.waiting).toBe(3);
    expect(e.svc.runs().filter((r) => r.phase === "queued")).toHaveLength(3);
    release.resolve();
    const results = await Promise.all(runs);
    expect(results.every((r) => r.outcome === "completed")).toBe(true);
    expect(peak).toBe(3);
    expect(e.svc.semaphore.active).toBe(0);
  });

  it("holds at most three files in flight and reports the rest as queued", async () => {
    const release = deferred();
    const e = setupEnv({ handler: async (c) => (c.role === "auditor" ? auditorReply() : (await release.promise, extractorReply([]))) });
    for (let i = 0; i < 5; i++) write(e.notes, `n${i}.md`, `# N${i}\n\nSome text ${i}.\n`);
    await e.sources.scan(e.root.id);
    const body = await e.svc.extractRoot(e.root.id);
    expect(body).toEqual({ started: 3, queued: 2 });
    expect(e.svc.runs()).toHaveLength(5);
    release.resolve();
    await e.svc.idle();
    expect(e.sources.files(e.root.id).every((f) => f.outcome === "completed")).toBe(true);
  });

  // The audit lock is first in first out and one at a time
  it("audits one run at a time in the order in which the extractors finish", async () => {
    const gates = new Map<string, Deferred>();
    const order: string[] = [];
    let auditing = 0;
    let peakAudit = 0;
    const which = (c: Call) => /File: Notes\/(\w+)\.md/.exec(c.user)?.[1] ?? "?";
    const e = setupEnv({
      handler: async (c) => {
        if (c.role === "extractor") {
          const name = which(c);
          const d = gates.get(name) ?? deferred();
          gates.set(name, d);
          await d.promise;
          return extractorReply([{ id: "q", name: `Idea ${name}`, statement: `The idea of the note called ${name} is stated in full here.` }]);
        }
        auditing++;
        peakAudit = Math.max(peakAudit, auditing);
        order.push(/Idea (\w+)/.exec(c.user)?.[1] ?? "?");
        await new Promise((r) => setTimeout(r, 20));
        auditing--;
        return auditorReply();
      },
    });
    // the graph needs one node so that the auditor has something to compare with
    e.knowledge.appendNodes([{ id: "n_000000000001", name: "Seed", statement: "A seed proposition for the comparison.", aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [] }]);
    for (const n of ["a", "b", "c"]) write(e.notes, `${n}.md`, `# ${n}\n\nText of ${n}.\n`);
    await e.sources.scan(e.root.id);
    const ids = e.sources.files(e.root.id).map((f) => f.sourceId);
    const runs = ids.map((id) => e.svc.fileResult(id));
    while (gates.size < 3) await new Promise((r) => setTimeout(r, 5));
    for (const n of ["b", "c", "a"]) {
      gates.get(n)!.resolve();
      await new Promise((r) => setTimeout(r, 60));
    }
    await Promise.all(runs);
    expect(order).toEqual(["b", "c", "a"]);
    expect(peakAudit).toBe(1);
  });

  // B-5-28: the next chunk of a source starts only after the audit of the one before
  it("starts the extractor of the second chunk only after the first chunk has merged", async () => {
    const log: string[] = [];
    const e = setupEnv({
      graph: FLOOR,
      handler: (c) => {
        const part = partOf(c);
        log.push(c.role === "extractor" ? `extractor${part}` : "auditor");
        return c.role === "auditor" ? auditorReply() : partAnswer(part);
      },
    });
    e.knowledge.appendNodes([{ id: "n_000000000001", name: "Seed", statement: "Part one states a seed fact for the comparison.", aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [] }]);
    write(e.notes, "long.md", THREE_CHUNKS);
    await e.svc.fileResult(await scanned(e, "long.md"));
    expect(log).toEqual(["extractor1", "auditor", "extractor2", "auditor", "extractor3", "auditor"]);
  });
});

describe("transcripts", () => {
  const msg = (type: "user" | "assistant", uuid: string, text: string) => JSON.stringify({ type, uuid, timestamp: "2026-11-01T10:00:00.000Z", message: { content: text } });
  const transcript = (n: number) => Array.from({ length: n }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `m${i + 1}`, `Message ${i + 1} ${"x".repeat(1500)}`)).join("\n") + "\n";

  it("anchors each proposition to a message of the batch, covers the batches and extracts only the rest on a re-run", async () => {
    let batch = 0;
    const e = setupEnv({
      kind: "claude-transcripts",
      graph: FLOOR,
      handler: async (c) => {
        if (c.role === "auditor") return auditorReply();
        batch++;
        if (batch === 3) await untilAborted(c.signal);
        const first = /\[(m\d+)\]/.exec(c.user)![1];
        return extractorReply([{ id: "p1", name: `Idea ${first}`, statement: `The batch that starts at ${first} makes one claim.`, messageId: first, quote: `Message ${first.slice(1)} ${"x".repeat(20)}` }]);
      },
    });
    write(e.notes, "s.jsonl", transcript(6));
    const id = await scanned(e, "s.jsonl");
    expect(e.sources.file(id)!.record.uncoveredTokens).toBeGreaterThan(0);
    const run = e.svc.fileResult(id);
    while (e.calls.filter((c) => c.role === "extractor").length < 3) await new Promise((r) => setTimeout(r, 5));
    e.svc.abort();
    expect((await run).outcome).toBe("aborted");
    const covered = lines(`${e.learnDir}/graph/coverage.jsonl`) as { chatId: string; fp: string }[];
    expect(covered.length).toBeGreaterThan(0);
    expect(covered.every((l) => l.chatId === id)).toBe(true);
    // the provenance carries the message id, and the earlier batches stay merged
    const ns = nodes(e);
    expect(ns.length).toBe(2);
    expect(ns[0].provenance[0].messageId).toBe("m1");
    // the file stays pending, because the third batch is not covered
    expect(e.sources.file(id)!.record).toMatchObject({ state: "pending", outcome: "aborted" });
    expect(e.sources.file(id)!.record.uncoveredTokens).toBeGreaterThan(0);
    // the re-run extracts only the remainder
    const before = e.calls.filter((c) => c.role === "extractor").length;
    const r2 = await e.svc.fileResult(id);
    expect(r2.outcome).toBe("completed");
    expect(e.calls.filter((c) => c.role === "extractor").length - before).toBeGreaterThanOrEqual(1);
    expect(e.sources.file(id)!.record).toMatchObject({ state: "current", uncoveredTokens: 0, outcome: "completed" });
    // a third run has nothing to read
    const calls = e.calls.length;
    expect((await e.svc.fileResult(id)).outcome).toBe("completed");
    expect(e.calls.length).toBe(calls);
    // the locator of a transcript line is a line of the prose view
    expect(locators(e)[0]).toMatchObject({ found: true, startLine: 1 });
  });

  // B-5-13, B-5-14
  it("returns an unknown or empty message id to the model and refuses an id from another batch", async () => {
    let turn = 0;
    const e = setupEnv({
      kind: "claude-transcripts",
      graph: FLOOR,
      handler: (c) => {
        if (c.role === "auditor") return auditorReply();
        turn++;
        const stmt = { id: "p1", name: "Idea", statement: "One claim stated so that it stands alone." };
        if (turn === 1) return extractorReply([{ ...stmt }]);
        if (turn === 2) return extractorReply([{ ...stmt, messageId: "m6" }]);
        return extractorReply([{ ...stmt, messageId: "m1" }]);
      },
    });
    write(e.notes, "s.jsonl", transcript(6));
    const id = await scanned(e, "s.jsonl");
    const run = e.svc.fileResult(id, true);
    await run;
    expect(nodes(e)[0].provenance[0].messageId).toBe("m1");
    expect(e.calls.filter((c) => c.role === "extractor" && c.turn === 2).length).toBeGreaterThanOrEqual(1);
  });
});

describe("sessions", () => {
  const view = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const text = `Teacher explanation ${i + 1} ${"y".repeat(1500)}`;
      return { messageId: `msg_${i + 1}`, fp: `fp${i + 1}`, tokens: Math.ceil(text.length / 4), lines: [`TEACHER [msg_${i + 1}] ${text}`] };
    });

  it("answers 404 until a session source exists", async () => {
    const e = setupEnv({ handler: standard });
    await expect(e.svc.extractSession("chat_x")).rejects.toMatchObject({ status: 404 });
  });

  it("extracts the uncovered messages by batch, anchors to the teacher message and records the coverage and usage", async () => {
    const used: unknown[] = [];
    const e = setupEnv({
      graph: FLOOR,
      handler: (c) => {
        if (c.role === "auditor") return auditorReply();
        const first = /\[(msg_\d+)\]/.exec(c.user)![1];
        return extractorReply([{ id: "p1", name: `Idea ${first}`, statement: `The teacher explained one idea in ${first}.`, messageId: first }]);
      },
    });
    const messages = view(4);
    e.svc.setSessionSource({ get: (id) => (id === "chat_1" ? { title: "Rates", sensitivity: "internal", view: messages } : null), appendUsage: (_id, u) => void used.push(u) });
    expect(await e.svc.extractSession("chat_1")).toEqual({ started: true });
    await e.svc.idle();
    expect(nodes(e).length).toBe(4);
    expect(nodes(e)[0].provenance).toEqual([{ chatId: "chat_1", messageId: "msg_1" }]);
    const covered = lines(`${e.learnDir}/graph/coverage.jsonl`) as { chatId: string; fp: string }[];
    expect(covered.map((l) => l.fp)).toEqual(["fp1", "fp2", "fp3", "fp4"]);
    expect(locators(e)).toHaveLength(0);
    expect(used).toHaveLength(1);
    // nothing is uncovered now
    expect(await e.svc.extractSession("chat_1")).toEqual({ started: false });
  });

  it("refuses a second run of the same session as busy", async () => {
    const gate = deferred();
    const e = setupEnv({ handler: async (c) => (c.role === "auditor" ? auditorReply() : (await gate.promise, extractorReply([]))) });
    e.svc.setSessionSource({ get: () => ({ title: "Rates", sensitivity: "internal", view: view(1) }) });
    await e.svc.extractSession("chat_1");
    await expect(e.svc.extractSession("chat_1")).rejects.toMatchObject({ status: 409, code: "extraction_busy" });
    gate.resolve();
    await e.svc.idle();
  });

  // B-5-12: a session deleted mid run merges nothing
  it("merges nothing and records no usage when the session is deleted mid run", async () => {
    let alive = true;
    const used: unknown[] = [];
    const e = setupEnv({
      handler: (c) => {
        if (c.role === "auditor") return auditorReply();
        alive = false;
        return extractorReply([{ id: "p1", name: "Idea", statement: "The teacher explained one idea in full.", messageId: "msg_1" }]);
      },
    });
    e.svc.setSessionSource({ get: () => (alive ? { title: "Rates", sensitivity: "internal", view: view(1) } : null), appendUsage: (_i, u) => void used.push(u) });
    await e.svc.extractSession("chat_1");
    await e.svc.idle();
    expect(nodes(e)).toHaveLength(0);
    expect(lines(`${e.learnDir}/graph/coverage.jsonl`)).toHaveLength(0);
    expect(used).toHaveLength(0);
  });

  it("starts by itself only when the uncovered text reaches the chunk budget", async () => {
    const e = setupEnv({ graph: FLOOR, handler: (c) => (c.role === "auditor" ? auditorReply() : extractorReply([])) });
    e.svc.setSessionSource({ get: () => ({ title: "Rates", sensitivity: "internal", view: view(1) }) });
    expect(await e.svc.maybeExtractSession("chat_1")).toBe(false);
    e.svc.setSessionSource({ get: () => ({ title: "Rates", sensitivity: "internal", view: view(3) }) });
    expect(await e.svc.maybeExtractSession("chat_1")).toBe(true);
    await e.svc.idle();
  });
});

describe("a stage that would write what the model cannot know", () => {
  it("builds identifiers, times and provenance in code, whatever the model sends", async () => {
    const e = setupEnv({
      handler: (c) =>
        c.role === "auditor"
          ? auditorReply()
          : { tool: "submit_findings", args: { propositions: [{ ...bucket(), createdAt: "1999", provenance: [{ chatId: "x", messageId: "y" }], nodeId: "n_forged" }], chains: [] } },
    });
    write(e.notes, "rates.md", NOTE);
    const id = await scanned(e, "rates.md");
    await e.svc.fileResult(id);
    const n = nodes(e)[0];
    expect(n.id).not.toBe("n_forged");
    expect(n.createdAt).not.toBe("1999");
    expect(n.provenance).toEqual([{ chatId: id, messageId: "" }]);
  });
});
