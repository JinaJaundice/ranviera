import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { RatifyClaim } from "../../../../shared/learn/knowledge.ts";
import { handleKnowledge } from "./http.ts";
import type { Knowledge, KnowledgeOptions } from "./index.ts";
import { chain, fixtureCopy, lines, node, open, prov, read, tempDir, cleanupTempDirs, write } from "./test-support.ts";

cleanupTempDirs();

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function serve(service: Knowledge): Promise<string> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleKnowledge(service, req, res, url.pathname, url.searchParams).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("{}");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) {
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  // the answers are checked field by field, so the parsed body is left loose
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
}

function graphDir(extra: Partial<KnowledgeOptions> = {}) {
  const dir = tempDir();
  write(dir, "graph/nodes.jsonl", lines([node("n_1", "One", "First.", [prov("src_a")]), node("n_2", "Two", "Second.", [prov("src_b")]), node("n_3", "Three", "Third.", [prov("src_a")])]));
  write(dir, "graph/chains.jsonl", lines([chain("arg_1", ["n_1", "n_2"], "n_3", [prov("src_a")])]));
  return { dir, k: open(dir, extra) };
}

describe("routes 30 to 37", () => {
  it("30 returns the snapshot and filters by max", async () => {
    const { dir, k } = graphDir();
    write(dir, "cortex/sources.json", JSON.stringify({ roots: { r1: { sensitivity: "client-confidential" }, r2: { sensitivity: "public" } } }));
    write(dir, "cortex/files.jsonl", lines([{ sourceId: "src_a", rootId: "r1" }, { sourceId: "src_b", rootId: "r2" }]));
    const base = await serve(k);
    const all = await call(base, "GET", "/api/learn/graph");
    expect(all.status).toBe(200);
    expect(all.json?.propositions).toHaveLength(3);
    const open2 = await call(base, "GET", "/api/learn/graph?max=public");
    expect(open2.json?.propositions.map((p: { id: string }) => p.id)).toEqual(["n_2"]);
    expect(open2.json?.chains).toEqual([]);
    const bad = await call(base, "GET", "/api/learn/graph?max=secret");
    expect(bad).toMatchObject({ status: 400, json: { code: "bad_request" } });
  });

  it("answers 405 with an Allow header and ignores a path that is not its own", async () => {
    const base = await serve(graphDir().k);
    expect((await call(base, "POST", "/api/learn/graph", {})).status).toBe(405);
    expect((await call(base, "GET", "/api/learn/graph/positions")).status).toBe(405);
    expect((await call(base, "GET", "/api/learn/sessions")).status).toBe(404);
    const res = await fetch(`${base}/api/learn/graph`, { method: "DELETE" });
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("34 commits a drag, and 35 and 36 read and write the render settings", async () => {
    const { dir, k } = graphDir();
    const base = await serve(k);
    expect((await call(base, "GET", "/api/learn/graph/render-settings")).json).toBeNull();
    const put = await call(base, "PUT", "/api/learn/graph/render-settings", { sizeUnits: "world", nodeSize: 7, physics: { depthMode: "vertical" } });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ nodeSize: 8, physics: { depthMode: "vertical" } });
    expect((await call(base, "GET", "/api/learn/graph/render-settings")).json).toEqual(put.json);
    expect(JSON.parse(read(dir, "graph/format.json"))).toEqual({ version: 1 });
    const all = { n_1: { x: 1, y: 2 }, n_2: { x: 3, y: 4 }, n_3: { x: 5, y: 6 }, arg_1: { x: 7, y: 8 } };
    const drag = await call(base, "PUT", "/api/learn/graph/positions", { positions: { ...all, other: { x: 1, y: 1 } } });
    expect(drag.json).toEqual({ positions: all });
    expect((await call(base, "GET", "/api/learn/graph")).json?.positions).toEqual(all);
  });

  it("37 deletes a proposition, answers 404 for an unknown one and 409 during an extraction", async () => {
    let busy = false;
    const { k } = graphDir({ extractionRegistered: () => busy });
    const base = await serve(k);
    expect((await call(base, "DELETE", "/api/learn/graph/nodes/n_missing")).status).toBe(404);
    expect((await call(base, "DELETE", "/api/learn/graph/nodes/bad%20id")).status).toBe(400);
    busy = true;
    expect(await call(base, "DELETE", "/api/learn/graph/nodes/n_1")).toMatchObject({ status: 409, json: { code: "extraction_running" } });
    busy = false;
    const done = await call(base, "DELETE", "/api/learn/graph/nodes/n_1");
    expect(done.status).toBe(200);
    expect(done.json?.stats).toMatchObject({ nodesRemoved: 1, chainsRemoved: 1 });
    expect(typeof done.json?.graphRevision).toBe("number");
  });

  it("answers 503 with the code format_newer for a newer stamp", async () => {
    const dir = fixtureCopy("format-newer");
    const base = await serve(open(dir));
    expect(await call(base, "GET", "/api/learn/graph")).toMatchObject({ status: 503, json: { code: "format_newer", found: 2, supported: 1 } });
  });

  it("answers 415 for a body that is not JSON and 400 for a body that is not an object", async () => {
    const base = await serve(graphDir().k);
    expect((await call(base, "PUT", "/api/learn/graph/render-settings", "x=1", { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await call(base, "PUT", "/api/learn/graph/render-settings", "[1]")).status).toBe(400);
    expect((await call(base, "PUT", "/api/learn/graph/render-settings", "{broken")).status).toBe(400);
  });
});

describe("routes 47 to 49", () => {
  it("47 and 48 read the directory and apply actions", async () => {
    const { k } = graphDir({ newFolderId: () => "f1" });
    const base = await serve(k);
    const first = await call(base, "GET", "/api/learn/source-organization");
    expect(first.json?.organization).toEqual({ version: 1, folders: [], placements: {} });
    expect(first.json?.sources.map((s: { id: string; kind: string }) => [s.id, s.kind])).toEqual([["src_a", "missing"], ["src_b", "missing"]]);
    const made = await call(base, "POST", "/api/learn/source-organization", { type: "create-folder", name: "Physics", parentId: null });
    expect(made.json?.createdFolderId).toBe("folder_f1");
    const moved = await call(base, "POST", "/api/learn/source-organization", { type: "move", kind: "source", id: "src_a", parentId: "folder_f1" });
    expect(moved.json?.directory.organization.placements.src_a).toEqual({ folderId: "folder_f1" });
    expect((await call(base, "POST", "/api/learn/source-organization", { type: "delete-folder", id: "folder_f1" })).status).toBe(400);
    expect((await call(base, "POST", "/api/learn/source-organization", { type: "nope" })).status).toBe(400);
  });

  it("refuses a body over 64 KiB with 413 and changes nothing", async () => {
    const { dir, k } = graphDir();
    const base = await serve(k);
    const big = await call(base, "POST", "/api/learn/source-organization", { type: "create-folder", name: "x".repeat(70 * 1024), parentId: null });
    expect(big).toMatchObject({ status: 413, json: { code: "too_large" } });
    expect(await call(base, "GET", "/api/learn/source-organization").then((r) => r.json?.organization.folders)).toEqual([]);
    void dir;
  });

  it("49 deletes sources by the delete-nodes rules and needs an explicit deleteSessions", async () => {
    const { dir, k } = graphDir();
    const base = await serve(k);
    expect((await call(base, "DELETE", "/api/learn/source-organization", { sourceIds: ["src_a"], folderIds: [] })).status).toBe(400);
    expect((await call(base, "DELETE", "/api/learn/source-organization", { sourceIds: [], folderIds: [], deleteSessions: false })).status).toBe(400);
    expect((await call(base, "DELETE", "/api/learn/source-organization", { sourceIds: ["../x"], folderIds: [], deleteSessions: false })).status).toBe(400);
    const done = await call(base, "DELETE", "/api/learn/source-organization", { sourceIds: ["src_a"], folderIds: [], deleteSessions: false });
    expect(done.status).toBe(200);
    expect(typeof done.json?.graphRevision).toBe("number");
    expect(read(dir, "graph/nodes.jsonl").trim().split("\n").map((l) => JSON.parse(l).id)).toEqual(["n_2"]);
  });

  it("49 answers 409 while an extraction is registered", async () => {
    const { k } = graphDir({ extractionRegistered: () => true });
    const base = await serve(k);
    expect(await call(base, "DELETE", "/api/learn/source-organization", { sourceIds: ["src_a"], folderIds: [], deleteSessions: false })).toMatchObject({ status: 409, json: { code: "extraction_running" } });
  });
});

describe("route 50", () => {
  it("writes the assertions, rebuilds, and answers with the revision", async () => {
    const order: string[] = [];
    const seen: RatifyClaim[] = [];
    const { k } = graphDir({
      ratify: {
        writeAssertions: (c) => {
          order.push("write");
          seen.push(c);
          return 3;
        },
        rebuild: async () => {
          await new Promise((r) => setTimeout(r, 5));
          order.push("rebuild");
        },
      },
    });
    const base = await serve(k);
    const done = await call(base, "POST", "/api/learn/graph/ratify", { claim: "claim:0123456789ab", status: "ratified" });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ assertions: 3 });
    expect(typeof done.json?.graphRevision).toBe("number");
    expect(order).toEqual(["write", "rebuild"]);
    const rejected = await call(base, "POST", "/api/learn/graph/ratify", { claim: "claim:0123456789ab", status: "rejected", reason: "  Wrong source.  " });
    expect(rejected.status).toBe(200);
    expect(seen[1]).toEqual({ claim: "claim:0123456789ab", status: "rejected", reason: "Wrong source." });
  });

  it("refuses a bad claim, a missing reason and an unavailable ratifier", async () => {
    const base = await serve(graphDir({ ratify: { writeAssertions: () => 1, rebuild: () => undefined } }).k);
    expect((await call(base, "POST", "/api/learn/graph/ratify", { claim: "claim:xyz", status: "ratified" })).status).toBe(400);
    expect((await call(base, "POST", "/api/learn/graph/ratify", { claim: "claim:0123456789ab", status: "maybe" })).status).toBe(400);
    expect((await call(base, "POST", "/api/learn/graph/ratify", { claim: "claim:0123456789ab", status: "rejected" })).status).toBe(400);
    const bare = await serve(graphDir().k);
    expect((await call(bare, "POST", "/api/learn/graph/ratify", { claim: "claim:0123456789ab", status: "ratified" })).status).toBe(404);
  });

  it("reports a failed rebuild as 500 and still handles the next request", async () => {
    let fail = true;
    const { k } = graphDir({ ratify: { writeAssertions: () => 1, rebuild: () => { if (fail) throw new Error("The rebuild failed."); } } });
    const base = await serve(k);
    expect(await call(base, "POST", "/api/learn/graph/ratify", { claim: "claim:0123456789ab", status: "ratified" })).toMatchObject({ status: 500, json: { error: "The rebuild failed." } });
    fail = false;
    expect((await call(base, "POST", "/api/learn/graph/ratify", { claim: "claim:0123456789ab", status: "ratified" })).status).toBe(200);
  });
});

