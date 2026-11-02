// The model of the source tree: linked roots, then folders, then files. Everything here is pure, so that the tree, the
// tri-state selection and the filter are tested without a screen.
import Fuse from "fuse.js";
import type { FileRecord, RootSummary } from "@shared/learn/sources";

export type TreeKind = "root" | "folder" | "file";

export interface TreeNode {
  /** a root id, "<root id>:<directory>" for a folder, and the source id for a file */
  id: string;
  kind: TreeKind;
  label: string;
  parentId: string | null;
  rootId: string;
  depth: number;
  children: TreeNode[];
  root?: RootSummary;
  file?: FileRecord;
  /** the source ids of the files below that a person may select for extraction */
  selectable: string[];
  /** all files below, with the number in each state */
  counts: { files: number; pending: number; current: number; missing: number; refused: number };
}

export type Tri = "none" | "some" | "all";

const emptyCounts = () => ({ files: 0, pending: 0, current: 0, missing: 0, refused: 0 });

/** A file can be selected for extraction when it is on disk and was not refused. */
export function isSelectable(f: FileRecord): boolean {
  return f.state === "pending" || f.state === "current";
}

function byName(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return a.label.localeCompare(b.label, "en", { numeric: true, sensitivity: "base" });
}

function roll(n: TreeNode): void {
  // a file keeps the counts and the selection that it was made with
  if (!n.children.length) return;
  n.selectable = [];
  n.counts = emptyCounts();
  for (const c of n.children) {
    roll(c);
    n.selectable.push(...c.selectable);
    for (const k of Object.keys(n.counts) as (keyof TreeNode["counts"])[]) n.counts[k] += c.counts[k];
  }
}

/** Builds the forest. A path with no directory sits directly under its root. A root with no files is still a root. */
export function buildTree(roots: RootSummary[], filesByRoot: Record<string, FileRecord[]>): TreeNode[] {
  return roots.map((root) => {
    const top: TreeNode = {
      id: root.id,
      kind: "root",
      label: root.label,
      parentId: null,
      rootId: root.id,
      depth: 0,
      children: [],
      root,
      selectable: [],
      counts: emptyCounts(),
    };
    const folders = new Map<string, TreeNode>([["", top]]);
    const folderFor = (dir: string): TreeNode => {
      const hit = folders.get(dir);
      if (hit) return hit;
      const cut = dir.lastIndexOf("/");
      const parent = folderFor(cut < 0 ? "" : dir.slice(0, cut));
      const node: TreeNode = {
        id: `${root.id}:${dir}`,
        kind: "folder",
        label: cut < 0 ? dir : dir.slice(cut + 1),
        parentId: parent.id,
        rootId: root.id,
        depth: parent.depth + 1,
        children: [],
        selectable: [],
        counts: emptyCounts(),
      };
      parent.children.push(node);
      folders.set(dir, node);
      return node;
    };
    for (const f of filesByRoot[root.id] ?? []) {
      const cut = f.path.lastIndexOf("/");
      const parent = folderFor(cut < 0 ? "" : f.path.slice(0, cut));
      const leaf: TreeNode = {
        id: f.sourceId,
        kind: "file",
        label: cut < 0 ? f.path : f.path.slice(cut + 1),
        parentId: parent.id,
        rootId: root.id,
        depth: parent.depth + 1,
        children: [],
        file: f,
        selectable: isSelectable(f) ? [f.sourceId] : [],
        counts: { ...emptyCounts(), files: 1, [f.state]: 1 },
      };
      parent.children.push(leaf);
    }
    const sortAll = (n: TreeNode) => {
      n.children.sort(byName);
      n.children.forEach(sortAll);
    };
    sortAll(top);
    roll(top);
    return top;
  });
}

/** The state of a row's checkbox, from the selected source ids. A row with nothing to select reads as none. */
export function triState(node: TreeNode, selected: ReadonlySet<string>): Tri {
  if (!node.selectable.length) return "none";
  let hit = 0;
  for (const id of node.selectable) if (selected.has(id)) hit++;
  if (hit === 0) return "none";
  return hit === node.selectable.length ? "all" : "some";
}

/** A click on a checkbox. Anything but a full selection becomes full, and a full selection is cleared. The filter has no say: a
 * folder means every file below it, even those that the search hides. */
export function toggleSelection(node: TreeNode, selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  const clear = triState(node, selected) === "all";
  for (const id of node.selectable) {
    if (clear) next.delete(id);
    else next.add(id);
  }
  return next;
}

export function nodeIndex(forest: TreeNode[]): Map<string, TreeNode> {
  const map = new Map<string, TreeNode>();
  const walk = (n: TreeNode) => {
    map.set(n.id, n);
    n.children.forEach(walk);
  };
  forest.forEach(walk);
  return map;
}

export interface Row {
  node: TreeNode;
  open: boolean;
}

/** The ids of the files that match a query, by fuzzy search over the path, the root label, the state and the outcome. Null means no filter. */
export function matchingFiles(forest: TreeNode[], query: string): Set<string> | null {
  const q = query.trim();
  if (!q) return null;
  const files: { id: string; path: string; root: string; state: string; outcome: string }[] = [];
  const walk = (n: TreeNode, rootLabel: string) => {
    if (n.file) files.push({ id: n.id, path: n.file.path, root: rootLabel, state: n.file.state, outcome: n.file.outcome ?? "" });
    n.children.forEach((c) => walk(c, rootLabel));
  };
  forest.forEach((r) => walk(r, r.label));
  const fuse = new Fuse(files, { keys: ["path", "root", "state", "outcome"], threshold: 0.35, ignoreLocation: true });
  return new Set(fuse.search(q).map((h) => h.item.id));
}

/**
 * The rows on show. With a filter only the matching files and their ancestors appear, and every ancestor opens by itself
 * unless the reader closed it (the ids in `closed`). Without a filter a row is open only when its id is in `opened`.
 */
export function visibleRows(forest: TreeNode[], opened: ReadonlySet<string>, closed: ReadonlySet<string>, matches: Set<string> | null): Row[] {
  const rows: Row[] = [];
  const keep = (n: TreeNode): boolean => (matches === null ? true : n.file ? matches.has(n.id) : n.children.some(keep));
  const walk = (n: TreeNode) => {
    if (!keep(n)) return;
    const open = n.children.length > 0 && (matches === null ? opened.has(n.id) : !closed.has(n.id));
    rows.push({ node: n, open });
    if (open) n.children.forEach(walk);
  };
  forest.forEach(walk);
  return rows;
}

export function summaryCounts(forest: TreeNode[]): { roots: number; files: number } {
  return { roots: forest.length, files: forest.reduce((n, r) => n + r.counts.files, 0) };
}

/** The paths below a root that are selected, for the extract call. */
export function selectedPaths(forest: TreeNode[], rootId: string, selected: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    if (n.file && selected.has(n.id)) out.push(n.file.path);
    n.children.forEach(walk);
  };
  const root = forest.find((r) => r.id === rootId);
  if (root) walk(root);
  return out;
}
