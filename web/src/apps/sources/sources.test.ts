import { describe, expect, it } from "vitest";
import type { FileRecord, RootSummary } from "@shared/learn/sources";
import { impactLines } from "./UnlinkDialog";
import { buildAddRoot } from "./AddRootForm";
import { buildTree, matchingFiles, nodeIndex, selectedPaths, summaryCounts, toggleSelection, triState, visibleRows } from "./tree";
import { LearnApiError } from "../../lib/learn/models";
import { bytesWords, confirmNeeded, confirmWords, countsWords, extractWords, resultWords, summaryWords } from "./words";

const root = (id: string, label: string): RootSummary => ({
  id,
  kind: "notes",
  path: `C:/notes/${label}`,
  label,
  include: [],
  exclude: [],
  sensitivity: "internal",
  mode: "manual",
  enabled: true,
  hostedConsentAt: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  lastScanAt: null,
  counts: { files: 0, pending: 0, current: 0, missing: 0, refused: 0 },
});

const file = (rootId: string, p: string, state: FileRecord["state"], extra: Partial<FileRecord> = {}): FileRecord => ({
  sourceId: `src_${p.replace(/\W/g, "")}`,
  rootId,
  path: p,
  sha256: "x",
  bytes: 100,
  mtimeMs: 1,
  state,
  firstSeenAt: "2026-10-01T10:00:00.000Z",
  lastSeenAt: "2026-10-01T10:00:00.000Z",
  lastExtractedAt: null,
  lastExtractedSha256: null,
  outcome: null,
  ...extra,
});

const roots = [root("root_1", "Notes"), root("root_2", "Empty")];
const files = {
  root_1: [
    file("root_1", "a.md", "current", { outcome: "completed", stats: { nodes: 4, chains: 2 } }),
    file("root_1", "physics/entropy.md", "pending"),
    file("root_1", "physics/deep/heat.md", "pending"),
    file("root_1", "gone.md", "missing"),
    file("root_1", "big.pdf", "refused", { reason: "too_large" }),
  ],
};
const forest = () => buildTree(roots, files);

describe("tree model", () => {
  it("builds roots, then folders, then files, with folders first and a root with no files kept", () => {
    const f = forest();
    expect(f.map((r) => r.label)).toEqual(["Notes", "Empty"]);
    expect(f[0].children.map((c) => `${c.kind}:${c.label}`)).toEqual(["folder:physics", "file:a.md", "file:big.pdf", "file:gone.md"]);
    expect(f[0].children[0].children.map((c) => c.label)).toEqual(["deep", "entropy.md"]);
    expect(f[1].children).toEqual([]);
  });

  it("rolls the number of files in each state up to the folder and the root, and keeps each file's own count", () => {
    const f = forest();
    expect(f[0].counts).toEqual({ files: 5, pending: 2, current: 1, missing: 1, refused: 1 });
    const physics = f[0].children[0];
    expect(physics.counts.files).toBe(2);
    expect(physics.children[1].counts).toMatchObject({ files: 1, pending: 1 });
    expect(summaryCounts(f)).toEqual({ roots: 2, files: 5 });
    expect(summaryWords(2, 5)).toBe("2 roots, 5 files");
    expect(summaryWords(1, 1)).toBe("1 root, 1 file");
  });

  it("makes only files that are on disk and not refused selectable (B-6-17)", () => {
    const f = forest();
    expect(f[0].selectable.sort()).toEqual(["src_amd", "src_physicsdeepheatmd", "src_physicsentropymd"].sort());
  });
});

describe("tri-state selection", () => {
  it("reads none, some and all from the selected ids, and none for a row with nothing to select", () => {
    const f = forest();
    const idx = nodeIndex(f);
    const physics = idx.get("root_1:physics")!;
    expect(triState(physics, new Set())).toBe("none");
    expect(triState(physics, new Set(["src_physicsentropymd"]))).toBe("some");
    expect(triState(physics, new Set(["src_physicsentropymd", "src_physicsdeepheatmd"]))).toBe("all");
    expect(triState(idx.get("src_gonemd")!, new Set(["src_gonemd"]))).toBe("none");
    expect(triState(f[1], new Set())).toBe("none");
  });

  it("selects everything below on a click, and clears a full selection", () => {
    const f = forest();
    const physics = nodeIndex(f).get("root_1:physics")!;
    const all = toggleSelection(physics, new Set());
    expect([...all].sort()).toEqual(["src_physicsdeepheatmd", "src_physicsentropymd"]);
    expect(triState(physics, all)).toBe("all");
    expect(toggleSelection(physics, all).size).toBe(0);
    const some = toggleSelection(physics, new Set(["src_physicsentropymd"]));
    expect(triState(physics, some)).toBe("all");
  });

  it("keeps a selection outside the folder when the folder is cleared, and does not let the filter shrink a folder selection", () => {
    const f = forest();
    const idx = nodeIndex(f);
    const physics = idx.get("root_1:physics")!;
    const start = new Set(["src_amd"]);
    expect(toggleSelection(physics, toggleSelection(physics, start))).toEqual(start);
    const filtered = matchingFiles(f, "entropy");
    expect(filtered?.size).toBe(1);
    expect(toggleSelection(physics, new Set()).size).toBe(2);
  });

  it("lists the paths below a root that are selected, for the extract call", () => {
    const f = forest();
    expect(selectedPaths(f, "root_1", new Set(["src_amd", "src_physicsentropymd", "src_other"])).sort()).toEqual(["a.md", "physics/entropy.md"]);
    expect(selectedPaths(f, "root_2", new Set(["src_amd"]))).toEqual([]);
  });
});

