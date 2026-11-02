import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FileRecord, SourceRoot } from "../../../../shared/learn/sources.ts";
import { SourceError } from "./errors.ts";
import { createSources, type SourcesOptions, type SourcesService } from "./index.ts";
import { transcriptFingerprint, parseTranscriptLine } from "./readers/claude-transcripts.ts";
import { makePdf, proseLines, tmpDir, trySymlink, write } from "./testkit.ts";

interface Env {
  home: string;
  dataDir: string;
  learnDir: string;
  claudeHome: string;
  projects: string;
  svc: SourcesService;
  notes: string;
  filesFile: string;
}

function setup(over: Partial<SourcesOptions> = {}): Env {
  const home = tmpDir();
  const dataDir = `${home}/data`;
  const learnDir = `${dataDir}/learn`;
  const claudeHome = `${home}/claude`;
  const projects = `${home}/Projects`;
  const notes = `${home}/notes`;
  for (const d of [claudeHome, projects, notes]) fs.mkdirSync(d, { recursive: true });
  const svc = createSources({ learnDir, dataDir, claudeHome, projectsRoot: projects, ...over });
  return { home, dataDir, learnDir, claudeHome, projects, svc, notes, filesFile: `${learnDir}/cortex/files.jsonl` };
}

const lineCount = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0);
const addNotes = (e: Env, extra: Record<string, unknown> = {}): SourceRoot => e.svc.add({ kind: "notes", path: e.notes, label: "Notes", ...extra } as never);
const record = (e: Env, rootId: string, rel: string): FileRecord => e.svc.files(rootId).find((f) => f.path === rel)!;
const codeOf = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    return err instanceof SourceError ? `${err.status} ${err.code}` : String(err);
  }
  return "ok";
};

