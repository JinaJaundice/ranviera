import { describe, expect, it } from "vitest";
import { makePdf, proseLines } from "../testkit.ts";
import { MAX_PDF_PAGES, PDF_NOTICE, convertPdf, inspectPdf } from "./pdf.ts";

const prose = ["The first line of the body text runs across the page.", "A second line follows it in the same paragraph.", "A third line closes the paragraph of body text."];

describe("convertPdf", () => {
  it("marks each text page and turns a larger line into a heading", async () => {
    const pdf = makePdf([proseLines(prose, { title: "Chapter one" }), proseLines(prose)]);
    const r = await convertPdf(pdf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages).toBe(2);
    expect(r.markdown).toContain("--- Page 1 ---\n\n# Chapter one");
    expect(r.markdown).toContain("--- Page 2 ---");
    expect(r.markdown).toContain("The first line of the body text runs across the page.\nA second line follows it");
    expect(r.notice).toBe(PDF_NOTICE);
  });

  it("keeps words apart and escapes a body line that begins with a hash", async () => {
    const pdf = makePdf([
      {
        texts: [
          { x: 72, y: 700, size: 12, text: "# not a heading but a body line" },
          { x: 72, y: 684, size: 12, text: "Words stay separate on a line." },
        ],
      },
    ]);
    const r = await convertPdf(pdf);
    expect(r.ok && r.markdown).toContain("\\# not a heading but a body line");
    expect(r.ok && r.markdown).toContain("Words stay separate on a line.");
  });

  it("reads bullets with their depth", async () => {
    const pdf = makePdf([
      {
        texts: [
          { x: 72, y: 700, size: 12, text: "Intro line of body text that is long enough." },
          { x: 72, y: 676, size: 12, text: "- first point" },
          { x: 96, y: 660, size: 12, text: "- nested point" },
          { x: 72, y: 644, size: 12, text: "- second point" },
        ],
      },
    ]);
    const r = await convertPdf(pdf);
    expect(r.ok && r.markdown).toContain("- first point\n  - nested point\n- second point");
  });

  it("skips pages that hold only an image, counts them and says so in the notice", async () => {
    const pdf = makePdf([proseLines(prose), { image: true }, { image: true }, { texts: [] }]);
    const r = await convertPdf(pdf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages).toBe(4);
    expect(r.textPages).toBe(1);
    expect(r.imagePages).toBe(2);
    expect(r.markdown).not.toContain("--- Page 2 ---");
    expect(r.notice).toContain("2 pages hold only images and were skipped because OCR is not supported.");
  });

  it("refuses a PDF with no text and reports its image pages", async () => {
    const r = await convertPdf(makePdf([{ image: true }]));
    expect(r).toMatchObject({ ok: false, reason: "no_text", imagePages: 1 });
  });

  it("refuses a PDF over the page cap from the page count, before any page is read", async () => {
    const pages = Array.from({ length: MAX_PDF_PAGES + 1 }, () => ({ texts: [] }));
    const pdf = makePdf(pages);
    const head = await inspectPdf(pdf);
    expect(head).toMatchObject({ ok: false, reason: "too_long", pages: MAX_PDF_PAGES + 1 });
    const r = await convertPdf(pdf);
    expect(r).toMatchObject({ ok: false, reason: "too_long" });
  });

  it("accepts exactly the page cap", async () => {
    const head = await inspectPdf(makePdf(Array.from({ length: MAX_PDF_PAGES }, () => ({ texts: [] }))));
    expect(head).toEqual({ ok: true, pages: MAX_PDF_PAGES });
  });

  it("refuses garbage and a truncated file as unreadable", async () => {
    expect(await inspectPdf(Buffer.from("not a pdf at all"))).toMatchObject({ ok: false, reason: "unreadable" });
    const pdf = makePdf([proseLines(prose)]);
    expect(await convertPdf(pdf.subarray(0, 40))).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("reads the left column before the right on a page of two prose columns", async () => {
    const texts = [] as { x: number; y: number; size: number; text: string }[];
    for (let i = 0; i < 12; i++) {
      texts.push({ x: 60, y: 700 - i * 16, size: 11, text: `left column sentence number ${i} of the prose` });
      texts.push({ x: 330, y: 700 - i * 16, size: 11, text: `right column sentence number ${i} of the prose` });
    }
    const r = await convertPdf(makePdf([{ texts }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.markdown.indexOf("left column sentence number 11")).toBeLessThan(r.markdown.indexOf("right column sentence number 0"));
  });
});
