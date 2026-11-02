// Finds the quote of a proposition inside the chunk that the extractor read (docs/CONTRACTS.md, "Cortex extension
// files"). Runs of white space collapse to one space on both sides, case is kept, and the quote must lie inside the chunk.
import type { LocatorLine } from "../../../../shared/learn/sources.ts";
import type { SourceKind } from "../../../../shared/learn/sources.ts";
import { headingAt, parseNote, splitLines, type Heading } from "../sources/readers/notes.ts";
import { QUOTE_LIMIT } from "./types.ts";

export interface Located {
  found: boolean;
  /** 1 based and inclusive, null when the quote was not found */
  startLine: number | null;
  endLine: number | null;
}

const NOT_FOUND: Located = { found: false, startLine: null, endLine: null };
const BREAK = /\r\n|\n|\r/g;

/** The text with each run of white space replaced by one space, and the offset in the original text of each kept character. */
function collapseIndexed(text: string): { text: string; at: number[] } {
  const chars: string[] = [];
  const at: number[] = [];
  let i = 0;
  while (i < text.length && /\s/.test(text[i])) i++;
  let lastSpace = -1;
  for (; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (lastSpace < 0) lastSpace = i;
      continue;
    }
    if (lastSpace >= 0) {
      chars.push(" ");
      at.push(lastSpace);
      lastSpace = -1;
    }
    chars.push(text[i]);
    at.push(i);
  }
  return { text: chars.join(""), at };
}

const lineBreaks = (s: string): number => (s.match(BREAK) ?? []).length;

/**
 * Looks for the quote in the chunk. firstLine is the line of the whole text on which the chunk starts. A quote that is
 * empty, longer than the limit or absent from the chunk is not found.
 */
export function locateQuote(chunk: string, quote: string | undefined, firstLine: number): Located {
  if (!quote || quote.length > QUOTE_LIMIT) return NOT_FOUND;
  const q = collapseIndexed(quote).text;
  if (q === "") return NOT_FOUND;
  const hay = collapseIndexed(chunk);
  const hit = hay.text.indexOf(q);
  if (hit < 0) return NOT_FOUND;
  const start = hay.at[hit];
  const end = hay.at[hit + q.length - 1];
  return {
    found: true,
    startLine: firstLine + lineBreaks(chunk.slice(0, start)),
    endLine: firstLine + lineBreaks(chunk.slice(0, end)),
  };
}

const PAGE_MARK = /^--- Page (\d+) ---$/;

/** The context that turns a line number into a heading and a page. */
export interface LocatorContext {
  kind: SourceKind;
  headings: Heading[];
  /** lines of page markers, in order, for a PDF */
  pages: { line: number; page: number }[];
}

export function locatorContext(kind: SourceKind, fullText: string): LocatorContext {
  if (kind === "claude-transcripts") return { kind, headings: [], pages: [] };
  const headings = parseNote(fullText).headings;
  const pages: LocatorContext["pages"] = [];
  if (kind === "pdf") {
    splitLines(fullText).forEach((l, i) => {
      const m = PAGE_MARK.exec(l.trim());
      if (m) pages.push({ line: i + 1, page: Number(m[1]) });
    });
  }
  return { kind, headings, pages };
}

/** The locator line of one proposition and one source. */
export function locatorLine(
  nodeId: string,
  sourceId: string,
  fileSha256: string,
  quote: string | undefined,
  placed: Located,
  ctx: LocatorContext,
  at: string,
): LocatorLine {
  const page = placed.found && ctx.pages.length > 0 ? ([...ctx.pages].reverse().find((p) => p.line <= (placed.startLine as number))?.page ?? null) : null;
  return {
    nodeId,
    sourceId,
    fileSha256,
    startLine: placed.startLine,
    endLine: placed.endLine,
    page,
    heading: placed.found ? headingAt(ctx.headings, placed.startLine as number) : null,
    quote: (quote ?? "").slice(0, QUOTE_LIMIT),
    found: placed.found,
    at,
  };
}