describe("scan of a notes root", () => {
  it("records new files, ignores system files and excluded folders, and writes the source records", async () => {
    const e = setup();
    write(e.notes, "a.md", "# A\nbody");
    write(e.notes, "sub/b.txt", "plain text");
    write(e.notes, ".DS_Store", "junk");
    write(e.notes, "sub/._b.txt", "junk");
    write(e.notes, ".obsidian/app.md", "editor file");
    write(e.notes, "node_modules/x/readme.md", "dependency");
    write(e.notes, "image.png", "not a note");
    const root = addNotes(e);
    const r = await e.svc.scan(root.id);
    expect(r.files.map((f) => f.path)).toEqual(["a.md", "sub/b.txt"]);
    expect(r.counts).toEqual({ new: 2, changed: 0, unchanged: 0, moved: 0, missing: 0, refused: 0 });
    const rec = record(e, root.id, "a.md");
    expect(rec).toMatchObject({ state: "pending", lastExtractedAt: null, outcome: null, rootId: root.id });
    expect(rec.sourceId).toMatch(/^src_[0-9a-f]{12}$/);
    const sources = JSON.parse(fs.readFileSync(`${e.learnDir}/graph/sources.json`, "utf8"));
    expect(sources[rec.sourceId].filePath).toBe("Notes/a.md");
    expect(JSON.parse(fs.readFileSync(`${e.learnDir}/graph/format.json`, "utf8"))).toEqual({ version: 1 });
    expect(e.svc.get(root.id)?.lastScanAt).toBe(r.startedAt);
    expect(e.svc.list()[0].counts).toMatchObject({ files: 2, pending: 2 });
  });

  it("queues nothing and writes nothing on an unchanged rescan", async () => {
    const queued: string[][] = [];
    const e = setup({ settings: () => ({ maxFilesPerPass: 50 }), canExtract: () => true, onQueue: (_r, p) => void queued.push(p) });
    write(e.notes, "a.md", "one");
    write(e.notes, "b.md", "two");
    const root = addNotes(e, { mode: "scan" });
    await e.svc.scan(root.id);
    const before = fs.readFileSync(e.filesFile, "utf8");
    const again = await e.svc.scan(root.id);
    expect(again.counts).toMatchObject({ new: 0, changed: 0, unchanged: 2, moved: 0, missing: 0 });
    expect(fs.readFileSync(e.filesFile, "utf8")).toBe(before);
    // the files wait for extraction until a person or the extraction phase marks them current
    const done = e.svc.files(root.id).map((f) => ({ ...f, state: "current" as const, lastExtractedSha256: f.sha256, lastExtractedAt: "t", outcome: "completed" as const }));
    fs.appendFileSync(e.filesFile, done.map((d) => JSON.stringify(d) + "\n").join(""));
    await e.svc.scanPass();
    expect(queued).toEqual([]);
  });

  it("does not read a file again when only its modification time changed, and does not write", async () => {
    const e = setup();
    const f = write(e.notes, "a.md", "same");
    const root = addNotes(e);
    await e.svc.scan(root.id);
    const before = fs.readFileSync(e.filesFile, "utf8");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(f, later, later);
    const r = await e.svc.scan(root.id);
    expect(r.counts.unchanged).toBe(1);
    expect(fs.readFileSync(e.filesFile, "utf8")).toBe(before);
  });

  it("marks a changed file pending again and keeps its source id", async () => {
    const e = setup();
    write(e.notes, "a.md", "version one");
    const root = addNotes(e);
    await e.svc.scan(root.id);
    const first = record(e, root.id, "a.md");
    fs.appendFileSync(e.filesFile, JSON.stringify({ ...first, state: "current", lastExtractedSha256: first.sha256, lastExtractedAt: "t", outcome: "completed" }) + "\n");
    expect(record(e, root.id, "a.md").state).toBe("current");
    write(e.notes, "a.md", "version two");
    const r = await e.svc.scan(root.id);
    expect(r.files[0]).toMatchObject({ change: "changed", state: "pending", sourceId: first.sourceId });
    const next = record(e, root.id, "a.md");
    expect(next.sha256).not.toBe(first.sha256);
    expect(next.lastExtractedSha256).toBe(first.sha256);
  });

  it("keeps the source of a moved file and records the previous path", async () => {
    const e = setup();
    write(e.notes, "old/a.md", "content that moves");
    write(e.notes, "other.md", "stays");
    const root = addNotes(e);
    await e.svc.scan(root.id);
    const before = record(e, root.id, "old/a.md");
    fs.mkdirSync(`${e.notes}/new`);
    fs.renameSync(`${e.notes}/old/a.md`, `${e.notes}/new/renamed.md`);
    const r = await e.svc.scan(root.id);
    expect(r.counts).toMatchObject({ moved: 1, new: 0, missing: 0, unchanged: 1 });
    const after = record(e, root.id, "new/renamed.md");
    expect(after).toMatchObject({ sourceId: before.sourceId, previousPath: "old/a.md", state: "pending" });
    expect(after.firstSeenAt).toBe(before.firstSeenAt);
    expect(e.svc.files(root.id).filter((f) => f.sourceId === before.sourceId)).toHaveLength(1);
    const sources = JSON.parse(fs.readFileSync(`${e.learnDir}/graph/sources.json`, "utf8"));
    expect(sources[before.sourceId].filePath).toBe("Notes/new/renamed.md");
  });

  it("gives a new file at an old path a fresh source id after the old file moved away", async () => {
    const e = setup();
    write(e.notes, "a.md", "first file");
    const root = addNotes(e);
    await e.svc.scan(root.id);
    const original = record(e, root.id, "a.md").sourceId;
    fs.renameSync(`${e.notes}/a.md`, `${e.notes}/b.md`);
    await e.svc.scan(root.id);
    write(e.notes, "a.md", "a different file");
    await e.svc.scan(root.id);
    expect(record(e, root.id, "b.md").sourceId).toBe(original);
    expect(record(e, root.id, "a.md").sourceId).not.toBe(original);
  });

  it("marks a deleted file missing, keeps its record, and picks it up again when it returns", async () => {
    const e = setup();
    const f = write(e.notes, "a.md", "here");
    const root = addNotes(e);
    await e.svc.scan(root.id);
    const id = record(e, root.id, "a.md").sourceId;
    fs.unlinkSync(f);
    const r = await e.svc.scan(root.id);
    expect(r.counts.missing).toBe(1);
    expect(record(e, root.id, "a.md")).toMatchObject({ state: "missing", sourceId: id });
    expect((await e.svc.scan(root.id)).counts).toMatchObject({ missing: 0, unchanged: 0 });
    write(e.notes, "a.md", "here");
    const back = await e.svc.scan(root.id);
    expect(back.files[0]).toMatchObject({ sourceId: id, change: "changed" });
    expect(record(e, root.id, "a.md").state).toBe("pending");
  });

  it("refuses a file of 25 MiB plus one byte and accepts one of exactly 25 MiB", async () => {
    const e = setup();
    const limit = 25 * 1024 * 1024;
    write(e.notes, "exact.md", Buffer.alloc(limit, "a"));
    write(e.notes, "over.md", Buffer.alloc(limit + 1, "a"));
    const root = addNotes(e);
    const r = await e.svc.scan(root.id);
    expect(r.files.find((f) => f.path === "exact.md")).toMatchObject({ state: "pending" });
    expect(r.files.find((f) => f.path === "over.md")).toMatchObject({ state: "refused", reason: "too_large" });
    expect(r.counts.refused).toBe(1);
  });

  it("stops a scan with too_large when a root holds more files than the limit", async () => {
    const e = setup({ limits: { maxFiles: 3 } });
    for (const n of ["a", "b", "c"]) write(e.notes, `${n}.md`, n);
    const root = addNotes(e);
    expect((await e.svc.scan(root.id)).counts.new).toBe(3);
    write(e.notes, "d.md", "d");
    expect(await codeOf(e.svc.scan(root.id))).toBe("413 too_large");
    expect(e.svc.files(root.id)).toHaveLength(3);
  });

  it("refuses binary and empty files with a reason", async () => {
    const e = setup();
    write(e.notes, "bin.md", Buffer.from([65, 0, 66]));
    write(e.notes, "empty.md", "  \n");
    const r = await e.svc.scan(addNotes(e).id);
    expect(r.files.map((f) => [f.path, f.reason])).toEqual([
      ["bin.md", "unreadable"],
      ["empty.md", "no_text"],
    ]);
  });

  it("refuses a file on the deny list even when the include globs select it", async () => {
    const e = setup();
    write(e.notes, "ok.md", "fine");
    write(e.notes, ".env", "KEY=1");
    write(e.notes, "server.pem", "pem");
    write(e.notes, "id_rsa", "key");
    write(e.notes, "auth.json", "{}");
    const root = addNotes(e, { include: ["**/*"] });
    const r = await e.svc.scan(root.id);
    const by = Object.fromEntries(r.files.map((f) => [f.path, f.reason ?? f.state]));
    expect(by).toEqual({ ".env": "forbidden_path", "auth.json": "forbidden_path", id_rsa: "forbidden_path", "ok.md": "pending", "server.pem": "forbidden_path" });
  });

  it("does not follow a symlink and refuses a linked file", async () => {
    const e = setup();
    const outside = tmpDir();
    write(outside, "secret.md", "outside the root");
    write(e.notes, "real.md", "inside");
    trySymlink(outside, `${e.notes}/linked`, "dir");
    const fileLink = trySymlink(`${outside}/secret.md`, `${e.notes}/link.md`, "file");
    const r = await e.svc.scan(addNotes(e).id);
    expect(r.files.map((f) => f.path)).not.toContain("linked/secret.md");
    expect(r.files.find((f) => f.path === "real.md")?.state).toBe("pending");
    if (fileLink) expect(r.files.find((f) => f.path === "link.md")).toMatchObject({ state: "refused", reason: "symlink" });
  });

  it("rewrites files.jsonl once a source passes five lines", async () => {
    const e = setup();
    write(e.notes, "a.md", "v0");
    const root = addNotes(e);
    await e.svc.scan(root.id);
    for (let i = 1; i <= 7; i++) {
      write(e.notes, "a.md", `v${i}`);
      await e.svc.scan(root.id);
      expect(lineCount(e.filesFile)).toBeLessThanOrEqual(5);
    }
    expect(record(e, root.id, "a.md").sha256).toBeTruthy();
    expect(e.svc.files(root.id)).toHaveLength(1);
  });

  it("refuses a scan of a switched off root and of a root whose folder is gone", async () => {
    const e = setup();
    write(e.notes, "a.md", "x");
    const root = addNotes(e);
    e.svc.update(root.id, { enabled: false });
    expect(await codeOf(e.svc.scan(root.id))).toBe("400 bad_request");
    e.svc.update(root.id, { enabled: true });
    fs.rmSync(e.notes, { recursive: true });
    expect(await codeOf(e.svc.scan(root.id))).toBe("400 bad_request");
    expect(await codeOf(e.svc.scan("root_00000000"))).toBe("404 not_found");
  });
});

