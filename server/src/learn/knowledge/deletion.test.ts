import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planPurge } from "./deletion.ts";
import { chain, lines, node, open, prov, read, tempDir, cleanupTempDirs, write } from "./test-support.ts";

cleanupTempDirs();

function seeded() {
  const dir = tempDir();
  write(dir, "graph/nodes.jsonl", lines([
    node("n_1", "One", "First fact.", [prov("chat_a", "msg_1")]),
    node("n_2", "Two", "Second fact.", [prov("chat_a", "msg_2")]),
    node("n_3", "Three", "Third fact.", [prov("src_b")]),
    node("n_1", "One again", "First fact in other words.", [prov("src_b")], ["other words"]),
  ]));
  write(dir, "graph/chains.jsonl", lines([
    chain("arg_1", ["n_1", "n_2"], "n_3", [prov("chat_a")]),
    chain("arg_2", ["n_1"], "n_3", [prov("src_b")]),
    chain("arg_3", ["n_3"], "n_2", [prov("src_b")]),
  ]));
  write(dir, "graph/positions.json", JSON.stringify({ positions: { n_1: { x: 0, y: 0 }, n_2: { x: 1, y: 1 }, n_3: { x: 2, y: 2 }, arg_1: { x: 3, y: 3 }, arg_3: { x: 4, y: 4 } }, updatedAt: "x" }));
  return dir;
}

const ids = (dir: string, file: string) => read(dir, file).split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id);

describe("source and session deletion", () => {
  it("B-2-12 a shared proposition survives and an orphan is removed, with its chains and position", () => {
    const dir = seeded();
    const stats = open(dir).deleteSources(["chat_a"], "delete-nodes");
    expect(stats).toMatchObject({ nodesRemoved: 1, chainsRemoved: 2 });
    expect(ids(dir, "graph/nodes.jsonl")).toEqual(["n_1", "n_3", "n_1"]);
    expect(ids(dir, "graph/chains.jsonl")).toEqual(["arg_2"]);
    const positions = JSON.parse(read(dir, "graph/positions.json")).positions;
    expect(Object.keys(positions).sort()).toEqual(["n_1", "n_3"]);
  });

  it("B-2-12 a surviving proposition keeps its identity when its creator is deleted", () => {
    const dir = seeded();
    open(dir).deleteSources(["chat_a"], "delete-nodes");
    const first = JSON.parse(read(dir, "graph/nodes.jsonl").split("\n")[0]);
    expect(first).toMatchObject({ id: "n_1", name: "One", statement: "First fact.", aliases: [], provenance: [] });
  });

  it("drops a link line of the deleted source with its phrasing", () => {
    const dir = seeded();
    open(dir).deleteSources(["src_b"], "delete-nodes");
    expect(ids(dir, "graph/nodes.jsonl")).toEqual(["n_1", "n_2"]);
    expect(ids(dir, "graph/chains.jsonl")).toEqual([]);
  });

  it("B-2-13 preserve-graph removes only the coverage and checkpoint lines", () => {
    const dir = seeded();
    write(dir, "graph/coverage.jsonl", lines([{ chatId: "chat_a", fp: "f", tokens: 1, foldedAt: "x" }, { chatId: "chat_z", fp: "g", tokens: 2, foldedAt: "x" }]));
    write(dir, "graph/sessions.jsonl", lines([{ chatId: "chat_a", foldedAt: "x" }]));
    const before = [read(dir, "graph/nodes.jsonl"), read(dir, "graph/chains.jsonl"), read(dir, "graph/positions.json")];
    const stats = open(dir).deleteSources(["chat_a"], "preserve-graph");
    expect(stats).toEqual({ nodesRemoved: 0, chainsRemoved: 0, coverageRemoved: 1, checkpointsRemoved: 1 });
    expect([read(dir, "graph/nodes.jsonl"), read(dir, "graph/chains.jsonl"), read(dir, "graph/positions.json")]).toEqual(before);
    expect(JSON.parse(read(dir, "graph/coverage.jsonl").trim()).chatId).toBe("chat_z");
  });

  it("B-2-14 is refused while an extraction is registered, and changes nothing", () => {
    const dir = seeded();
    const before = read(dir, "graph/nodes.jsonl");
    const k = open(dir, { extractionRegistered: () => true });
    expect(() => k.deleteSources(["chat_a"], "delete-nodes")).toThrowError(expect.objectContaining({ status: 409, code: "extraction_running" }));
    expect(read(dir, "graph/nodes.jsonl")).toBe(before);
    expect(fs.existsSync(path.join(dir, "archive"))).toBe(false);
  });

  it("archives every removed or changed line before it leaves a ledger", () => {
    const dir = seeded();
    open(dir).deleteSources(["chat_a"], "delete-nodes");
    const nodes = read(dir, "archive/2026-11-01/nodes.jsonl").trim().split("\n").map((l) => JSON.parse(l));
    expect(nodes.map((n) => [n.id, n.name])).toEqual([["n_1", "One"], ["n_2", "Two"]]);
    expect(nodes[0].provenance).toEqual([prov("chat_a", "msg_1")]);
    const chains = read(dir, "archive/2026-11-01/chains.jsonl").trim().split("\n").map((l) => JSON.parse(l).id);
    expect(chains).toEqual(["arg_1", "arg_3"]);
  });

  it("leaves a line without any provenance outside the blast radius", () => {
    const plan = planPurge([node("n_legacy", "L", "Legacy.", []), node("n_x", "X", "X.", [prov("c")])], [chain("arg_legacy", ["n_legacy"], "n_legacy", [])], new Set(["c"]));
    expect(plan.nodes.map((n) => n.id)).toEqual(["n_legacy"]);
    expect(plan.deadNodeIds).toEqual(new Set(["n_x"]));
    expect(plan.chains).toHaveLength(1);
  });

  it("keeps a line that still has a point from another source and strips the deleted point", () => {
    const plan = planPurge([node("n_x", "X", "X.", [prov("c"), prov("d")], ["alias"]), node("n_x", "X", "Y.", [prov("e")])], [chain("arg_1", ["n_x"], "n_x", [prov("c"), prov("d")])], new Set(["c"]));
    expect(plan.nodes[0].provenance).toEqual([prov("d")]);
    expect(plan.nodes[0].aliases).toEqual(["alias"]);
    expect(plan.chains[0].provenance).toEqual([prov("d")]);
  });
});

