// Reader for a LearnHarness data folder (format version 1). The folder is opened for reading only. Each LearnHarness session and
// each imported file becomes one source record, and the proposition and argument lines are returned with their provenance
// mapped to the new src_ ids. A later scan returns only the lines that the ledgers have not seen.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChainLine, NodeLine, ProvenancePoint, SourceRecord } from "../../../../../shared/learn/knowledge.ts";
import { chainLineKey, nodeLineKey, type AppendLedger, type SeenLines } from "../ledger.ts";
import { isObject, readJsonLines } from "../store.ts";

export interface LearnHarnessImport {
  sources: SourceRecord[];
  nodes: NodeLine[];
  chains: ChainLine[];
}

/** The id of a source file: `src_` and the first 12 hex characters of the SHA-256 of `<root id>/<relative path>`. */
export const deriveSourceId = (rootId: string, rel: string, salt = ""): string =>
  `src_${crypto.createHash("sha256").update(`${rootId}/${rel}${salt}`).digest("hex").slice(0, 12)}`;

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const isPoints = (v: unknown): v is ProvenancePoint[] => Array.isArray(v) && v.every((p) => isObject(p) && typeof p.chatId === "string" && typeof p.messageId === "string");
const isNode = (v: unknown): v is NodeLine =>
  isObject(v) && typeof v.id === "string" && typeof v.name === "string" && typeof v.statement === "string" && strings(v.aliases) && typeof v.createdAt === "string" && isPoints(v.provenance);
const isChain = (v: unknown): v is ChainLine =>
  isObject(v) && typeof v.id === "string" && strings(v.premises) && v.premises.length > 0 && typeof v.conclusion === "string" && typeof v.createdAt === "string" && isPoints(v.provenance);

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export interface LearnHarnessOptions {
  folder: string;
  rootId: string;
  /** the label of the root, used in the file path label of each source record */
  label: string;
  /** the source id that a scan gave to a relative path, when it has one */
  idFor?: (rel: string) => string | undefined;
  /** receives the source records, the proposition lines and the argument lines, in that order */
  appendLedger: AppendLedger;
  /** keys of the lines that the ledgers already hold, so that a repeat scan appends nothing */
  seen?: () => SeenLines;
  now?: () => Date;
}

/** Reads the folder, writes the new lines through appendLedger and returns what was written. */
export async function importLearnHarness(opts: LearnHarnessOptions): Promise<LearnHarnessImport> {
  const now = opts.now ?? (() => new Date());
  const idFor = (rel: string) => opts.idFor?.(rel) ?? deriveSourceId(opts.rootId, rel);
  const map = new Map<string, string>();
  const sources: SourceRecord[] = [];

  const chatsDir = path.join(opts.folder, "chats");
  let chatFiles: string[] = [];
  try {
    chatFiles = fs.readdirSync(chatsDir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    // a folder with no chats is valid
  }
  for (const f of chatFiles) {
    const rec = readJson(path.join(chatsDir, f));
    if (!isObject(rec) || typeof rec.id !== "string") continue;
    const rel = `chats/${f}`;
    const id = idFor(rel);
    map.set(rec.id, id);
    sources.push({ id, filePath: `${opts.label}/${rel}`, importedAt: typeof rec.createdAt === "string" ? rec.createdAt : now().toISOString() });
  }
  const own = readJson(path.join(opts.folder, "graph", "sources.json"));
  if (isObject(own)) {
    for (const [oldId, r] of Object.entries(own)) {
      if (!isObject(r) || typeof r.filePath !== "string") continue;
      const id = deriveSourceId(opts.rootId, `sources/${oldId}`);
      map.set(oldId, id);
      sources.push({ id, filePath: `${opts.label}/${r.filePath}`, importedAt: typeof r.importedAt === "string" ? r.importedAt : now().toISOString() });
    }
  }

  const remap = (points: ProvenancePoint[]): ProvenancePoint[] =>
    points.map((p) => ({ chatId: map.get(p.chatId) ?? deriveSourceId(opts.rootId, `sources/${p.chatId}`), messageId: p.messageId }));
  const seen = opts.seen?.() ?? { nodes: new Set<string>(), chains: new Set<string>() };

  const nodes: NodeLine[] = [];
  for (const n of readJsonLines(path.join(opts.folder, "graph", "nodes.jsonl"), isNode)) {
    const line: NodeLine = { id: n.id, name: n.name, statement: n.statement, aliases: n.aliases, createdAt: n.createdAt, provenance: remap(n.provenance) };
    const key = nodeLineKey(line);
    if (seen.nodes.has(key)) continue;
    seen.nodes.add(key);
    nodes.push(line);
  }
  const chains: ChainLine[] = [];
  for (const c of readJsonLines(path.join(opts.folder, "graph", "chains.jsonl"), isChain)) {
    const line: ChainLine = { id: c.id, premises: c.premises, conclusion: c.conclusion, createdAt: c.createdAt, provenance: remap(c.provenance) };
    const key = chainLineKey(line);
    if (seen.chains.has(key)) continue;
    seen.chains.add(key);
    chains.push(line);
  }

  await opts.appendLedger("sources", sources);
  await opts.appendLedger("nodes", nodes);
  await opts.appendLedger("chains", chains);
  return { sources, nodes, chains };
}
