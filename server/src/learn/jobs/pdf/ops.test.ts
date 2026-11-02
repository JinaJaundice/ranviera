// Tests of the PDF operations on PDFs that the test builds. No file outside a temporary folder is read.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makePdf, proseLines, tmpDir, write } from "../../sources/testkit.ts";
import { CANVAS_MAX_PIXELS, CANVAS_MAX_SIDE, extractPages, infoText, parsePageSpec, renderPages, renderScale, searchPdf, triage } from "./ops.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function sample(): string {
  const dir = tmpDir("jobs-pdf-");
  dirs.push(dir);
  const pdf = makePdf([
    proseLines(["Alpha beta gamma delta epsilon.", "The reserve ratio rose in 2024.", "A further line of ordinary text."], { title: "First page" }),
    { image: true },
    proseLines(["The reserve ratio fell in 2025.", "Closing remarks follow here."]),
    {},
  ]);
  return write(dir, "sample.pdf", pdf);
}

const widthOf = (png: Uint8Array) => Buffer.from(png).readUInt32BE(16);

describe("triage", () => {
  it("classes each page as text, picture only or blank and flags the picture", async () => {
    const s = await triage(sample());
    expect(s.pages).toBe(4);
    expect(s.sizeClass).toBe("short");
    expect(s.rows.map((r) => r.kind)).toEqual(["text", "picture only", "text", "blank"]);
    expect(s.flagged).toEqual([2]);
    expect(infoText("sample.pdf", s)).toContain("4 pages (short)");
  });
});

describe("page selection", () => {
  it("reads all, a number, a range and a list, and counts pages outside the document", () => {
    expect(parsePageSpec("all", 3)).toEqual({ pages: [1, 2, 3], ignored: 0 });
    expect(parsePageSpec("2", 3)).toEqual({ pages: [2], ignored: 0 });
    expect(parsePageSpec("1-2, 3", 5)).toEqual({ pages: [1, 2, 3], ignored: 0 });
    expect(parsePageSpec("1,3,9", 5)).toEqual({ pages: [1, 3], ignored: 1 });
    expect(parsePageSpec("x", 5)).toHaveProperty("error");
    expect(parsePageSpec("5-2", 5)).toHaveProperty("error");
  });
});

describe("extract and search", () => {
  it("returns the text of chosen pages with page markers", async () => {
    const r = await extractPages(sample(), "1,3");
    expect(r).toHaveProperty("pages", [1, 3]);
    const text = "text" in r ? r.text : "";
    expect(text).toContain("[Page 1]");
    expect(text).toContain("reserve ratio rose in 2024");
    expect(text).toContain("[Page 3]");
    expect(text).not.toContain("[Page 2]");
  });

  it("cuts the output at the limit on a page and says which pages were left out", async () => {
    const r = await extractPages(sample(), "all", 120);
    const text = "text" in r ? r.text : "";
    expect(text).toContain("Output cut at 120 characters");
    expect(text).toContain("were not returned");
    expect("pages" in r ? r.pages.length : 99).toBeLessThan(4);
  });

  it("finds a literal in any case, with context lines and the pages of the hits", async () => {
    const r = await searchPdf(sample(), "RESERVE RATIO", 1);
    expect(r).toMatchObject({ hits: 2, pages: [1, 3] });
    expect("text" in r && r.text).toContain("p. 1, line 3");
    const none = await searchPdf(sample(), "zebra", 0);
    expect("text" in none && none.text).toContain("No page contains");
    const limited = await searchPdf(sample(), "the", 0, 1);
    expect("text" in limited && limited.text).toContain("Only the first 1 hits");
  });
});

describe("render", () => {
  it("paints pages to PNG, doubles the size at 144 dpi, and skips pages outside the document", async () => {
    const file = sample();
    const a = await renderPages(file, [1, 9], 72);
    const b = await renderPages(file, [1], 144);
    if ("error" in a || "error" in b) throw new Error("render failed");
    expect(a.skipped).toEqual([9]);
    expect(a.rendered).toHaveLength(1);
    expect(Buffer.from(a.rendered[0].png).subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(widthOf(a.rendered[0].png)).toBe(612);
    expect(widthOf(b.rendered[0].png)).toBe(1224);
  });

  it("renders at most 6 pages and refuses a resolution outside 72 to 300", async () => {
    const file = sample();
    expect(await renderPages(file, [1], 50)).toHaveProperty("error");
    expect(await renderPages(file, [1], 301)).toHaveProperty("error");
    const many = await renderPages(file, [1, 2, 3, 4, 1, 2, 3], 72);
    if ("error" in many) throw new Error("render failed");
    expect(many.rendered).toHaveLength(6);
  });

  it("bounds the scale before a canvas exists", () => {
    expect(renderScale(612, 792, 150)).toBeCloseTo(150 / 72, 6);
    const huge = renderScale(14400, 14400, 300);
    expect(Math.ceil(14400 * huge)).toBeLessThanOrEqual(CANVAS_MAX_SIDE);
    expect(Math.ceil(14400 * huge) ** 2).toBeLessThanOrEqual(CANVAS_MAX_PIXELS);
    const strip = renderScale(200000, 20, 300);
    expect(Math.ceil(200000 * strip)).toBeLessThanOrEqual(CANVAS_MAX_SIDE);
    expect(() => renderScale(612, 792, 0)).toThrow();
    expect(() => renderScale(0, 792, 150)).toThrow();
  });
});

describe("damaged files", () => {
  it("answers a damaged or missing file with a fault and not a crash", async () => {
    const dir = tmpDir("jobs-pdf-bad-");
    dirs.push(dir);
    const bad = write(dir, "bad.pdf", "%PDF-1.4\nnot really a pdf");
    await expect(triage(bad)).rejects.toThrow(/could not be opened/);
    const text = write(dir, "note.pdf", "plain text");
    await expect(triage(text)).rejects.toThrow(/not a PDF/);
    await expect(triage(path.join(dir, "missing.pdf"))).rejects.toThrow(/No file/);
  });
});
