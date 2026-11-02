// Reader for PDF files: a conversion by rules to page marked Markdown, with no model and no OCR. It uses the legacy build of
// pdfjs-dist in Node. The page cap is checked from the page count before any page is read. The conversion keeps the raw lines,
// including repeated headers and footers, and leaves interpretation to the model.
import { createRequire } from "node:module";
import path from "node:path";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfDoc = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;

export const MAX_PDF_PAGES = 1000;
export const PDF_NOTICE = "This text was converted from a PDF by rules, and scanned text may contain errors.";

let lib: Promise<PdfJs> | null = null;
const load = (): Promise<PdfJs> => (lib ??= import("pdfjs-dist/legacy/build/pdf.mjs"));
const fontDir = path.join(path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts").split(path.sep).join("/") + "/";

export type PdfRefusal = { ok: false; reason: "unreadable" | "too_long" | "no_text"; message: string; pages?: number; imagePages?: number };

interface Opened {
  doc: PdfDoc;
  close: () => Promise<void>;
}

async function open(bytes: Uint8Array): Promise<Opened | PdfRefusal> {
  const pdfjs = await load();
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes), standardFontDataUrl: fontDir, verbosity: 0, useSystemFonts: false });
  try {
    return { doc: await task.promise, close: () => task.destroy() };
  } catch {
    await task.destroy().catch(() => undefined);
    return { ok: false, reason: "unreadable", message: "The PDF could not be opened. It may be broken or encrypted." };
  }
}

const isRefusal = (v: Opened | PdfRefusal): v is PdfRefusal => "ok" in v;

/** The page count of a PDF, or the refusal that applies before any page is read. */
export async function inspectPdf(bytes: Uint8Array, maxPages = MAX_PDF_PAGES): Promise<{ ok: true; pages: number } | PdfRefusal> {
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") {
    return { ok: false, reason: "unreadable", message: "The file is not a PDF." };
  }
  const opened = await open(bytes);
  if (isRefusal(opened)) return opened;
  const pages = opened.doc.numPages;
  await opened.close();
  if (pages > maxPages) return { ok: false, reason: "too_long", message: `The PDF has ${pages} pages and the limit is ${maxPages}.`, pages };
  if (pages === 0) return { ok: false, reason: "no_text", message: "The PDF has no pages.", pages };
  return { ok: true, pages };
}

interface Item {
  str: string;
  x0: number;
  x1: number;
  y: number;
  size: number;
  rotated: boolean;
  rtl: boolean;
}

interface Line {
  items: Item[];
  raw: string;
  text: string;
  x: number;
  y: number;
  size: number;
  rotated: boolean;
}

const LIGATURES = new RegExp("[\\uFB00-\\uFB06\\uFB50-\\uFDFF\\uFE70-\\uFEFE]", "g");
// eslint-disable-next-line no-control-regex
const NOISE = /[-\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s: string) => s.replace(LIGATURES, (c) => c.normalize("NFKC")).replace(NOISE, "").replace(/\s+/g, " ").trim();

