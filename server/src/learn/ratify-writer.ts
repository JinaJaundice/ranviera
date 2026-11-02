// Writes the assertions of one ratified or rejected claim for POST /api/learn/graph/ratify (docs/CONTRACTS.md, "Routes",
// route 50). The assertions go to <profile_dir>/assertions/knowledge.json, which the compiler reads with the other
// assertion files, so a ratified edge of the claim takes the provenance ratified and a rejected edge leaves the graph.
import fs from "node:fs";
import path from "node:path";
import type { GraphFile } from "../../../shared/types.ts";
import type { RatifyClaim } from "../../../shared/learn/knowledge.ts";

interface AssertionRow {
  s: string;
  r: string;
  t: string;
  status: "ratified" | "rejected";
  by: string;
  date: string;
  reason?: string;
}

/** The file that holds the assertions of ratified and rejected claims. */
export const knowledgeAssertionsFile = (profileDir: string): string => path.join(profileDir, "assertions", "knowledge.json");

function readRows(file: string): AssertionRow[] {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { assertions?: unknown };
    return Array.isArray(data.assertions) ? (data.assertions as AssertionRow[]) : [];
  } catch {
    return [];
  }
}

/**
 * Records the claim's extracted edges as assertions with the status asked for, replacing any earlier row for the same
 * edge, and returns the number of edges written. A claim with no extracted edge in the built graph writes nothing.
 */
export function writeClaimAssertions(
  graph: GraphFile | null,
  profileDir: string,
  claim: RatifyClaim,
  by: string,
  today: string,
): number {
  if (!graph) return 0;
  const edges = graph.edges.filter((e) => e.provenance === "extracted" && (e.s === claim.claim || e.t === claim.claim));
  if (edges.length === 0) return 0;
  const file = knowledgeAssertionsFile(profileDir);
  const key = (r: { s: string; r: string; t: string }) => `${r.s}\u0000${r.r}\u0000${r.t}`;
  const fresh = new Map(edges.map((e) => [key(e), e]));
  const rows = readRows(file).filter((r) => !fresh.has(key(r)));
  for (const e of edges) {
    const row: AssertionRow = { s: e.s, r: e.r, t: e.t, status: claim.status, by, date: today };
    if (claim.status === "rejected" && claim.reason) row.reason = claim.reason;
    rows.push(row);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ assertions: rows }, null, "\t") + "\n", "utf8");
  fs.renameSync(tmp, file);
  return edges.length;
}
