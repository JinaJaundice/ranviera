import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FORMAT_VERSION, readFormatVersion } from "./format.ts";
import { KnowledgeStore } from "./store.ts";
import { isNodeLine } from "./ledger.ts";
import { lines, node, open, read, tempDir, cleanupTempDirs, write } from "./test-support.ts";

cleanupTempDirs();

function store(dir: string, extra: Partial<ConstructorParameters<typeof KnowledgeStore>[0]> = {}): KnowledgeStore {
  return new KnowledgeStore({ learnDir: dir, now: () => new Date("2026-11-01T09:00:00Z"), pid: 100, host: "h", isAlive: () => false, ...extra });
}

describe("format stamp", () => {
  it("B-2-30 an absent stamp reads as version 1 and a read never writes it", () => {
    const dir = tempDir();
    expect(readFormatVersion(path.join(dir, "graph"))).toBe(1);
    open(dir).snapshot();
    expect(fs.existsSync(path.join(dir, "graph/format.json"))).toBe(false);
  });

  it("B-2-30 the first ledger append creates the stamp at version 1", () => {
    const dir = tempDir();
    open(dir).appendNodes([node("n_1", "A", "S")]);
    expect(JSON.parse(read(dir, "graph/format.json"))).toEqual({ version: FORMAT_VERSION });
  });

  it("B-2-31 writing render settings stamps the folder too", () => {
    const dir = tempDir();
    open(dir).writeRenderSettings({ sizeUnits: "world" });
    expect(JSON.parse(read(dir, "graph/format.json"))).toEqual({ version: 1 });
  });

  it("a malformed stamp reads as version 1 and a newer one refuses with 503", () => {
    const dir = tempDir();
    write(dir, "graph/format.json", "{broken");
    expect(readFormatVersion(path.join(dir, "graph"))).toBe(1);
    write(dir, "graph/format.json", JSON.stringify({ version: 7 }));
    expect(() => open(dir).snapshot()).toThrowError(expect.objectContaining({ status: 503, code: "format_newer", extra: { found: 7, supported: 1 } }));
  });
});

describe("ledger store", () => {
  it("B-2-08 round trips lines, skips what does not parse or fit the shape and keeps both on a rewrite", () => {
    const dir = tempDir();
    const s = store(dir);
    const file = s.graphFile("nodes.jsonl");
    s.appendLines(file, [node("n_1", "A", "S1"), node("n_2", "B", "S2")]);
    fs.appendFileSync(file, "not json\n" + JSON.stringify({ id: "n_9" }) + "\n");
    expect(s.readLedger(file, isNodeLine).map((n) => n.id)).toEqual(["n_1", "n_2"]);
    s.rewriteLedger(file, [node("n_2", "B", "S2")]);
    const text = fs.readFileSync(file, "utf8");
    expect(text.split("\n").filter(Boolean)).toEqual([JSON.stringify(node("n_2", "B", "S2")), JSON.stringify({ id: "n_9" }), "not json"]);
    expect(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("reads a file with CRLF line ends", () => {
    const dir = tempDir();
    const file = path.join(dir, "graph/nodes.jsonl");
    write(dir, "graph/nodes.jsonl", JSON.stringify(node("n_1", "A", "S")) + "\r\n");
    expect(store(dir).readLedger(file, isNodeLine)).toHaveLength(1);
  });

  it("archives lines under archive/<date>/ and appends to an existing file", () => {
    const dir = tempDir();
    const s = store(dir);
    s.archive("nodes", [node("n_1", "A", "S")]);
    s.archive("nodes", [node("n_2", "B", "S")]);
    s.archive("chains", []);
    expect(read(dir, "archive/2026-11-01/nodes.jsonl").trim().split("\n")).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, "archive/2026-11-01/chains.jsonl"))).toBe(false);
  });

  it("the revision is the newest modification time of the graph files", () => {
    const dir = tempDir();
    const s = store(dir);
    expect(s.revision()).toBe(0);
    s.appendLines(s.graphFile("nodes.jsonl"), [node("n_1", "A", "S")]);
    const t = new Date("2026-10-01T00:00:00Z");
    fs.utimesSync(s.graphFile("nodes.jsonl"), t, t);
    expect(s.revision()).toBe(t.getTime());
    write(dir, "graph/positions.json", "{}");
    expect(s.revision()).toBeGreaterThan(t.getTime());
  });
});

describe("writer lock", () => {
  it("takes the lock, writes the shape of the contract and removes it on release", () => {
    const dir = tempDir();
    const s = store(dir);
    s.acquireLock();
    expect(JSON.parse(read(dir, "cortex/writer.lock"))).toEqual({ pid: 100, host: "h", since: "2026-11-01T09:00:00.000Z" });
    s.releaseLock();
    expect(fs.existsSync(path.join(dir, "cortex/writer.lock"))).toBe(false);
  });

  it("a live process of another application blocks the lock and every write", () => {
    const dir = tempDir();
    write(dir, "cortex/writer.lock", JSON.stringify({ pid: 999, host: "other", since: "2026-11-01T08:00:00Z" }));
    const s = store(dir, { isAlive: (pid) => pid === 999 });
    expect(() => s.acquireLock()).toThrowError(expect.objectContaining({ status: 409, code: "busy" }));
    expect(() => s.appendLines(s.graphFile("nodes.jsonl"), [node("n_1", "A", "S")])).toThrowError(/writing the learning folder/);
    expect(() => s.rewriteLedger(s.graphFile("nodes.jsonl"), [])).toThrowError(/writing the learning folder/);
    expect(s.readLedger(s.graphFile("nodes.jsonl"), isNodeLine)).toEqual([]);
  });

  it("replaces the lock of a process that no longer exists and logs the replacement", () => {
    const dir = tempDir();
    write(dir, "cortex/writer.lock", JSON.stringify({ pid: 999, host: "other", since: "2026-11-01T08:00:00Z" }));
    const log: string[] = [];
    const s = store(dir, { isAlive: () => false, log: (m) => log.push(m) });
    s.acquireLock();
    expect(JSON.parse(read(dir, "cortex/writer.lock")).pid).toBe(100);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("999");
  });

  it("does not remove a lock that another process holds", () => {
    const dir = tempDir();
    write(dir, "cortex/writer.lock", JSON.stringify({ pid: 999, host: "other", since: "x" }));
    store(dir).releaseLock();
    expect(fs.existsSync(path.join(dir, "cortex/writer.lock"))).toBe(true);
  });
});

describe("ledger appends of the service", () => {
  it("B-2-02 keeps the message anchor of a provenance point and the chat level point of a chain", () => {
    const dir = tempDir();
    const k = open(dir);
    k.appendNodes([node("n_1", "A", "S", [{ chatId: "chat_a", messageId: "msg_1" }])]);
    k.appendChains([{ id: "arg_1", premises: ["n_1"], conclusion: "n_1", createdAt: "x", provenance: [{ chatId: "chat_a", messageId: "" }] }]);
    expect(k.snapshot().propositions[0].provenance).toEqual([{ chatId: "chat_a", messageId: "msg_1" }]);
    expect(lines([1])).toBe("1\n");
  });
});