describe("scan pass", () => {
  it("queues at most the files per pass, and only when the gate allows the model", async () => {
    const queued: string[][] = [];
    let allow = false;
    const e = setup({ settings: () => ({ maxFilesPerPass: 2 }), canExtract: () => allow, onQueue: (_r, p) => void queued.push(p) });
    for (const n of "abcde") write(e.notes, `${n}.md`, n);
    addNotes(e, { mode: "scan" });
    await e.svc.scanPass();
    expect(queued).toEqual([]);
    allow = true;
    await e.svc.scanPass();
    expect(queued).toEqual([["a.md", "b.md"]]);
  });

  it("skips roots in manual mode and roots that are switched off", async () => {
    const queued: string[][] = [];
    const e = setup({ canExtract: () => true, onQueue: (_r, p) => void queued.push(p) });
    write(e.notes, "a.md", "a");
    const root = addNotes(e);
    await e.svc.scanPass();
    expect(e.svc.files(root.id)).toHaveLength(0);
    e.svc.update(root.id, { mode: "scan", enabled: false });
    await e.svc.scanPass();
    expect(e.svc.files(root.id)).toHaveLength(0);
    e.svc.update(root.id, { enabled: true });
    await e.svc.scanPass();
    expect(queued).toEqual([["a.md"]]);
  });
});

