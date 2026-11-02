// The state of each file under a root: cortex/files.jsonl, where the newest line for a source id wins, and the coverage
// of transcripts, which the knowledge core keeps in graph/coverage.jsonl.
import fs from "node:fs";
import path from "node:path";
import type { CoverageLine } from "../../../../shared/learn/knowledge.ts";
import type { FileRecord } from "../../../../shared/learn/sources.ts";
import { estimateTokens, transcriptFingerprint, type TranscriptMessage } from "./readers/claude-transcripts.ts";
import { appendJsonLines, isObject, readJsonLines, rewriteJsonLines } from "./store.ts";

const STATES = ["pending", "current", "missing", "refused"];

export const isFileRecord = (v: unknown): v is FileRecord =>
  isObject(v) &&
  typeof v.sourceId === "string" &&
  typeof v.rootId === "string" &&
  typeof v.path === "string" &&
  typeof v.sha256 === "string" &&
  typeof v.state === "string" &&
  STATES.includes(v.state);

/** A source keeps at most this many lines before the file is rewritten to the newest line of each source. */
export const MAX_LINES_PER_SOURCE = 5;

export interface FileStore {
  /** the newest record of each source id */
  all(): Map<string, FileRecord>;
  forRoot(rootId: string): FileRecord[];
  append(records: FileRecord[]): void;
  /** removes every record of a root, writes them to archiveFile first and returns them */
  removeRoot(rootId: string, archiveFile: string): FileRecord[];
}

export function createFileStore(file: string): FileStore {
  const lines = () => readJsonLines(file, isFileRecord);
  const newest = (ls: FileRecord[]) => {
    const m = new Map<string, FileRecord>();
    for (const r of ls) m.set(r.sourceId, r);
    return m;
  };
  return {
    all: () => newest(lines()),
    forRoot: (rootId) => [...newest(lines()).values()].filter((r) => r.rootId === rootId).sort((a, b) => a.path.localeCompare(b.path)),
    append(records) {
      appendJsonLines(file, records);
      const ls = lines();
      const m = newest(ls);
      if (ls.length > MAX_LINES_PER_SOURCE * m.size) rewriteJsonLines(file, [...m.values()]);
    },
    removeRoot(rootId, archiveFile) {
      const ls = lines();
      const removed = [...newest(ls).values()].filter((r) => r.rootId === rootId);
      if (!ls.some((r) => r.rootId === rootId)) return removed;
      fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
      appendJsonLines(archiveFile, ls.filter((r) => r.rootId === rootId));
      rewriteJsonLines(file, [...newest(ls.filter((r) => r.rootId !== rootId)).values()]);
      return removed;
    },
  };
}

/** The uncovered tokens of a transcript, from the fingerprints that graph/coverage.jsonl holds for its source id. */
export type CoverageReader = (sourceId: string, messages: TranscriptMessage[]) => number;

const isCoverage = (v: unknown): v is CoverageLine => isObject(v) && typeof v.chatId === "string" && typeof v.fp === "string";

export function createCoverageReader(learnDir: string): CoverageReader {
  const file = path.join(learnDir, "graph", "coverage.jsonl");
  return (sourceId, messages) => {
    const covered = new Set(readJsonLines(file, isCoverage).filter((c) => c.chatId === sourceId).map((c) => c.fp));
    let tokens = 0;
    for (const m of messages) if (!covered.has(transcriptFingerprint(m))) tokens += estimateTokens(m.text.trim());
    return tokens;
  };
}
