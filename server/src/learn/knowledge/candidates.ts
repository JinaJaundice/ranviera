// Lexical candidate search for the auditor. BM25 with k1 1.2 and b 0.75 over the
// name and statement of each proposition and each of its aliases, after about
// 65 English function words are removed. The score only ranks and never decides
// identity. docs/CONTRACTS.md, "Limits", and brief 02 section 2.10.

import { randomBytes } from "node:crypto";
import { badRequest } from "./errors.ts";
import type { MergedNode } from "./ledger.ts";

export const K1 = 1.2;
export const B = 0.75;
export const PAGE_SIZE = 5;

/** Function words only. Negations and domain words stay, because they change a meaning. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a an and are as at be been but by can could did do " +
    "does for from had has have he her his how if in into is " +
    "it its may might must of on or she should so than that the " +
    "their them then there these they this those to was we were what when " +
    "where which who why will with would you"
  ).split(" "),
);

/** NFKC, lower case, letters and digits only, with the function words removed. */
export function tokenize(text: string): string[] {
  const words = text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return words.filter((w) => w !== "" && !STOP_WORDS.has(w));
}

export interface CandidateQuery {
  name: string;
  statement: string;
  aliases?: string[];
  hints?: string[];
}

export interface Candidate {
  id: string;
  name: string;
  statement: string;
  /** only an alias whose own words matched */
  matchedAliases: string[];
  /** the distinct chat ids of its provenance */
  sessions: string[];
  score: number;
}

export interface CandidatePage {
  candidates: Candidate[];
  offset: number;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
}

interface Doc {
  node: number;
  /** the alias this text was made from, or null for name plus statement */
  alias: string | null;
  terms: Map<string, number>;
  length: number;
}

export class CandidateIndex {
  private readonly nodes: MergedNode[];
  private readonly docs: Doc[] = [];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  constructor(nodes: MergedNode[]) {
    this.nodes = nodes;
    const perNodeTerms: Set<string>[] = nodes.map(() => new Set<string>());
    nodes.forEach((n, i) => {
      const texts: { alias: string | null; text: string }[] = [{ alias: null, text: `${n.name} ${n.statement}` }];
      const seen = new Set<string>();
      for (const a of n.aliases) {
        if (a === n.statement || seen.has(a)) continue;
        seen.add(a);
        texts.push({ alias: a, text: `${n.name} ${a}` });
      }
      for (const t of texts) {
        const tokens = tokenize(t.text);
        const terms = new Map<string, number>();
        for (const w of tokens) {
          terms.set(w, (terms.get(w) ?? 0) + 1);
          perNodeTerms[i].add(w);
        }
        this.docs.push({ node: i, alias: t.alias, terms, length: tokens.length });
      }
    });
    // document frequency counts nodes, never aliases
    for (const set of perNodeTerms) for (const w of set) this.df.set(w, (this.df.get(w) ?? 0) + 1);
    this.avgLength = this.docs.length ? this.docs.reduce((s, d) => s + d.length, 0) / this.docs.length : 0;
  }

  private idf(term: string): number {
    const n = this.nodes.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  private score(doc: Doc, terms: Set<string>): number {
    let s = 0;
    for (const t of terms) {
      const tf = doc.terms.get(t);
      if (!tf) continue;
      const norm = 1 - B + B * (this.avgLength > 0 ? doc.length / this.avgLength : 1);
      s += (this.idf(t) * tf * (K1 + 1)) / (tf + K1 * norm);
    }
    return s;
  }

  /** Every node with a positive score, best first, ties by id. The best text of a node wins. */
  rank(query: CandidateQuery, excludeIds: ReadonlySet<string> = new Set()): Candidate[] {
    const terms = new Set<string>(
      tokenize([query.name, query.statement, ...(query.aliases ?? []), ...(query.hints ?? [])].join(" ")),
    );
    const best = new Map<number, number>();
    for (const d of this.docs) {
      const s = this.score(d, terms);
      if (s > (best.get(d.node) ?? 0)) best.set(d.node, s);
    }
    const out: Candidate[] = [];
    for (const [i, score] of best) {
      const n = this.nodes[i];
      if (excludeIds.has(n.id)) continue;
      const matchedAliases = n.aliases.filter((a) => tokenize(a).some((w) => terms.has(w)));
      out.push({
        id: n.id,
        name: n.name,
        statement: n.statement,
        matchedAliases,
        sessions: [...new Set(n.provenance.map((p) => p.chatId))],
        score,
      });
    }
    return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  page(query: CandidateQuery, offset = 0, excludeIds?: ReadonlySet<string>): CandidatePage {
    if (!Number.isInteger(offset) || offset < 0) throw badRequest("The offset must be a whole number of zero or more.");
    const all = this.rank(query, excludeIds);
    const candidates = all.slice(offset, offset + PAGE_SIZE);
    const next = offset + candidates.length;
    return { candidates, offset, total: all.length, hasMore: next < all.length, nextOffset: next < all.length ? next : null };
  }
}

/**
 * Opaque cursors for one audit. A cursor fixes its query, so hints cannot be
 * combined with it, and an unknown cursor is refused.
 */
export class CursorBook {
  private readonly held = new Map<string, { query: CandidateQuery; offset: number; exclude: ReadonlySet<string> }>();

  private readonly index: CandidateIndex;

  constructor(index: CandidateIndex) {
    this.index = index;
  }

  first(query: CandidateQuery, exclude: ReadonlySet<string> = new Set()): { page: CandidatePage; nextCursor: string | null } {
    const page = this.index.page(query, 0, exclude);
    return { page, nextCursor: this.issue(query, page, exclude) };
  }

  next(cursor: string): { page: CandidatePage; nextCursor: string | null } {
    const h = this.held.get(cursor);
    if (!h) throw badRequest("The cursor is not known. Ask for the candidates again with the proposition identifiers.");
    const page = this.index.page(h.query, h.offset, h.exclude);
    return { page, nextCursor: this.issue(h.query, page, h.exclude) };
  }

  private issue(query: CandidateQuery, page: CandidatePage, exclude: ReadonlySet<string>): string | null {
    if (page.nextOffset === null) return null;
    const token = randomBytes(9).toString("base64url");
    this.held.set(token, { query, offset: page.nextOffset, exclude });
    return token;
  }
}