describe("deleting one proposition or one argument", () => {
  it("B-2-15 full death removes every line, every argument that names it, its position and archives them", () => {
    const dir = seeded();
    const done = open(dir).deleteNode("n_1");
    expect(done?.stats).toMatchObject({ nodesRemoved: 1, chainsRemoved: 2 });
    expect(ids(dir, "graph/nodes.jsonl")).toEqual(["n_2", "n_3"]);
    expect(ids(dir, "graph/chains.jsonl")).toEqual(["arg_3"]);
    expect(Object.keys(JSON.parse(read(dir, "graph/positions.json")).positions).sort()).toEqual(["arg_3", "n_2", "n_3"]);
    expect(read(dir, "archive/2026-11-01/nodes.jsonl").trim().split("\n")).toHaveLength(2);
    expect(read(dir, "archive/2026-11-01/chains.jsonl").trim().split("\n")).toHaveLength(2);
  });

  it("B-2-15 a proposition that nothing references still dies", () => {
    const dir = tempDir();
    write(dir, "graph/nodes.jsonl", lines([node("n_solo", "Solo", "Alone.", [])]));
    expect(open(dir).deleteNode("n_solo")?.stats.nodesRemoved).toBe(1);
    expect(read(dir, "graph/nodes.jsonl")).toBe("");
  });

  it("deleting an arg_ identifier removes that argument only", () => {
    const dir = seeded();
    const done = open(dir).deleteNode("arg_2");
    expect(done?.stats).toMatchObject({ nodesRemoved: 0, chainsRemoved: 1 });
    expect(ids(dir, "graph/chains.jsonl")).toEqual(["arg_1", "arg_3"]);
    expect(ids(dir, "graph/nodes.jsonl")).toHaveLength(4);
  });

  it("B-2-16 returns null for an unknown identifier and refuses during an extraction", () => {
    const dir = seeded();
    expect(open(dir).deleteNode("n_missing")).toBeNull();
    expect(open(dir).deleteNode("arg_missing")).toBeNull();
    expect(() => open(dir, { extractionRegistered: () => true }).deleteNode("n_1")).toThrowError(expect.objectContaining({ code: "extraction_running" }));
    expect(ids(dir, "graph/nodes.jsonl")).toHaveLength(4);
  });
});

