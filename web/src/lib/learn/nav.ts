// Keyboard movement through a tree of visible rows, shared by the source tree and the chain table. The rows are the
// rows on show after filtering and sorting, so the keys never reach a row that the reader cannot see.

export interface NavRow {
  id: string;
  parentId: string | null;
  hasChildren: boolean;
  open: boolean;
}

export type NavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

export interface NavResult {
  focus: string | null;
  /** a row to open or close, when the key does that */
  toggle?: { id: string; open: boolean };
}

/** Focus starts at the first top level row when it is empty or points at a row that is no longer visible. */
export function ensureFocus(rows: NavRow[], focus: string | null): string | null {
  if (focus && rows.some((r) => r.id === focus)) return focus;
  return rows.find((r) => r.parentId === null)?.id ?? rows[0]?.id ?? null;
}

/**
 * Up and Down move among siblings, so that an open row is passed over with its descendants, and they stop at the first
 * and last sibling. Right opens a closed row or enters the first child of an open one, and does nothing on a leaf. Left
 * closes an open row, and from any other row it returns to the parent and closes it.
 */
export function moveFocus(rows: NavRow[], focus: string | null, key: NavKey): NavResult {
  const at = ensureFocus(rows, focus);
  const row = rows.find((r) => r.id === at);
  if (!row) return { focus: null };
  if (key === "ArrowUp" || key === "ArrowDown") {
    const siblings = rows.filter((r) => r.parentId === row.parentId);
    const i = siblings.findIndex((r) => r.id === row.id);
    const next = siblings[i + (key === "ArrowDown" ? 1 : -1)];
    return { focus: next ? next.id : row.id };
  }
  if (key === "ArrowRight") {
    if (!row.hasChildren) return { focus: row.id };
    if (!row.open) return { focus: row.id, toggle: { id: row.id, open: true } };
    const child = rows.find((r) => r.parentId === row.id);
    return { focus: child ? child.id : row.id };
  }
  if (row.hasChildren && row.open) return { focus: row.id, toggle: { id: row.id, open: false } };
  const parent = row.parentId ? rows.find((r) => r.id === row.parentId) : null;
  if (!parent) return { focus: row.id };
  return { focus: parent.id, toggle: { id: parent.id, open: false } };
}
