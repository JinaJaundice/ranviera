// PDF operations for the researcher and the PDF reader: the triage of every page, the text of chosen pages, a literal
// search and the rendering of pages to PNG. They use the legacy build of pdfjs-dist in Node and paint pages with
// @napi-rs/canvas, so no browser is involved. A page cap of 1,000 is checked from the page count before any page is
// read. Every function returns data or a sentence, and none of them throws for a damaged file.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { canonicalPng } from "../../images/png.ts";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfDoc = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;
type PdfPage = Awaited<ReturnType<PdfDoc["getPage"]>>;

export const PDF_MAX_PAGES = 1000;
export const PDF_MAX_BYTES = 25 * 1024 * 1024;
export const EXTRACT_MAX_CHARS = 24_000;
export const RENDER_MAX_PAGES = 6;
export const RENDER_DEFAULT_DPI = 150;
export const SEARCH_MAX_HITS = 40;
export const SEARCH_MAX_CONTEXT = 8;
export const CANVAS_MAX_PIXELS = 16_000_000;
export const CANVAS_MAX_SIDE = 8192;
const INFO_ROW_LIMIT = 200;
export const FLAGGED_LIMIT = 30;

let lib: Promise<PdfJs> | null = null;
const load = (): Promise<PdfJs> => (lib ??= import("pdfjs-dist/legacy/build/pdf.mjs"));
const fontDir = path.join(path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts").split(path.sep).join("/") + "/";

export class PdfFault extends Error {}

/** Reads a PDF file into memory after the size and signature checks. */
export function readPdfFile(file: string): Uint8Array {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new PdfFault(`No file exists at ${path.basename(file)}.`);
  }
  if (!stat.isFile()) throw new PdfFault("That path is not a file.");
  if (stat.size > PDF_MAX_BYTES) throw new PdfFault("The PDF is larger than 25 MiB.");
  const bytes = new Uint8Array(fs.readFileSync(file));
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") throw new PdfFault("The file is not a PDF.");
  return bytes;
}