describe("deletion by the organisation route", () => {
  function org(dir: string) {
    write(dir, "graph/source-organization.json", JSON.stringify({
      version: 1,
      folders: [
        { id: "folder_outer", name: "Outer", parentId: null, createdAt: "x" },
        { id: "folder_inner", name: "Inner", parentId: "folder_outer", createdAt: "x" },
        { id: "folder_kept", name: "Kept", parentId: null, createdAt: "x" },
      ],
      placements: { src_b: { folderId: "folder_inner" }, chat_a: { folderId: "folder_kept" } },
    }));
    write(dir, "graph/sources.json", JSON.stringify({ src_b: { id: "src_b", filePath: "Notes/b.md", importedAt: "x" } }));
    write(dir, "graph/coverage.jsonl", lines([{ chatId: "chat_a", fp: "f", tokens: 1, foldedAt: "x" }]));
  }

  it("deletes sources by the delete-nodes rules, removes the record and the emptied folders bottom up", () => {
    const dir = seeded();
    org(dir);
    const deleted: string[] = [];
    const k = open(dir, { deleteChat: (id) => deleted.push(id) });
    const done = k.deleteBySelection({ sourceIds: ["src_b"], folderIds: ["folder_outer", "folder_inner"], deleteSessions: false });
    expect(done.directory.organization.folders.map((f) => f.id)).toEqual(["folder_kept"]);
    expect(Object.keys(JSON.parse(read(dir, "graph/sources.json")))).toEqual([]);
    expect(ids(dir, "graph/nodes.jsonl")).toEqual(["n_1", "n_2"]);
    expect(deleted).toEqual([]);
  });

  it("a kept session loses its coverage, keeps its placement and blocks its folder", () => {
    const dir = seeded();
    org(dir);
    const deleted: string[] = [];
    const k = open(dir, { deleteChat: (id) => deleted.push(id) });
    const done = k.deleteBySelection({ sourceIds: ["chat_a"], folderIds: ["folder_kept"], deleteSessions: false });
    expect(done.directory.organization.folders.map((f) => f.id)).toContain("folder_kept");
    expect(done.directory.organization.placements.chat_a).toEqual({ folderId: "folder_kept" });
    expect(read(dir, "graph/coverage.jsonl")).toBe("");
    expect(deleted).toEqual([]);
    const again = k.deleteBySelection({ sourceIds: ["chat_a"], folderIds: ["folder_kept"], deleteSessions: true });
    expect(deleted).toEqual(["chat_a"]);
    expect(again.directory.organization.folders.map((f) => f.id)).not.toContain("folder_kept");
  });

  it("refuses while an extraction is registered and when a selected session has a live turn, before any write", () => {
    const dir = seeded();
    org(dir);
    const before = read(dir, "graph/nodes.jsonl");
    expect(() => open(dir, { extractionRegistered: () => true }).deleteBySelection({ sourceIds: ["src_b"], folderIds: [], deleteSessions: false })).toThrowError(expect.objectContaining({ code: "extraction_running" }));
    expect(() => open(dir, { chatBusy: () => true }).deleteBySelection({ sourceIds: ["chat_a"], folderIds: [], deleteSessions: true })).toThrowError(expect.objectContaining({ status: 409, code: "turn_running" }));
    expect(() => open(dir).deleteBySelection({ sourceIds: ["src_b"], folderIds: ["folder_none"], deleteSessions: false })).toThrowError(expect.objectContaining({ status: 404 }));
    expect(read(dir, "graph/nodes.jsonl")).toBe(before);
  });

  it("refuses without touching the data when the organisation file is invalid", () => {
    const dir = seeded();
    write(dir, "graph/source-organization.json", JSON.stringify({ version: 2, folders: [], placements: {} }));
    const before = read(dir, "graph/nodes.jsonl");
    expect(() => open(dir).deleteBySelection({ sourceIds: ["src_b"], folderIds: [], deleteSessions: false })).toThrowError(/unsupported version/);
    expect(read(dir, "graph/nodes.jsonl")).toBe(before);
  });
});

