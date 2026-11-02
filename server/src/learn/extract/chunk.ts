// Chunking. A file is cut into chunks of at most the chunk budget, and the messages of a transcript or a learning
// session are grouped into batches of whole messages (docs/CONTRACTS.md, "Limits"). The token estimate is the number
// of characters divided by 4, rounded up. A line is never split and a message is never split.
import { createHash } from "node:crypto";
import type { CoverageLine } from "../../../../shared/learn/knowledge.ts";
import type { LearnSettings } from "../../../../shared/learn/models.ts";
import { batches, estimateTokens, uncoveredMessages, type VisibleMessage } from "../knowledge/coverage.ts";
import { CHUNK_DEFAULT, CHUNK_FLOOR } from "../models/settings.ts";
import { splitLines } from "../sources/readers/notes.ts";

/** The budget of settings graph.extractionChunkTokens. A missing or bad value is the default, and a low one is the floor. */
export function chunkBudget(settings?: Pick<LearnSettings, "graph">): number {
  const v = settings?.graph?.extractionChunkTokens;
  if (typeof v !== "number" || !Number.isFinite(v)) return CHUNK_DEFAULT;
  return Math.max(CHUNK_FLOOR, Math.round(v));
}

/** A run of consecutive lines that the extractor reads together. Line numbers are 1 based and inclusive. */
export interface Segment {
  firstLine: number;
  lines: string[];
}

export interface FileChunk {
  /** 1 based part number */
  part: number;
  of: number;
  segment: Segment;
  /** the text of the chunk, the lines joined by a newline */
  text: string;
  /** what the extractor reads: a header with the file label and the part, then the text word for word */
  view: string;
}

/** The lines of a text as the passage route counts them: a final empty line from a closing newline is dropped. */
export function linesOf(text: string): string[] {
  const lines = splitLines(text);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Greedy cut by line. A line joins the current chunk unless that would pass the budget and the chunk is not empty.
 * A line that is over the budget on its own forms a chunk of its own. A text with no visible character gives no chunk.
 */
export function chunkFile(label: string, text: string, budget: number): FileChunk[] {
  if (text.trim() === "") return [];
  const lines = linesOf(text);
  const groups: Segment[] = [];
  let current: string[] = [];
  let first = 1;
  let chars = 0;
  lines.forEach((line, i) => {
    const add = line.length + 1;
    if (current.length > 0 && estimateTokens(chars + add) > budget) {
      groups.push({ firstLine: first, lines: current });
      current = [];
      first = i + 1;
      chars = 0;
    }
    current.push(line);
    chars += add;
  });
  if (current.length > 0) groups.push({ firstLine: first, lines: current });
  return groups.map((segment, i) => {
    const body = segment.lines.join("\n");
    const header = groups.length > 1 ? `File: ${label} (part ${i + 1} of ${groups.length})` : `File: ${label}`;
    return { part: i + 1, of: groups.length, segment, text: body, view: `${header}\n\n${body}` };
  });
}

export interface MessageBatch {
  messages: VisibleMessage[];
  /** a deterministic 12 character hex tag that depends on the members and their order */
  tag: string;
  tokens: number;
  /** the message ids, which are the anchors that the extractor may use */
  ids: string[];
  view: string;
}

/** The tag of a batch: the first 12 hex characters of the hash of the fingerprints in order. */
export function batchTag(messages: VisibleMessage[]): string {
  return createHash("sha256").update(messages.map((m) => m.fp).join("\n")).digest("hex").slice(0, 12);
}

/** Batches of the oldest uncovered messages, filled greedily to the budget. A covered message is left out. */
export function messageBatches(view: VisibleMessage[], covered: Pick<CoverageLine, "fp">[], budget: number): MessageBatch[] {
  return batches(uncoveredMessages(view, covered), budget).map((messages) => ({
    messages,
    tag: batchTag(messages),
    tokens: messages.reduce((n, m) => n + m.tokens, 0),
    ids: messages.map((m) => m.messageId),
    view: messages.map((m) => m.lines.join("\n")).join("\n\n"),
  }));
}

/** The first line of each message in the full view of a transcript, where messages are joined by a blank line. */
export function messageStartLines(texts: string[]): number[] {
  const out: number[] = [];
  let line = 1;
  for (const t of texts) {
    out.push(line);
    line += t.split(/\r\n|\n|\r/).length + 1;
  }
  return out;
}
