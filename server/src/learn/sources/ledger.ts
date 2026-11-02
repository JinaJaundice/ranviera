// The default writer of the graph ledgers that the sources area touches: graph/sources.json (one record for each file of a root)
// and, for a learnharness root, the proposition and argument ledgers. The knowledge core of Phase 2 may inject a writer of its own.
import fs from "node:fs";
import path from "node:path";
import type { ChainLine, NodeLine, SourceRecord } from "../../../../shared/learn/knowledge.ts";
import { SourceError } from "./errors.ts";
import { appendJsonLines, isObject, readJsonLines, writeJsonAtomic } from "./store.ts";

export type LedgerKind = "nodes" | "chains" | "sources";

/** Appends lines to a ledger. A "sources" call upserts records by id and keeps the extraction usage of an existing record. */
export type AppendLedger = (kind: LedgerKind, lines: unknown[]) => void | Promise<void>;

export interface SeenLines {
  nodes: Set<string>;
  chains: Set<string>;
}

const FORMAT_SUPPORTED = 1;

function checkFormat(graphDir: string, create: boolean): void {
  const file = path.join(graphDir, "format.json");
  let version = 1;
  let exists = false;
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    exists = true;
    if (isObject(v) && typeof v.version === "number") version = v.version;
  } catch {
    // an absent or unreadable stamp means version 1
  }
  if (version > FORMAT_SUPPORTED) {
    throw new SourceError(503, "format_newer", "The learning data was written by a newer build. Update this app before changing it.", { found: version, supported: FORMAT_SUPPORTED });
  }
  if (create && !exists) writeJsonAtomic(file, { version: FORMAT_SUPPORTED });
}

export const nodeLineKey = (n: NodeLine): string => JSON.stringify([n.id, n.createdAt, n.statement, n.aliases, n.provenance.map((p) => [p.chatId, p.messageId])]);
export const chainLineKey = (c: ChainLine): string => JSON.stringify([c.id, c.createdAt, c.premises, c.conclusion, c.provenance.map((p) => [p.chatId, p.messageId])]);

const isNode = (v: unknown): v is NodeLine => isObject(v) && typeof v.id === "string" && typeof v.statement === "string" && Array.isArray(v.aliases) && Array.isArray(v.provenance) && typeof v.createdAt === "string";
const isChain = (v: unknown): v is ChainLine => isObject(v) && typeof v.id === "string" && Array.isArray(v.premises) && typeof v.conclusion === "string" && Array.isArray(v.provenance) && typeof v.createdAt === "string";

export function createFileLedger(learnDir: string): { append: AppendLedger; seen: () => SeenLines } {
  const graph = path.join(learnDir, "graph");
  const append: AppendLedger = (kind, lines) => {
    if (!lines.length) return;
    checkFormat(graph, true);
    if (kind === "sources") {
      const file = path.join(graph, "sources.json");
      let cur: Record<string, SourceRecord> = {};
      try {
        const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (isObject(v)) cur = v as Record<string, SourceRecord>;
      } catch {
        // an absent file starts empty
      }
      let changed = false;
      for (const r of lines as SourceRecord[]) {
        const old = cur[r.id];
        const next: SourceRecord = { ...r, ...(old?.extractions ? { extractions: old.extractions } : {}) };
        if (!old || old.filePath !== next.filePath || old.importedAt !== next.importedAt) {
          cur[r.id] = next;
          changed = true;
        }
      }
      if (changed) writeJsonAtomic(file, cur);
      return;
    }
    appendJsonLines(path.join(graph, kind === "nodes" ? "nodes.jsonl" : "chains.jsonl"), lines);
  };
  const seen = (): SeenLines => ({
    nodes: new Set(readJsonLines(path.join(graph, "nodes.jsonl"), isNode).map(nodeLineKey)),
    chains: new Set(readJsonLines(path.join(graph, "chains.jsonl"), isChain).map(chainLineKey)),
  });
  return { append, seen };
}
