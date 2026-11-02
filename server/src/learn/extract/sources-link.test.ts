// The parts of the sources service that the extraction phase uses: the file lookup, the record update, the text read,
// the scan queue that reaches the pipeline, and the agreement on what a covered transcript message is.
import { describe, expect, it } from "vitest";
import { cleanupEnvs, deferred, extractorReply, auditorReply, scanned, setupEnv, write } from "./test-support.ts";
import { createSources } from "../sources/index.ts";

cleanupEnvs();

describe("the sources service for the extraction phase", () => {
  it("finds a file with its root, appends a newer record line and reads the text", async () => {
    const e = setupEnv({ handler: () => extractorReply([]) });
    write(e.notes, "a.md", "# A\n\nText of the note.\n");
    const id = await scanned(e, "a.md");
    const found = e.sources.file(id)!;
    expect(found.root.id).toBe(e.root.id);
    expect(e.sources.file("src_000000000000")).toBeNull();
    const read = await e.sources.readText(id);
    expect(read?.text).toMatchObject({ ok: true, text: "# A\n\nText of the note.\n" });
    const next = e.sources.updateFile(id, { outcome: "failed", sourceId: "src_other", path: "other.md" });
    expect(next).toMatchObject({ sourceId: id, path: "a.md", outcome: "failed" });
    expect(e.sources.file(id)!.record.outcome).toBe("failed");
    expect(e.sources.updateFile("src_000000000000", { outcome: "failed" })).toBeNull();
    expect(await e.sources.readText("src_000000000000")).toBeNull();
  });

  it("clears the notice of a failed run when a later run of the same file completes", async () => {
    const e = setupEnv({ handler: (c) => (c.role === "auditor" ? auditorReply() : extractorReply([])) });
    write(e.notes, "a.md", "# A\n\nText of the note.\n");
    const id = await scanned(e, "a.md");
    e.sources.updateFile(id, { outcome: "failed", notice: "The model call failed." });
    expect(e.sources.file(id)!.record.notice).toBe("The model call failed.");
    await e.svc.fileResult(id);
    expect(e.sources.file(id)!.record.outcome).toBe("completed");
    expect(e.sources.file(id)!.record.notice).toBeUndefined();
  });

  it("keeps the uncovered tokens of a transcript in step with the coverage that the merge writes", async () => {
    const msg = (type: string, uuid: string, text: string) => JSON.stringify({ type, uuid, message: { content: text } });
    const e = setupEnv({
      kind: "claude-transcripts",
      handler: (c) => (c.role === "auditor" ? auditorReply() : extractorReply([{ id: "p1", name: "Idea", statement: "One claim that stands alone in full.", messageId: /\[(\w+)\]/.exec(c.user)![1] }])),
    });
    write(e.notes, "s.jsonl", [msg("user", "u1", "A question about buckets."), msg("assistant", "a1", "A bucket refills at a fixed rate.")].join("\n") + "\n");
    const id = await scanned(e, "s.jsonl");
    expect(e.sources.file(id)!.record.uncoveredTokens).toBeGreaterThan(0);
    await e.svc.fileResult(id);
    // the scan reads the same fingerprints as the merge wrote, so nothing is left to do
    await e.sources.scan(e.root.id);
    expect(e.sources.file(id)!.record).toMatchObject({ uncoveredTokens: 0, state: "current" });
  });
});

describe("deletion while a run is registered", () => {
  it("blocks the deletion of knowledge and the unlinking of a root until the run ends", async () => {
    const gate = deferred();
    const e = setupEnv({ handler: async (c) => (c.role === "auditor" ? auditorReply() : (await gate.promise, extractorReply([]))) });
    write(e.notes, "a.md", "# A\n\nText.\n");
    const id = await scanned(e, "a.md");
    const run = e.svc.fileResult(id);
    expect(() => e.knowledge.deleteSources([id], "preserve-graph")).toThrow(/extraction is running/i);
    await expect(e.sources.remove(e.root.id, "preserve-graph")).rejects.toMatchObject({ code: "extraction_running" });
    gate.resolve();
    await run;
    expect(() => e.knowledge.deleteSources([id], "preserve-graph")).not.toThrow();
  });
});

describe("the scan queue", () => {
  it("hands the files of a scan pass in scan mode to the pipeline", async () => {
    const gate = deferred();
    const e = setupEnv({ handler: async (c) => (c.role === "auditor" ? auditorReply() : (await gate.promise, extractorReply([]))) });
    // a second sources service whose queue feeds the pipeline of the first environment
    const sources = createSources({
      learnDir: e.learnDir,
      dataDir: `${e.dir}/data`,
      claudeHome: e.claudeHome,
      projectsRoot: null,
      canExtract: () => true,
      onQueue: (root, paths) => e.svc.queueScan(root, paths),
    });
    write(e.notes, "a.md", "# A\n\nText.\n");
    sources.update(e.root.id, { mode: "scan" });
    await sources.scanPass();
    expect(e.svc.runs().map((r) => r.title)).toEqual(["Notes/a.md"]);
    gate.resolve();
    await e.svc.idle();
    expect(sources.files(e.root.id)[0]).toMatchObject({ outcome: "completed", state: "current" });
    // the next pass finds nothing pending
    await sources.scanPass();
    expect(e.svc.runs()).toHaveLength(0);
  });
});
