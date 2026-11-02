// The model of the chain table: sources, then arguments, then the statements. The chain of a source is the argument whose
// first provenance point is that source. Everything here is pure.
import type { GraphSnapshot, PropositionView } from "@shared/learn/knowledge";
import { fuzzyScore } from "../../lib/learn/fuzzy";
import type { NavRow } from "../../lib/learn/nav";

export interface ChainEntry {
  id: string;
  sourceId: string;
  premises: PropositionView[];
  conclusion: PropositionView;
  /** the distinct statements, premises first */
  statements: PropositionView[];
  createdAt: string;
  /** "A ∧ B ⟹ C" in the names of the claims */
  symbols: string;
  /** "A and B imply C", for assistive technology */
  spoken: string;
}

export interface SourceEntry {
  id: string;
  label: string;
  kind: "session" | "file" | "unknown";
  chains: ChainEntry[];
  /** distinct statements across the chains */
  propositions: number;
  createdAt: string;
}

export type SortKey = "name" | "propositions" | "created";
export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

export const DEFAULT_SORT: Sort = { key: "propositions", dir: "desc" };
export const UNKNOWN_SOURCE = "Source not recorded";

export function symbolLine(premises: string[], conclusion: string): string {
  return premises.length ? `${premises.join(" ∧ ")} ⟹ ${conclusion}` : conclusion;
}

export function spokenLine(premises: string[], conclusion: string): string {
  if (!premises.length) return conclusion;
  const list = premises.length === 1 ? premises[0] : `${premises.slice(0, -1).join(", ")} and ${premises[premises.length - 1]}`;
  return `${list} ${premises.length === 1 ? "implies" : "imply"} ${conclusion}`;
}

export function buildChainTable(snap: GraphSnapshot): SourceEntry[] {
  const props = new Map(snap.propositions.map((p) => [p.id, p]));
  const bySource = new Map<string, ChainEntry[]>();
  for (const c of snap.chains) {
    const conclusion = props.get(c.conclusion);
    const premises = c.premises.map((p) => props.get(p)).filter((p): p is PropositionView => !!p);
    if (!conclusion || premises.length !== c.premises.length) continue;
    const sourceId = c.provenance[0]?.chatId ?? "";
    const names = premises.map((p) => p.name);
    const seen = new Set<string>();
    const statements = [...premises, conclusion].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
    const entry: ChainEntry = { id: c.id, sourceId, premises, conclusion, statements, createdAt: c.createdAt, symbols: symbolLine(names, conclusion.name), spoken: spokenLine(names, conclusion.name) };
    const list = bySource.get(sourceId);
    if (list) list.push(entry);
    else bySource.set(sourceId, [entry]);
  }
  const out: SourceEntry[] = [];
  for (const [id, chains] of bySource) {
    const session = snap.sessions[id];
    const file = snap.fileSources[id];
    const label = session ?? file ?? UNKNOWN_SOURCE;
    const distinct = new Set(chains.flatMap((c) => c.statements.map((s) => s.id)));
    const created = chains.reduce((a, c) => (c.createdAt > a ? c.createdAt : a), "");
    out.push({ id, label, kind: session ? "session" : file ? "file" : "unknown", chains, propositions: distinct.size, createdAt: created });
  }
  return out;
}

function compare(key: SortKey, dir: Sort["dir"]) {
  const sign = dir === "asc" ? 1 : -1;
  return <T extends { name: string; propositions: number; created: string; unnamed?: boolean }>(a: T, b: T): number => {
    let r: number;
    if (key === "name") {
      // an unlabelled source sorts last whatever the direction
      if (a.unnamed !== b.unnamed) return a.unnamed ? 1 : -1;
      r = a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });
    } else if (key === "propositions") r = a.propositions - b.propositions;
    else r = a.created < b.created ? -1 : a.created > b.created ? 1 : 0;
    if (r !== 0) return r * sign;
    return a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });
  };
}

export function sortSources(rows: SourceEntry[], sort: Sort): SourceEntry[] {
  const cmp = compare(sort.key, sort.dir);
  const view = (s: SourceEntry) => ({ name: s.label, propositions: s.propositions, created: s.createdAt, unnamed: s.kind === "unknown" });
  return [...rows]
    .map((s) => ({ ...s, chains: sortChains(s.chains, sort) }))
    .sort((a, b) => cmp(view(a), view(b)));
}

export function sortChains(rows: ChainEntry[], sort: Sort): ChainEntry[] {
  const cmp = compare(sort.key, sort.dir);
  const view = (c: ChainEntry) => ({ name: c.symbols, propositions: c.statements.length, created: c.createdAt });
  return [...rows].sort((a, b) => cmp(view(a), view(b)));
}

export function chainFields(c: ChainEntry): string[] {
  return c.statements.flatMap((s) => [s.name, s.statement, ...s.aliases]);
}

/** Filters by a fuzzy query over names, aliases and statements. A source whose own name matches keeps all its chains. */
export function filterSources(rows: SourceEntry[], query: string): SourceEntry[] {
  if (!query.trim()) return rows;
  const out: SourceEntry[] = [];
  for (const s of rows) {
    if (fuzzyScore(query, [s.label]) !== null) {
      out.push(s);
      continue;
    }
    const chains = s.chains.filter((c) => fuzzyScore(query, chainFields(c)) !== null);
    if (chains.length) out.push({ ...s, chains });
  }
  return out;
}

export interface TableRow extends NavRow {
  level: 1 | 2 | 3;
  source?: SourceEntry;
  chain?: ChainEntry;
  statement?: PropositionView;
}

/**
 * The rows on show. Without a query a row is open only when its id is in `opened`. With a query every source that matched
 * opens by itself unless the reader closed it (the ids in `closed`), and the chains stay closed unless opened.
 */
export function visibleRows(rows: SourceEntry[], opened: ReadonlySet<string>, closed: ReadonlySet<string>, searching: boolean): TableRow[] {
  const out: TableRow[] = [];
  for (const s of rows) {
    const open = s.chains.length > 0 && (searching ? !closed.has(s.id) : opened.has(s.id));
    out.push({ id: s.id, parentId: null, hasChildren: s.chains.length > 0, open, level: 1, source: s });
    if (!open) continue;
    for (const c of s.chains) {
      const key = `${s.id}/${c.id}`;
      const copen = opened.has(key);
      out.push({ id: key, parentId: s.id, hasChildren: true, open: copen, level: 2, source: s, chain: c });
      if (!copen) continue;
      for (const st of c.statements) out.push({ id: `${key}/${st.id}`, parentId: key, hasChildren: false, open: false, level: 3, source: s, chain: c, statement: st });
    }
  }
  return out;
}

export function tableCounts(snap: GraphSnapshot): { chains: number; claims: number } {
  return { chains: snap.chains.length, claims: snap.propositions.length };
}

/** The claims that match a query, for the side search of the layer. Returns the ids best first. */
export function searchClaims(snap: GraphSnapshot, query: string, limit = 8): string[] {
  if (!query.trim()) return [];
  const scored: { id: string; s: number }[] = [];
  for (const p of snap.propositions) {
    const s = fuzzyScore(query, [p.name, p.statement, ...p.aliases]);
    if (s !== null) scored.push({ id: p.id, s });
  }
  scored.sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1));
  return scored.slice(0, limit).map((x) => x.id);
}