describe("filter and rows", () => {
  it("returns null for an empty query and fuzzy matches the path, the state and the outcome", () => {
    const f = forest();
    expect(matchingFiles(f, "  ")).toBeNull();
    expect([...(matchingFiles(f, "entrpy") ?? [])]).toEqual(["src_physicsentropymd"]);
    expect([...(matchingFiles(f, "missing") ?? [])]).toEqual(["src_gonemd"]);
    expect([...(matchingFiles(f, "completed") ?? [])]).toEqual(["src_amd"]);
    expect(matchingFiles(f, "zzzzzz")?.size).toBe(0);
  });

  it("starts collapsed and shows a row only when its parent is open", () => {
    const f = forest();
    expect(visibleRows(f, new Set(), new Set(), null).map((r) => r.node.id)).toEqual(["root_1", "root_2"]);
    const open = visibleRows(f, new Set(["root_1"]), new Set(), null).map((r) => r.node.id);
    expect(open).toEqual(["root_1", "root_1:physics", "src_amd", "src_bigpdf", "src_gonemd", "root_2"]);
  });

  it("shows only matching files and their ancestors, opens them by itself and honours a closed folder", () => {
    const f = forest();
    const m = matchingFiles(f, "heat");
    const rows = visibleRows(f, new Set(), new Set(), m).map((r) => r.node.id);
    expect(rows).toEqual(["root_1", "root_1:physics", "root_1:physics/deep", "src_physicsdeepheatmd"]);
    const closed = visibleRows(f, new Set(), new Set(["root_1:physics"]), m).map((r) => r.node.id);
    expect(closed).toEqual(["root_1", "root_1:physics"]);
    expect(visibleRows(f, new Set(), new Set(), new Set()).map((r) => r.node.id)).toEqual([]);
  });
});

describe("words", () => {
  it("states the result of a file in plain words", () => {
    const f = forest();
    const idx = nodeIndex(f);
    expect(resultWords(idx.get("src_amd")!.file!)).toBe("Read in full, 4 propositions, 2 chains");
    expect(resultWords(idx.get("src_physicsentropymd")!.file!)).toBe("Not read yet");
    expect(resultWords(idx.get("src_bigpdf")!.file!)).toBe("The file is larger than the limit of 25 MiB.");
    expect(resultWords(idx.get("src_gonemd")!.file!)).toBe("File not found");
    expect(countsWords(f[0].counts)).toBe("1 up to date, 2 not read, 1 not found, 1 refused");
    expect(countsWords(f[1].counts)).toBe("No files");
  });

  it("writes sizes and the answer of an extract call", () => {
    expect(bytesWords(12)).toBe("12 bytes");
    expect(bytesWords(2048)).toBe("2.0 KiB");
    expect(bytesWords(3 * 1024 * 1024)).toBe("3.0 MiB");
    expect(extractWords(0, 0)).toMatch(/Nothing was queued/);
    expect(extractWords(2, 1)).toBe("3 files accepted. 2 started and 1 waiting.");
    expect(extractWords(1, 0)).toBe("1 file accepted and started.");
  });
  it("reads a confirm_required refusal and words the question", () => {
    const refusal = new LearnApiError(409, { error: "Confirm.", code: "confirm_required", files: 120, tokens: 250000 });
    expect(confirmNeeded(refusal)).toEqual({ files: 120, tokens: 250000 });
    expect(confirmNeeded(new LearnApiError(409, { error: "Busy.", code: "busy" }))).toBeNull();
    expect(confirmNeeded(new Error("x"))).toBeNull();
    expect(confirmWords({ files: 120, tokens: 250000 })).toBe("This will read 120 files, an estimated 250,000 tokens of text. Confirm to start the extraction.");
    expect(confirmWords({ files: 1, tokens: 1 })).toMatch(/^This will read 1 file, an estimated 1 token of text/);
  });
});

describe("forms and dialogs", () => {
  it("builds the body of the add form, dropping empty fields and splitting the patterns", () => {
    expect(buildAddRoot({ kind: "notes", path: " C:/n ", label: "", sensitivity: "internal", mode: "manual", include: "", exclude: "" })).toEqual({ kind: "notes", path: "C:/n", sensitivity: "internal", mode: "manual" });
    expect(buildAddRoot({ kind: "notes", path: "C:/n", label: " Mine ", sensitivity: "public", mode: "scan", include: "a/**\nb/**", exclude: "drafts/**, tmp/**" })).toEqual({
      kind: "notes",
      path: "C:/n",
      label: "Mine",
      sensitivity: "public",
      mode: "scan",
      include: ["a/**", "b/**"],
      exclude: ["drafts/**", "tmp/**"],
    });
  });

  it("names the mode and its impact before anything changes", () => {
    const r = { label: "Notes", counts: { files: 5, pending: 2, current: 1, missing: 1, refused: 1 } };
    const keep = impactLines(r, "preserve-graph").join(" ");
    expect(keep).toMatch(/stay in the graph/);
    expect(keep).toMatch(/never change/);
    const drop = impactLines(r, "delete-nodes").join(" ");
    expect(drop).toMatch(/deleted from the graph/);
    expect(drop).toMatch(/cannot be undone/);
    expect(impactLines({ ...r, counts: { ...r.counts, files: 1, current: 1 } }, "preserve-graph")[1]).toMatch(/1 file keeps/);
  });
});