describe("route 51", () => {
  const loc = (nodeId: string, sourceId: string, at: string, startLine: number | null, found = true) => ({
    nodeId, sourceId, fileSha256: "abc", startLine, endLine: startLine, page: null, heading: null, quote: "A quote.", found, at,
  });

  it("returns the newest locator for each source of a node and skips other nodes", async () => {
    const { dir, k } = graphDir();
    write(dir, "cortex/locators.jsonl", lines([
      loc("n_1", "src_a", "2026-11-01T10:00:00.000Z", 4),
      loc("n_1", "src_a", "2026-11-02T10:00:00.000Z", 9),
      loc("n_1", "src_b", "2026-11-01T10:00:00.000Z", null, false),
      loc("n_2", "src_b", "2026-11-01T10:00:00.000Z", 2),
    ]));
    const base = await serve(k);
    const got = await call(base, "GET", "/api/learn/locators?node=n_1");
    expect(got.status).toBe(200);
    const rows = got.json?.locators as { sourceId: string; startLine: number | null }[];
    expect(rows.map((l) => [l.sourceId, l.startLine])).toEqual([["src_a", 9], ["src_b", null]]);
  });

  it("answers an empty list for an unknown node or a missing file, and 400 for a missing or malformed node", async () => {
    const { k } = graphDir();
    const base = await serve(k);
    expect(await call(base, "GET", "/api/learn/locators?node=n_9")).toMatchObject({ status: 200, json: { locators: [] } });
    expect((await call(base, "GET", "/api/learn/locators")).status).toBe(400);
    expect((await call(base, "GET", "/api/learn/locators?node=a%20b")).status).toBe(400);
    expect(await call(base, "POST", "/api/learn/locators?node=n_1", {})).toMatchObject({ status: 405 });
  });
});
