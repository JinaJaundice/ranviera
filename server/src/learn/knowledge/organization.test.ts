import { describe, expect, it } from "vitest";
import type { OrganizationFile } from "../../../../shared/learn/sources.ts";
import { applyAction, emptyOrganization, parseAction, parseOrganization, pruneAfterDeletion } from "./organization.ts";
import { lines, node, open, prov, read, tempDir, cleanupTempDirs, write } from "./test-support.ts";

cleanupTempDirs();

const NOW = new Date("2026-11-01T09:00:00Z");
let n = 0;
const newId = () => `id${++n}`;

function act(org: OrganizationFile, action: Parameters<typeof applyAction>[1]) {
  return applyAction(org, action, NOW, newId);
}

function tree(): OrganizationFile {
  let o = emptyOrganization();
  o = act(o, { type: "create-folder", name: "  Physics ", parentId: null }).organization;
  o = act(o, { type: "create-folder", name: "Heat", parentId: o.folders[0].id }).organization;
  return o;
}

describe("organisation operations", () => {
  it("creates a folder with a trimmed name and returns its identifier", () => {
    const r = act(emptyOrganization(), { type: "create-folder", name: "  Physics ", parentId: null });
    expect(r.createdFolderId).toMatch(/^folder_/);
    expect(r.organization.folders[0]).toMatchObject({ name: "Physics", parentId: null, createdAt: NOW.toISOString() });
  });

  it("refuses an empty name, an unknown parent and an unknown action", () => {
    expect(() => act(emptyOrganization(), { type: "create-folder", name: "  ", parentId: null })).toThrowError(/name/);
    expect(() => act(emptyOrganization(), { type: "create-folder", name: "A", parentId: "folder_none" })).toThrowError(/does not exist/);
    expect(() => act(emptyOrganization(), { type: "explode" } as never)).toThrowError(/not known/);
  });

  it("renames a folder and gives a source a display name that keeps its folder", () => {
    const o = tree();
    const renamed = act(o, { type: "rename-folder", id: o.folders[1].id, name: "Thermal" }).organization;
    expect(renamed.folders[1].name).toBe("Thermal");
    const placed = act(act(o, { type: "move", kind: "source", id: "src_1", parentId: o.folders[0].id }).organization, { type: "rename-source", id: "src_1", name: "Lecture one" }).organization;
    expect(placed.placements.src_1).toEqual({ folderId: o.folders[0].id, name: "Lecture one" });
  });

  it("moves a source to a folder or back to the root, and keeps its display name", () => {
    const o = tree();
    const named = act(o, { type: "rename-source", id: "src_1", name: "Name" }).organization;
    const moved = act(named, { type: "move", kind: "source", id: "src_1", parentId: o.folders[1].id }).organization;
    expect(moved.placements.src_1).toEqual({ folderId: o.folders[1].id, name: "Name" });
    expect(act(moved, { type: "move", kind: "source", id: "src_1", parentId: null }).organization.placements.src_1.folderId).toBeNull();
  });

  it("refuses to move a folder into itself or a descendant", () => {
    const o = tree();
    expect(() => act(o, { type: "move", kind: "folder", id: o.folders[0].id, parentId: o.folders[0].id })).toThrowError(/itself/);
    expect(() => act(o, { type: "move", kind: "folder", id: o.folders[0].id, parentId: o.folders[1].id })).toThrowError(/itself/);
    expect(act(o, { type: "move", kind: "folder", id: o.folders[1].id, parentId: null }).organization.folders[1].parentId).toBeNull();
  });

  it("deletes a folder only when it holds no folder and no source", () => {
    const o = tree();
    expect(() => act(o, { type: "delete-folder", id: o.folders[0].id })).toThrowError(/other folders/);
    const withSource = act(o, { type: "move", kind: "source", id: "src_1", parentId: o.folders[1].id }).organization;
    expect(() => act(withSource, { type: "delete-folder", id: o.folders[1].id })).toThrowError(/sources/);
    expect(act(o, { type: "delete-folder", id: o.folders[1].id }).organization.folders).toHaveLength(1);
  });

  it("applies to the current state and never changes the input", () => {
    const o = tree();
    const copy = JSON.stringify(o);
    act(o, { type: "create-folder", name: "More", parentId: null });
    expect(JSON.stringify(o)).toBe(copy);
  });
});