function makeLine(items: Item[]): Line {
  const ordered = items.every((i) => i.rtl) && items.length > 1 ? [...items].sort((a, b) => b.x0 - a.x0) : items;
  let raw = "";
  ordered.forEach((it, i) => {
    if (i > 0) {
      const prev = ordered[i - 1];
      const gap = it.x0 - prev.x1;
      const back = prev.x1 - it.x0 > 2 * it.size;
      if ((gap > 0.25 * it.size || back) && !/\s$/.test(raw) && !/^\s/.test(it.str)) raw += " ";
    }
    raw += it.str;
  });
  const chars = new Map<number, number>();
  for (const it of ordered) chars.set(it.size, (chars.get(it.size) ?? 0) + it.str.length);
  const size = [...chars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  return { items: ordered, raw, text: clean(raw), x: Math.min(...ordered.map((i) => i.x0)), y: ordered[0].y, size, rotated: ordered.every((i) => i.rotated) };
}

interface RawItem {
  str: string;
  dir?: string;
  transform: number[];
  width: number;
  hasEOL?: boolean;
}

function buildLines(raw: RawItem[]): Line[] {
  const groups: Item[][] = [];
  let cur: Item[] = [];
  const flush = () => {
    if (cur.length) groups.push(cur);
    cur = [];
  };
  for (const r of raw) {
    // pdfjs reports the space between two runs as an item of its own, and the gap is read from the positions instead.
    if (r.str.trim() === "") {
      if (r.hasEOL) flush();
      continue;
    }
    const [a, b, , d, e, f] = r.transform;
    const size = Math.hypot(a, b) || Math.abs(d);
    const rotated = Math.abs(b) > Math.abs(a) * 0.5;
    const item: Item = { str: r.str, x0: e, x1: e + r.width, y: f, size: Math.round(size * 10) / 10, rotated, rtl: r.dir === "rtl" };
    const last = cur[cur.length - 1];
    if (last && !rotated && !last.rotated && Math.abs(item.y - last.y) > 0.5 * Math.max(item.size, last.size)) flush();
    cur.push(item);
    if (r.hasEOL) flush();
  }
  flush();
  return groups.map(makeLine).filter((l) => l.text);
}

const cellGap = (it: Item) => Math.max(it.size, 6);

function hasCellGaps(l: Line): boolean {
  const s = [...l.items].sort((a, b) => a.x0 - b.x0);
  return s.some((it, i) => i > 0 && it.x0 - s[i - 1].x1 >= cellGap(it));
}

function readsAsProse(lines: Line[]): boolean {
  if (!lines.length) return false;
  if (lines.filter(hasCellGaps).length / lines.length >= 0.3) return false;
  const lens = lines.map((l) => l.text.length).sort((a, b) => a - b);
  if (lens[Math.floor(lens.length / 2)] < 15) return false;
  const words = lines.flatMap((l) => l.text.split(" "));
  return words.filter((w) => /[a-z]/.test(w)).length * 2 >= words.length;
}

/** Splits a page of two columns, left column first, only where both halves read as prose. */
function splitColumns(lines: Line[], depth = 0): Line[] {
  if (depth > 2 || lines.length < 10) return lines;
  const gaps: { line: number; a: number; b: number }[] = [];
  lines.forEach((l, li) => {
    const s = [...l.items].sort((x, y) => x.x0 - y.x0);
    s.forEach((it, i) => {
      if (i > 0 && it.x0 - s[i - 1].x1 >= cellGap(it)) gaps.push({ line: li, a: s[i - 1].x1, b: it.x0 });
    });
  });
  let best: { a: number; b: number; count: number } | null = null;
  for (const g of gaps) {
    const m = (g.a + g.b) / 2;
    const hit = new Map<number, { a: number; b: number }>();
    for (const o of gaps) if (o.a <= m && o.b >= m && !hit.has(o.line)) hit.set(o.line, o);
    if (hit.size >= 5 && (!best || hit.size > best.count)) {
      const all = [...hit.values()];
      best = { a: Math.max(...all.map((x) => x.a)), b: Math.min(...all.map((x) => x.b)), count: hit.size };
    }
  }
  if (!best) return lines;
  const { a, b } = best;
  if (lines.some((l) => l.items.some((it) => it.x0 < b - 0.5 && it.x1 > a + 0.5))) return lines;
  const left: Line[] = [];
  const right: Line[] = [];
  for (const l of lines) {
    const li = l.items.filter((it) => it.x1 <= a + 0.5);
    const ri = l.items.filter((it) => it.x0 >= b - 0.5);
    if (li.length) left.push(makeLine(li));
    if (ri.length) right.push(makeLine(ri));
  }
  if (!readsAsProse(left) || !readsAsProse(right)) return lines;
  return [...splitColumns(left, depth + 1), ...splitColumns(right, depth + 1)];
}

const BULLET_GLYPH = /^[•‣◦▪●■⁃--]\s*/;
const BULLET_DASH = /^[-–—]\s+/;

function bulletText(raw: string): string | null {
  const t = raw.trimStart();
  const m = BULLET_GLYPH.exec(t) ?? BULLET_DASH.exec(t);
  return m ? clean(t.slice(m[0].length)) : null;
}

// Smallest ratio of a line size to the body size for heading levels 1 and 2. Smaller headings are level 3.
const HEADING_RATIOS = [1.6, 1.3];

const letterShare = (s: string) => {
  const nonSpace = s.replace(/\s/g, "");
  return nonSpace ? (nonSpace.match(/\p{L}/gu) ?? []).length / nonSpace.length : 0;
};

const escapeHash = (s: string) => (s.startsWith("#") ? `\\${s}` : s);

function pageMarkdown(all: Line[]): string {
  if (!all.length) return "";
  const lines = splitColumns(all);
  const upright = lines.filter((l) => !l.rotated);
  const maxSize = Math.max(...lines.map((l) => l.size));
  const pool = upright.filter((l) => l.size < maxSize);
  const counted = pool.length ? pool : upright;
  const tally = new Map<number, number>();
  for (const l of counted) tally.set(l.size, (tally.get(l.size) ?? 0) + l.text.length);
  const body = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? maxSize;

  type Block = { kind: "heading" | "bullets" | "para"; lines: string[]; size: number; lastY: number; lastX: number };
  const blocks: Block[] = [];
  let stack: number[] = [];
  let lastBulletY = Infinity;
  let last: Block | null = null;
  for (const l of lines) {
    const bullet = l.rotated ? null : bulletText(l.raw);
    const heading = !l.rotated && bullet === null && l.size - body >= 1.95 && letterShare(l.text) >= 0.5 && l.text.length <= 150;
    if (heading) {
      const ratio = l.size / body;
      const level = HEADING_RATIOS.findIndex((min) => ratio >= min) + 1 || 3;
      if (last && last.kind === "heading" && last.size === l.size) {
        last.lines[0] += ` ${l.text}`;
      } else {
        last = { kind: "heading", lines: [`${"#".repeat(level)} ${l.text}`], size: l.size, lastY: l.y, lastX: l.x };
        blocks.push(last);
      }
      stack = [];
      continue;
    }
    if (bullet !== null) {
      const tol = 0.3 * l.size;
      if (l.y > lastBulletY) stack = [];
      if (!stack.length) stack.push(l.x);
      else if (l.x > stack[stack.length - 1] + tol) stack.push(l.x);
      else {
        while (stack.length > 1 && l.x < stack[stack.length - 1] - tol) stack.pop();
        if (l.x < stack[0] - tol) stack = [l.x];
      }
      lastBulletY = l.y;
      const item = `${"  ".repeat(stack.length - 1)}- ${escapeHash(bullet)}`;
      if (last && last.kind === "bullets") {
        last.lines.push(item);
        last.lastY = l.y;
        last.lastX = l.x;
      } else {
        last = { kind: "bullets", lines: [item], size: l.size, lastY: l.y, lastX: l.x };
        blocks.push(last);
      }
      continue;
    }
    if (last && last.kind === "bullets" && l.x >= last.lastX + 0.3 * l.size && last.lastY - l.y < 1.6 * l.size) {
      last.lines[last.lines.length - 1] += ` ${l.text}`;
      last.lastY = l.y;
      continue;
    }
    if (last && last.kind === "para" && Math.abs(last.size - l.size) <= 1 && last.lastY - l.y < 1.6 * l.size && last.lastY - l.y > -0.5 * l.size) {
      last.lines.push(escapeHash(l.text));
      last.lastY = l.y;
      continue;
    }
    last = { kind: "para", lines: [escapeHash(l.text)], size: l.size, lastY: l.y, lastX: l.x };
    blocks.push(last);
    stack = [];
  }
  return blocks
    .map((b) => b.lines.join("\n"))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n");
}

export type PdfConversion = { ok: true; markdown: string; pages: number; textPages: number; imagePages: number; notice: string } | PdfRefusal;

/** Converts a PDF to Markdown with a `--- Page N ---` marker before each page that has text. */
export async function convertPdf(bytes: Uint8Array, opts: { maxPages?: number } = {}): Promise<PdfConversion> {
  const maxPages = opts.maxPages ?? MAX_PDF_PAGES;
  const head = await inspectPdf(bytes, maxPages);
  if (!head.ok) return head;
  const pdfjs = await load();
  const opened = await open(bytes);
  if (isRefusal(opened)) return opened;
  const { doc } = opened;
  const imageOps = new Set<number>(
    ["paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject", "paintImageXObjectRepeat", "paintInlineImageXObjectGroup", "paintImageMaskXObjectGroup", "paintImageMaskXObjectRepeat", "paintSolidColorImageMask"]
      .map((n) => (pdfjs.OPS as Record<string, number>)[n])
      .filter((n): n is number => typeof n === "number"),
  );
  const sections: string[] = [];
  let imagePages = 0;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const raw = content.items.filter((i): i is typeof i & RawItem => "str" in i) as unknown as RawItem[];
      const lines = buildLines(raw);
      if (lines.length) {
        const md = pageMarkdown(lines);
        if (md.trim()) sections.push(`--- Page ${n} ---\n\n${md}`);
      } else {
        // The operator list costs time, so it is built only for a page that has no text.
        const ops = await page.getOperatorList();
        if (ops.fnArray.some((f: number) => imageOps.has(f))) imagePages++;
      }
      page.cleanup();
    }
  } finally {
    await opened.close();
  }
  if (!sections.length) {
    return { ok: false, reason: "no_text", message: "The PDF has no text and OCR is not supported yet.", pages: head.pages, imagePages };
  }
  const skipped = imagePages
    ? ` ${imagePages} ${imagePages === 1 ? "page holds" : "pages hold"} only images and ${imagePages === 1 ? "was" : "were"} skipped because OCR is not supported.`
    : "";
  return { ok: true, markdown: sections.join("\n\n"), pages: head.pages, textPages: sections.length, imagePages, notice: PDF_NOTICE + skipped };
}