describe("what a deletion must not lose and must not leave", () => {
  const odd = JSON.stringify({ id: "n_odd", name: "Odd", statement: "A line of another shape.", aliases: [], createdAt: 12, provenance: [] });

  it("keeps a valid JSON line of the wrong shape through a session purge, a full death and an argument deletion", () => {
    const dir = seeded();
    write(dir, "graph/nodes.jsonl", `${read(dir, "graph/nodes.jsonl")}${odd}\n`);
    write(dir, "graph/chains.jsonl", `${read(dir, "graph/chains.jsonl")}{"id":"arg_odd","premises":[]}\n`);
    open(dir).deleteSources(["chat_a"], "delete-nodes");
    expect(read(dir, "graph/nodes.jsonl")).toContain(odd);
    expect(read(dir, "graph/chains.jsonl")).toContain("arg_odd");
    open(dir).deleteNode("n_1");
    expect(read(dir, "graph/nodes.jsonl")).toContain(odd);
    expect(read(dir, "graph/chains.jsonl")).toContain("arg_odd");
    open(dir).deleteNode("arg_3");
    expect(read(dir, "graph/chains.jsonl")).toContain("arg_odd");
  });

  it("removes and archives the locators and file records of a deleted source, and the locators of a dead proposition", () => {
    const dir = seeded();
    const loc = (nodeId: string, sourceId: string) => ({ nodeId, sourceId, fileSha256: "h", startLine: 1, endLine: 1, page: null, heading: null, quote: `quote of ${nodeId}`, found: true });
    write(dir, "cortex/locators.jsonl", lines([loc("n_2", "chat_a"), loc("n_1", "chat_a"), loc("n_1", "src_b"), loc("n_3", "src_b")]));
    const file = (sourceId: string) => ({ sourceId, rootId: "root_1", path: `${sourceId}.md`, sha256: "h", bytes: 1, mtimeMs: 1, state: "current", firstSeenAt: "x", lastSeenAt: "x", lastExtractedAt: null });
    write(dir, "cortex/files.jsonl", lines([file("src_b"), file("src_c")]));
    open(dir).deleteSources(["chat_a", "src_b"], "delete-nodes");
    expect(read(dir, "cortex/locators.jsonl")).toBe("");
    expect(read(dir, "cortex/files.jsonl").trim().split("\n").map((l) => JSON.parse(l).sourceId)).toEqual(["src_c"]);
    expect(read(dir, "archive/2026-11-01/locators.jsonl").trim().split("\n")).toHaveLength(4);
    expect(JSON.parse(read(dir, "archive/2026-11-01/files.jsonl").trim()).sourceId).toBe("src_b");
  });

  it("a full death removes the locators of the proposition and keeps the others", () => {
    const dir = seeded();
    const loc = (nodeId: string) => ({ nodeId, sourceId: "src_b", fileSha256: "h", startLine: null, endLine: null, page: null, heading: null, quote: "q", found: false });
    write(dir, "cortex/locators.jsonl", lines([loc("n_1"), loc("n_3")]));
    open(dir).deleteNode("n_1");
    expect(read(dir, "cortex/locators.jsonl").trim().split("\n").map((l) => JSON.parse(l).nodeId)).toEqual(["n_3"]);
    expect(read(dir, "archive/2026-11-01/locators.jsonl").trim().split("\n")).toHaveLength(1);
  });

  it("preserve-graph leaves the locators alone", () => {
    const dir = seeded();
    const text = lines([{ nodeId: "n_1", sourceId: "chat_a", fileSha256: "h", startLine: null, endLine: null, page: null, heading: null, quote: "q", found: false }]);
    write(dir, "cortex/locators.jsonl", text);
    open(dir).deleteSources(["chat_a"], "preserve-graph");
    expect(read(dir, "cortex/locators.jsonl")).toBe(text);
  });
});