describe("scan of a transcript root", () => {
  const msgs = [
    { type: "user", uuid: "u-1", message: { content: "Question about screening" } },
    { type: "assistant", uuid: "a-1", message: { content: [{ type: "text", text: "Answer about screening" }, { type: "tool_use", name: "Bash", input: { command: "SECRET_COMMAND" } }] } },
    { type: "user", uuid: "u-2", message: { content: [{ type: "tool_result", content: "SECRET_TOOL_OUTPUT" }] } },
  ];
  it("extracts by message coverage, and the passage shows prose only", async () => {
    const e = setup();
    const dir = `${e.claudeHome}/projects/p1`;
    const file = write(dir, "s1.jsonl", msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
    write(dir, "sub/nested.jsonl", "{}\n");
    const root = e.svc.add({ kind: "claude-transcripts", path: dir } as never);
    expect(root).toMatchObject({ sensitivity: "client-confidential", label: "p1" });
    const r = await e.svc.scan(root.id);
    expect(r.files.map((f) => f.path)).toEqual(["s1.jsonl"]);
    const rec = record(e, root.id, "s1.jsonl");
    expect(rec.state).toBe("pending");
    expect(rec.uncoveredTokens).toBeGreaterThan(0);

    const covered = ["u-1", "a-1"].map((id) => ({ chatId: rec.sourceId, fp: transcriptFingerprint(parseTranscriptLine(JSON.stringify(msgs.find((m) => m.uuid === id)))!), tokens: 5, foldedAt: "t" }));
    write(e.learnDir, "graph/coverage.jsonl", covered.map((c) => JSON.stringify(c)).join("\n") + "\n");
    // an append that adds a message changes the view, so the file is read again
    fs.appendFileSync(file, JSON.stringify({ type: "user", uuid: "u-3", message: { content: "A later question" } }) + "\n");
    const again = await e.svc.scan(root.id);
    expect(again.files[0]).toMatchObject({ change: "changed", state: "pending" });
    const next = record(e, root.id, "s1.jsonl");
    expect(next.uncoveredTokens).toBe(Math.ceil("A later question".length / 4));

    const p = await e.svc.passage(rec.sourceId, 1, 50);
    const text = p.lines.join("\n");
    expect(text).toContain("USER [u-1] Question about screening");
    expect(text).toContain("ASSISTANT [a-1] Answer about screening");
    for (const s of ["SECRET_COMMAND", "SECRET_TOOL_OUTPUT"]) expect(text).not.toContain(s);
    expect(p.fileChanged).toBe(false);
  });

  it("treats a fully covered transcript as current", async () => {
    const e = setup();
    const dir = `${e.claudeHome}/projects/p2`;
    write(dir, "s.jsonl", JSON.stringify(msgs[0]) + "\n");
    const root = e.svc.add({ kind: "claude-transcripts", path: dir } as never);
    await e.svc.scan(root.id);
    const rec = record(e, root.id, "s.jsonl");
    write(e.learnDir, "graph/coverage.jsonl", JSON.stringify({ chatId: rec.sourceId, fp: transcriptFingerprint(parseTranscriptLine(JSON.stringify(msgs[0]))!), tokens: 6, foldedAt: "t" }) + "\n");
    write(dir, "s.jsonl", JSON.stringify(msgs[0]) + "\n\n");
    fs.utimesSync(`${dir}/s.jsonl`, new Date(), new Date(Date.now() + 5000));
    await e.svc.scan(root.id);
    expect(record(e, root.id, "s.jsonl")).toMatchObject({ uncoveredTokens: 0, state: "current" });
  });
});

describe("scan of a pdf root", () => {
  it("refuses a file that is not a PDF, a PDF over the page cap and a PDF with no pages", async () => {
    const e = setup({ limits: { maxPdfPages: 3 } });
    const dir = `${e.home}/pdfs`;
    write(dir, "good.pdf", makePdf([proseLines(["A line of body text that is long enough to read."])]));
    write(dir, "long.pdf", makePdf([{}, {}, {}, {}]));
    write(dir, "fake.pdf", "this is not a pdf");
    write(dir, "scan.pdf", makePdf([{ image: true }]));
    const root = e.svc.add({ kind: "pdf", path: dir } as never);
    const r = await e.svc.scan(root.id);
    const by = Object.fromEntries(r.files.map((f) => [f.path, f.reason ?? f.state]));
    expect(by).toEqual({ "fake.pdf": "unsupported", "good.pdf": "pending", "long.pdf": "too_long", "scan.pdf": "pending" });
    expect(record(e, root.id, "good.pdf").pages).toBe(1);
  });

  it("links one PDF file as a root", async () => {
    const e = setup();
    const file = write(e.home, "paper.pdf", makePdf([proseLines(["A line of body text that is long enough to read."])]));
    const root = e.svc.add({ kind: "pdf", path: file } as never);
    const r = await e.svc.scan(root.id);
    expect(r.files).toMatchObject([{ path: "paper.pdf", state: "pending" }]);
    const p = await e.svc.passage(r.files[0].sourceId!, 1, 5);
    expect(p.lines.join("\n")).toContain("--- Page 1 ---");
  });
});

describe("scan of a learnharness root", () => {
  it("imports through the injected writer once and appends nothing on a repeat scan", async () => {
    const seen = { nodes: new Set<string>(), chains: new Set<string>() };
    const calls: [string, unknown[]][] = [];
    const e = setup({ appendLedger: (k, l) => void calls.push([k, l]), seen: () => seen });
    const lh = `${e.home}/lh`;
    write(lh, "chats/chat_1.json", JSON.stringify({ id: "chat_1", title: "S", createdAt: "t", messages: [] }));
    write(lh, "graph/nodes.jsonl", JSON.stringify({ id: "n_a", name: "A", statement: "A.", aliases: [], createdAt: "t", provenance: [{ chatId: "chat_1", messageId: "m" }] }) + "\n");
    const root = e.svc.add({ kind: "learnharness", path: lh } as never);
    expect(root.sensitivity).toBe("internal");
    await e.svc.scan(root.id);
    const nodeCalls = () => calls.filter((c) => c[0] === "nodes").flatMap((c) => c[1]);
    expect(nodeCalls()).toHaveLength(1);
    expect(e.svc.files(root.id).every((f) => f.state === "current" && f.outcome === "completed")).toBe(true);
    const sourceRecords = calls.filter((c) => c[0] === "sources").flatMap((c) => c[1]) as { filePath: string }[];
    expect([...new Set(sourceRecords.map((s) => s.filePath))]).toEqual(["lh/chats/chat_1.json"]);
    // the graph files themselves are not sources, and a scan with no change imports nothing
    const rescan = await e.svc.scan(root.id);
    expect(rescan.counts.unchanged).toBe(2);
    expect(nodeCalls()).toHaveLength(1);
  });

  it("refuses the learning folder of this app as a root", () => {
    const e = setup();
    fs.mkdirSync(`${e.learnDir}/graph`, { recursive: true });
    expect(() => e.svc.add({ kind: "learnharness", path: e.learnDir } as never)).toThrow(/cannot be imported into itself/);
  });
});

describe("roots", () => {
  it("applies the defaults of the kind and refuses a duplicate", () => {
    const e = setup();
    const a = addNotes(e);
    expect(a).toMatchObject({ kind: "notes", sensitivity: "internal", mode: "manual", enabled: true, hostedConsentAt: null, lastScanAt: null, include: [], exclude: [] });
    expect(a.id).toMatch(/^root_[0-9a-f]{8}$/);
    expect(() => addNotes(e)).toThrow(/already linked/);
    expect(e.svc.add({ kind: "projects-md", path: e.projects } as never).sensitivity).toBe("client-confidential");
  });

  it("refuses a root on the deny list with forbidden_path and bad input with bad_request", async () => {
    const e = setup();
    const ssh = `${e.home}/.ssh`;
    fs.mkdirSync(ssh);
    expect(await codeOf(() => e.svc.add({ kind: "notes", path: ssh } as never))).toBe("403 forbidden_path");
    expect(await codeOf(() => e.svc.add({ kind: "bogus", path: e.notes } as never))).toBe("400 bad_request");
    expect(await codeOf(() => e.svc.add({ kind: "notes", path: e.notes, sensitivity: "secret" } as never))).toBe("400 bad_request");
    expect(await codeOf(() => e.svc.add({ kind: "notes", path: e.notes, include: "x" } as never))).toBe("400 bad_request");
    expect(await codeOf(() => e.svc.add({ kind: "notes", path: e.notes, label: "  " } as never))).toBe("400 bad_request");
  });

  it("records hosted consent with a time and revokes it, and accepts a lowered sensitivity", () => {
    let t = 0;
    const e = setup({ now: () => new Date(Date.UTC(2026, 10, 1, 9, 0, t++)) });
    const root = e.svc.add({ kind: "projects-md", path: e.projects } as never);
    const on = e.svc.update(root.id, { hostedConsent: true });
    expect(on.hostedConsentAt).toMatch(/^2026-11-01T09:00:0\d\.000Z$/);
    expect(e.svc.update(root.id, { hostedConsent: false }).hostedConsentAt).toBeNull();
    expect(e.svc.update(root.id, { sensitivity: "internal" }).sensitivity).toBe("internal");
    expect(() => e.svc.update(root.id, { hostedConsent: "yes" } as never)).toThrow(/true or false/);
  });
});

describe("unlinking a root", () => {
  it("calls the injected deletion, archives the records and never touches the files", async () => {
    const calls: unknown[] = [];
    const e = setup({ deleteKnowledge: (id, mode, ctx) => void calls.push([id, mode, ctx.sourceIds]) });
    const f = write(e.notes, "a.md", "keep me");
    const root = addNotes(e);
    await e.svc.scan(root.id);
    const id = record(e, root.id, "a.md").sourceId;
    const r = await e.svc.remove(root.id, "delete-nodes");
    expect(r).toMatchObject({ mode: "delete-nodes", files: 1 });
    expect(calls).toEqual([[root.id, "delete-nodes", [id]]]);
    expect(fs.readFileSync(f, "utf8")).toBe("keep me");
    expect(e.svc.get(root.id)).toBeNull();
    expect(fs.readFileSync(e.filesFile, "utf8")).toBe("");
    const archive = fs.readdirSync(`${e.learnDir}/archive`);
    expect(fs.existsSync(`${e.learnDir}/archive/${archive[0]}/files.jsonl`)).toBe(true);
    expect(fs.existsSync(`${e.learnDir}/archive/${archive[0]}/source-roots.jsonl`)).toBe(true);
  });

  it("is blocked while an extraction runs, and when no deletion is wired", async () => {
    let running = true;
    const e = setup({ extractionRunning: () => running, deleteKnowledge: () => undefined });
    const root = addNotes(e);
    expect(await codeOf(e.svc.remove(root.id, "preserve-graph"))).toBe("409 extraction_running");
    running = false;
    expect(e.svc.get(root.id)).not.toBeNull();
    const bare = setup();
    const r2 = addNotes(bare);
    expect(await codeOf(bare.svc.remove(r2.id, "preserve-graph"))).toBe("500 not_available");
    expect(bare.svc.get(r2.id)).not.toBeNull();
  });
});

describe("passage", () => {
  const body = Array.from({ length: 300 }, (_, i) => (i === 0 ? "# Title" : i === 150 ? "## Middle" : `line ${i + 1}`)).join("\n") + "\n";

  it("returns at most 200 lines with the nearest heading", async () => {
    const e = setup();
    write(e.notes, "long.md", body);
    const root = addNotes(e);
    const { files } = await e.svc.scan(root.id);
    const id = files[0].sourceId!;
    const p = await e.svc.passage(id, 1, 1000);
    expect(p.lines).toHaveLength(200);
    expect([p.from, p.to]).toEqual([1, 200]);
    expect(p.heading).toBe("Title");
    const q = await e.svc.passage(id, 160, 165);
    expect(q.lines[0]).toBe("line 160");
    expect(q.heading).toBe("Middle");
    const tail = await e.svc.passage(id, 299, 400);
    expect(tail.lines).toEqual(["line 299", "line 300"]);
    expect(tail.to).toBe(300);
  });

  it("reports a file that changed since it was read, and refuses bad ranges and unknown sources", async () => {
    const e = setup();
    write(e.notes, "a.md", "one\ntwo\n");
    const root = addNotes(e);
    const id = (await e.svc.scan(root.id)).files[0].sourceId!;
    expect((await e.svc.passage(id, 1, 2)).fileChanged).toBe(false);
    write(e.notes, "a.md", "one\nTWO\n");
    expect((await e.svc.passage(id, 1, 2)).fileChanged).toBe(true);
    expect(await codeOf(e.svc.passage(id, 0, 2))).toBe("400 bad_request");
    expect(await codeOf(e.svc.passage(id, 5, 2))).toBe("400 bad_request");
    expect(await codeOf(e.svc.passage(id, 9, 12))).toBe("404 not_found");
    expect(await codeOf(e.svc.passage("src_000000000000", 1, 2))).toBe("404 not_found");
    expect(await codeOf(e.svc.passage("../etc/passwd", 1, 2))).toBe("400 bad_request");
  });

  it("refuses a record whose path leaves the root or passes through a link", async () => {
    const e = setup();
    const outside = tmpDir();
    write(outside, "secret.md", "secret");
    write(e.notes, "a.md", "x");
    const root = addNotes(e);
    const rec = (await e.svc.scan(root.id)).files[0];
    const base = record(e, root.id, "a.md");
    const forge = (rel: string, sourceId: string) => fs.appendFileSync(e.filesFile, JSON.stringify({ ...base, sourceId, path: rel }) + "\n");
    const rel = path.relative(e.notes, `${outside}/secret.md`).replace(/\\/g, "/");
    forge("../outside.md", "src_aaaaaaaaaaaa");
    forge(rel, "src_bbbbbbbbbbbb");
    forge("/etc/passwd", "src_cccccccccccc");
    for (const id of ["src_aaaaaaaaaaaa", "src_bbbbbbbbbbbb", "src_cccccccccccc"]) expect(await codeOf(e.svc.passage(id, 1, 5))).toBe("400 bad_request");
    if (trySymlink(outside, `${e.notes}/out`, "dir")) {
      forge("out/secret.md", "src_dddddddddddd");
      expect(await codeOf(e.svc.passage("src_dddddddddddd", 1, 5))).toBe("400 bad_request");
    }
    expect((await e.svc.passage(rec.sourceId!, 1, 1)).lines).toEqual(["x"]);
  });

  it("refuses a record that names a denied file", async () => {
    const e = setup();
    write(e.notes, ".env", "KEY=1");
    write(e.notes, "a.md", "x");
    const root = addNotes(e);
    await e.svc.scan(root.id);
    const base = record(e, root.id, "a.md");
    fs.appendFileSync(e.filesFile, JSON.stringify({ ...base, sourceId: "src_eeeeeeeeeeee", path: ".env" }) + "\n");
    expect(await codeOf(e.svc.passage("src_eeeeeeeeeeee", 1, 5))).toBe("403 forbidden_path");
  });
});