describe("strict parse", () => {
  const folder = (id: string, parentId: string | null, name = "F") => ({ id, name, parentId, createdAt: "x" });

  it("accepts a valid file and refuses each fault named in the contract", () => {
    expect(parseOrganization({ version: 1, folders: [folder("a", null), folder("b", "a")], placements: { s: { folderId: "b", name: "N" } } }).placements.s).toEqual({ folderId: "b", name: "N" });
    expect(() => parseOrganization({ version: 2, folders: [], placements: {} })).toThrowError(/unsupported version/);
    expect(() => parseOrganization({ version: 1, folders: [folder("a", null), folder("a", null)], placements: {} })).toThrowError(/two folders/);
    expect(() => parseOrganization({ version: 1, folders: [folder("a", null, " ")], placements: {} })).toThrowError(/empty name/);
    expect(() => parseOrganization({ version: 1, folders: [folder("a", "b"), folder("b", "a")], placements: {} })).toThrowError(/cycle/);
    expect(() => parseOrganization({ version: 1, folders: [folder("a", "zz")], placements: {} })).toThrowError(/parent that does not exist/);
    expect(() => parseOrganization({ version: 1, folders: [], placements: { s: { folderId: "none" } } })).toThrowError(/does not exist/);
    expect(() => parseOrganization("x")).toThrowError(/unsupported/);
  });
});

describe("request parsing", () => {
  it("reads each action type and refuses a bad body", () => {
    expect(parseAction({ type: "create-folder", name: "A" })).toEqual({ type: "create-folder", name: "A", parentId: null });
    expect(parseAction({ type: "move", kind: "folder", id: "f", parentId: "p" })).toEqual({ type: "move", kind: "folder", id: "f", parentId: "p" });
    expect(() => parseAction({ type: "move", kind: "other", id: "f" })).toThrowError(/source or folder/);
    expect(() => parseAction({ type: "rename-folder", id: 4, name: "x" })).toThrowError(/text/);
    expect(() => parseAction({})).toThrowError(/action type/);
  });
});

describe("pruning after a deletion", () => {
  it("removes the placements of removed sources and then the selected folders from the bottom up", () => {
    const o: OrganizationFile = {
      version: 1,
      folders: [
        { id: "a", name: "A", parentId: null, createdAt: "x" },
        { id: "b", name: "B", parentId: "a", createdAt: "x" },
        { id: "c", name: "C", parentId: null, createdAt: "x" },
      ],
      placements: { s1: { folderId: "b" }, s2: { folderId: "c" } },
    };
    const next = pruneAfterDeletion(o, new Set(["s1", "s2"]), new Set(["a", "b"]));
    expect(next.folders.map((f) => f.id)).toEqual(["c"]);
    expect(next.placements).toEqual({});
    expect(pruneAfterDeletion(o, new Set(["s1"]), new Set(["a"])).folders.map((f) => f.id)).toEqual(["a", "b", "c"]);
  });
});

describe("directory", () => {
  it("lists sessions, file sources and the provenance ids that have no record as missing", () => {
    const dir = tempDir();
    write(dir, "graph/nodes.jsonl", lines([node("n_1", "A", "S", [prov("chat_a"), prov("src_gone"), prov("src_n")])]));
    write(dir, "graph/sources.json", JSON.stringify({ src_n: { id: "src_n", filePath: "Notes/Week 1.md", importedAt: "2026-10-01T00:00:00Z" } }));
    write(dir, "chats/chat_a.json", JSON.stringify({ id: "chat_a", title: "A chat", createdAt: "2026-10-02T00:00:00Z" }));
    const k = open(dir);
    k.organize({ type: "rename-source", id: "src_n", name: "Week one" });
    const d = k.directory();
    expect(d.sources).toEqual([
      { id: "chat_a", kind: "chat", label: "A chat", createdAt: "2026-10-02T00:00:00Z" },
      { id: "src_n", kind: "notes", label: "Week one", createdAt: "2026-10-01T00:00:00Z", filePath: "Notes/Week 1.md" },
      { id: "src_gone", kind: "missing", label: null, createdAt: null },
    ]);
    expect(JSON.parse(read(dir, "graph/source-organization.json")).placements.src_n.name).toBe("Week one");
  });

  it("returns the identifier of a created folder and leaves an invalid file unchanged", () => {
    const dir = tempDir();
    const made = open(dir, { newFolderId: () => "fixed" }).organize({ type: "create-folder", name: "New", parentId: null });
    expect(made.createdFolderId).toBe("folder_fixed");
    write(dir, "graph/source-organization.json", "{broken");
    expect(() => open(dir).organize({ type: "create-folder", name: "Other", parentId: null })).toThrowError(/cannot be read/);
    expect(read(dir, "graph/source-organization.json")).toBe("{broken");
  });
});