/** Opens a PDF, runs a step and always releases the document. */
export async function withPdf<T>(file: string, step: (doc: PdfDoc, pdfjs: PdfJs) => Promise<T>): Promise<T> {
  const bytes = readPdfFile(file);
  const pdfjs = await load();
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes), standardFontDataUrl: fontDir, verbosity: 0, useSystemFonts: false });
  let doc: PdfDoc;
  try {
    doc = await task.promise;
  } catch {
    await task.destroy().catch(() => undefined);
    throw new PdfFault("The PDF could not be opened. It may be broken or encrypted.");
  }
  try {
    if (doc.numPages > PDF_MAX_PAGES) throw new PdfFault(`The PDF has ${doc.numPages} pages and the limit is ${PDF_MAX_PAGES}.`);
    return await step(doc, pdfjs);
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/** The text of a page as lines. */
async function linesOf(page: PdfPage): Promise<string[]> {
  const content = await page.getTextContent();
  const lines: string[] = [];
  let line = "";
  let lastY: number | null = null;
  let lastSize = 0;
  for (const raw of content.items) {
    const item = raw as { str?: string; transform?: number[]; hasEOL?: boolean };
    if (typeof item.str !== "string" || !item.transform) continue;
    const y = item.transform[5];
    const size = Math.hypot(item.transform[0], item.transform[1]) || 1;
    if (lastY !== null && Math.abs(y - lastY) > 0.5 * Math.max(size, lastSize)) {
      if (line.trim()) lines.push(line.trim());
      line = "";
    }
    line += item.str;
    lastY = y;
    lastSize = size;
    if (item.hasEOL) {
      if (line.trim()) lines.push(line.trim());
      line = "";
      lastY = null;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

const MATH = /[∑∫√±≤≥≈≠∞∂∇×÷∈∉⊂⊆∪∩∀∃→⇒⇔αβγδεζηθλμπρσφψω=^]/g;

export interface PageTriage {
  page: number;
  chars: number;
  images: number;
  math: number;
  kind: "text" | "picture only" | "blank";
}

export interface PdfSummary {
  pages: number;
  sizeClass: "short" | "medium" | "long";
  meanChars: number;
  rows: PageTriage[];
  flagged: number[];
}

/** The page count, the size class and a row for each page. */
export async function triage(file: string): Promise<PdfSummary> {
  return withPdf(file, async (doc, pdfjs) => {
    const imageOps = new Set<number>(
      ["paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject", "paintImageXObjectRepeat", "paintImageMaskXObjectRepeat", "paintImageMaskXObjectGroup", "paintJpegXObject"]
        .map((n) => (pdfjs.OPS as Record<string, number>)[n])
        .filter((n) => typeof n === "number"),
    );
    const rows: PageTriage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const text = (await linesOf(page)).join(" ");
      const ops = await page.getOperatorList();
      const images = ops.fnArray.filter((f: number) => imageOps.has(f)).length;
      const chars = text.replace(/\s+/g, "").length;
      const math = chars ? (text.match(MATH)?.length ?? 0) / chars : 0;
      rows.push({ page: n, chars, images, math: Math.round(math * 1000) / 1000, kind: chars >= 20 ? "text" : images > 0 ? "picture only" : "blank" });
      page.cleanup();
    }
    const pages = rows.length;
    const flagged = rows.filter((r) => r.math >= 0.03 || r.images > 0).map((r) => r.page).slice(0, FLAGGED_LIMIT);
    return {
      pages,
      sizeClass: pages <= 10 ? "short" : pages <= 40 ? "medium" : "long",
      meanChars: pages ? Math.round(rows.reduce((s, r) => s + r.chars, 0) / pages) : 0,
      rows,
      flagged,
    };
  });
}

export function infoText(name: string, s: PdfSummary): string {
  const lines = [
    `${name}: ${s.pages} pages (${s.sizeClass}), a mean of ${s.meanChars} characters of text for each page.`,
    "Page, characters, images, maths density, class:",
    ...s.rows.slice(0, INFO_ROW_LIMIT).map((r) => `${r.page}, ${r.chars}, ${r.images}, ${r.math.toFixed(3)}, ${r.kind}`),
  ];
  if (s.rows.length > INFO_ROW_LIMIT) lines.push(`[Only the first ${INFO_ROW_LIMIT} pages are listed.]`);
  lines.push(s.flagged.length ? `Pages with images or a maths density of 0.03 or more: ${s.flagged.join(", ")}.` : "No page holds images or dense maths.");
  return lines.join("\n");
}

/** Reads "all", "3", "1-5" or "1,3,7" and joins them. Pages outside the document are left out and counted. */
export function parsePageSpec(spec: string, count: number): { pages: number[]; ignored: number } | { error: string } {
  const text = String(spec ?? "").trim().toLowerCase();
  if (!text) return { error: 'Give the pages as "all", one number, a range such as 1-5, or a list such as 1,3,7.' };
  if (text === "all") return { pages: Array.from({ length: count }, (_, i) => i + 1), ignored: 0 };
  const wanted = new Set<number>();
  let ignored = 0;
  for (const part of text.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) return { error: `"${part.trim()}" is not a page or a range. Use "all", 3, 1-5 or 1,3,7.` };
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (to < from) return { error: `The range ${from}-${to} runs backwards.` };
    for (let p = from; p <= Math.min(to, from + PDF_MAX_PAGES); p++) {
      if (p >= 1 && p <= count) wanted.add(p);
      else ignored += 1;
    }
  }
  return { pages: [...wanted].sort((a, b) => a - b), ignored };
}

export interface Extract {
  text: string;
  /** the pages whose text is in the answer, in whole or in part */
  pages: number[];
}

export async function extractPages(file: string, spec: string, maxChars = EXTRACT_MAX_CHARS): Promise<Extract | { error: string }> {
  return withPdf(file, async (doc) => {
    const parsed = parsePageSpec(spec, doc.numPages);
    if ("error" in parsed) return parsed;
    if (!parsed.pages.length) return { error: `No page of that selection exists. The document has ${doc.numPages} pages.` };
    let out = "";
    const included: number[] = [];
    let omitted: number[] = [];
    for (const [i, n] of parsed.pages.entries()) {
      const page = await doc.getPage(n);
      const lines = await linesOf(page);
      page.cleanup();
      const block = `[Page ${n}]\n${lines.length ? lines.join("\n") : "(no text on this page)"}\n\n`;
      if (out.length + block.length > maxChars) {
        const room = maxChars - out.length;
        if (room > 200 && !included.length) {
          out += block.slice(0, room);
          included.push(n);
          omitted = parsed.pages.slice(i + 1);
        } else omitted = parsed.pages.slice(i);
        break;
      }
      out += block;
      included.push(n);
    }
    const note = omitted.length
      ? `[Output cut at ${maxChars.toLocaleString("en-GB")} characters. ${omitted.length} further page${omitted.length === 1 ? "" : "s"} (from page ${omitted[0]}) were not returned. Ask for them with a narrower selection.]`
      : parsed.ignored
        ? `[${parsed.ignored} selected page number${parsed.ignored === 1 ? " lies" : "s lie"} outside the document and ${parsed.ignored === 1 ? "was" : "were"} skipped.]`
        : "";
    return { text: `${out.trimEnd()}${note ? `\n\n${note}` : ""}`, pages: included };
  });
}

export interface Search {
  text: string;
  /** the pages that hold a hit */
  pages: number[];
  hits: number;
}

/** A case insensitive literal search. Context is the number of lines on each side, 0 to 8. */
export async function searchPdf(file: string, query: string, context = 2, maxHits = SEARCH_MAX_HITS): Promise<Search | { error: string }> {
  const needle = query.trim().toLowerCase();
  if (!needle) return { error: "Give the words to search for." };
  const around = Math.max(0, Math.min(SEARCH_MAX_CONTEXT, Math.floor(context)));
  return withPdf(file, async (doc) => {
    const blocks: string[] = [];
    const pages: number[] = [];
    let hits = 0;
    let more = false;
    for (let n = 1; n <= doc.numPages && !more; n++) {
      const page = await doc.getPage(n);
      const lines = await linesOf(page);
      page.cleanup();
      for (const [i, line] of lines.entries()) {
        if (!line.toLowerCase().includes(needle)) continue;
        if (hits >= maxHits) {
          more = true;
          break;
        }
        hits += 1;
        if (!pages.includes(n)) pages.push(n);
        const from = Math.max(0, i - around);
        const to = Math.min(lines.length - 1, i + around);
        blocks.push(`p. ${n}, line ${i + 1}:\n${lines.slice(from, to + 1).join("\n")}`);
      }
    }
    if (!hits) return { text: `No page contains "${query.trim()}". Try other words, or a shorter phrase.`, pages, hits };
    const tail = more ? `\n\n[Only the first ${maxHits} hits are shown.]` : "";
    return { text: `${hits} hit${hits === 1 ? "" : "s"} for "${query.trim()}" on page${pages.length === 1 ? "" : "s"} ${pages.join(", ")}.\n\n${blocks.join("\n\n")}${tail}`, pages, hits };
  });
}

/**
 * The scale of a render. It starts at dpi over 72, never lets a side pass 8,192 pixels or the area pass 16 million,
 * and only ever shrinks. Rounding up can break a limit, so a final search finds a scale that holds.
 */
export function renderScale(width: number, height: number, dpi: number, maxPixels = CANVAS_MAX_PIXELS, maxSide = CANVAS_MAX_SIDE): number {
  if (!Number.isFinite(dpi) || dpi <= 0 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new PdfFault("The page size or the resolution is not valid.");
  }
  let scale = Math.min(dpi / 72, maxSide / width, maxSide / height);
  const ok = (s: number) => Math.ceil(width * s) <= maxSide && Math.ceil(height * s) <= maxSide && Math.ceil(width * s) * Math.ceil(height * s) <= maxPixels;
  if (width * scale * height * scale > maxPixels) scale *= Math.sqrt(maxPixels / (width * scale * height * scale));
  if (!ok(scale)) {
    let lo = 0;
    let hi = scale;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
    scale = lo;
  }
  return scale;
}

export interface Rendered {
  page: number;
  png: Uint8Array;
}

export async function renderPages(file: string, pages: number[], dpi = RENDER_DEFAULT_DPI): Promise<{ rendered: Rendered[]; skipped: number[] } | { error: string }> {
  if (!Number.isFinite(dpi) || dpi < 72 || dpi > 300) return { error: "The resolution must be between 72 and 300 dpi." };
  const canvasLib = await import("@napi-rs/canvas");
  return withPdf(file, async (doc) => {
    const rendered: Rendered[] = [];
    const skipped: number[] = [];
    for (const n of pages.slice(0, RENDER_MAX_PAGES)) {
      if (n < 1 || n > doc.numPages) {
        skipped.push(n);
        continue;
      }
      const page = await doc.getPage(n);
      try {
        // the rotation is part of the viewport, so the size is bounded before any canvas exists
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: renderScale(base.width, base.height, dpi) });
        const canvas = canvasLib.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx as never, canvas: canvas as never, viewport }).promise;
        rendered.push({ page: n, png: canonicalPng(new Uint8Array(canvas.toBuffer("image/png"))) });
      } catch {
        skipped.push(n);
      } finally {
        page.cleanup();
      }
    }
    return { rendered, skipped };
  });
}
