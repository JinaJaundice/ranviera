// One door to the readers: a check of a file at scan time and a read of its text for a passage or an extraction.
import crypto from "node:crypto";
import fs from "node:fs";
import type { SkipReason, SourceKind } from "../../../../../shared/learn/sources.ts";
import { MAX_PDF_PAGES, convertPdf, inspectPdf } from "./pdf.ts";
import { decodeText, looksBinary } from "./notes.ts";
import { readTranscript, type TranscriptMessage } from "./claude-transcripts.ts";

export interface Limits {
  /** a note or a PDF, 25 MiB */
  maxFileBytes: number;
  /** the prose of one transcript, 25 MiB */
  maxProseBytes: number;
  maxPdfPages: number;
  /** files in one root */
  maxFiles: number;
}

export const DEFAULT_LIMITS: Limits = { maxFileBytes: 25 * 1024 * 1024, maxProseBytes: 25 * 1024 * 1024, maxPdfPages: MAX_PDF_PAGES, maxFiles: 20_000 };

const sha256 = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");

export type Inspection =
  | { ok: true; sha256: string; bytes: number; pages?: number; messages?: TranscriptMessage[] }
  | { ok: false; reason: SkipReason; bytes: number };

/** Checks a file for a scan: the size, the type and the page count, and its hash. It makes no model call. */
export async function inspectFile(kind: SourceKind, abs: string, bytes: number, limits: Limits): Promise<Inspection> {
  try {
    if (kind === "claude-transcripts") {
      const t = await readTranscript(abs, { maxProseBytes: limits.maxProseBytes });
      if (t === "too_large") return { ok: false, reason: "too_large", bytes };
      if (!t.messages.length) return { ok: false, reason: "no_text", bytes };
      return { ok: true, sha256: t.sha256, bytes, messages: t.messages };
    }
    if (bytes > limits.maxFileBytes) return { ok: false, reason: "too_large", bytes };
    const buf = fs.readFileSync(abs);
    if (buf.length > limits.maxFileBytes) return { ok: false, reason: "too_large", bytes: buf.length };
    if (kind === "pdf") {
      const head = await inspectPdf(buf, limits.maxPdfPages);
      if (!head.ok) return { ok: false, reason: head.reason === "unreadable" && !buf.subarray(0, 5).equals(Buffer.from("%PDF-")) ? "unsupported" : head.reason, bytes: buf.length };
      return { ok: true, sha256: sha256(buf), bytes: buf.length, pages: head.pages };
    }
    if (kind === "learnharness") return { ok: true, sha256: sha256(buf), bytes: buf.length };
    if (looksBinary(buf)) return { ok: false, reason: "unreadable", bytes: buf.length };
    if (!decodeText(buf).trim()) return { ok: false, reason: "no_text", bytes: buf.length };
    return { ok: true, sha256: sha256(buf), bytes: buf.length };
  } catch {
    return { ok: false, reason: "unreadable", bytes };
  }
}

export type SourceText =
  | { ok: true; text: string; sha256: string; notice?: string; pages?: number; imagePages?: number; messages?: TranscriptMessage[] }
  | { ok: false; reason: SkipReason; message: string };

/** The text of a file as the extractor and a passage see it: the file itself, the converted PDF or the prose view of a transcript. */
export async function readSourceText(kind: SourceKind, abs: string, limits: Limits): Promise<SourceText> {
  try {
    if (kind === "claude-transcripts") {
      const t = await readTranscript(abs, { maxProseBytes: limits.maxProseBytes });
      if (t === "too_large") return { ok: false, reason: "too_large", message: "The prose of the transcript is over the limit." };
      return { ok: true, text: t.view, sha256: t.sha256, messages: t.messages };
    }
    const buf = fs.readFileSync(abs);
    if (buf.length > limits.maxFileBytes) return { ok: false, reason: "too_large", message: "The file is over the size limit." };
    if (kind === "pdf") {
      const c = await convertPdf(buf, { maxPages: limits.maxPdfPages });
      if (!c.ok) return { ok: false, reason: c.reason, message: c.message };
      return { ok: true, text: c.markdown, sha256: sha256(buf), notice: c.notice, pages: c.pages, imagePages: c.imagePages };
    }
    if (looksBinary(buf)) return { ok: false, reason: "unreadable", message: "The file is not text." };
    return { ok: true, text: decodeText(buf), sha256: sha256(buf) };
  } catch {
    return { ok: false, reason: "unreadable", message: "The file could not be read." };
  }
}
