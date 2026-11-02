// Helpers for the tests of the sources area: temporary folders, a small PDF writer and a symlink probe.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tmpDir(prefix = "cortex-sources-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix)).replace(/\\/g, "/");
}

export function write(root: string, rel: string, content: string | Buffer): string {
  const abs = path.posix.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** Makes a directory link or a file link. Returns false where the system does not allow it, so that a test can skip. */
export function trySymlink(target: string, link: string, kind: "dir" | "file"): boolean {
  try {
    fs.symlinkSync(target, link, kind === "dir" ? "junction" : "file");
    return true;
  } catch {
    return false;
  }
}

export interface PdfText {
  x: number;
  y: number;
  size: number;
  text: string;
}
export interface PdfPage {
  texts?: PdfText[];
  /** paints one image and no text */
  image?: boolean;
}

const esc = (s: string) => s.replace(/[\\()]/g, "\\$&");

/** Writes a small valid PDF with Helvetica text and an optional one pixel image on each page. */
export function makePdf(pages: PdfPage[]): Buffer {
  const objs: string[] = [];
  const add = (body: string) => {
    objs.push(body);
    return objs.length;
  };
  const catalog = add("");
  const tree = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const image = add("<< /Subtype /Image /Type /XObject /Height 1 /Width 1 /BitsPerComponent 8 /ColorSpace /DeviceGray /Length 1 >>\nstream\n\u0080\nendstream");
  const kids: number[] = [];
  for (const p of pages) {
    let content = "";
    for (const t of p.texts ?? []) content += `BT /F1 ${t.size} Tf ${t.x} ${t.y} Td (${esc(t.text)}) Tj ET\n`;
    if (p.image) content += "q 100 0 0 100 50 50 cm /Im0 Do Q\n";
    const c = add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
    kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im0 ${image} 0 R >> >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objs[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  const count = objs.length + 1;
  const entries = offsets.map((pos) => `${String(pos).padStart(10, "0")} 00000 n \n`);
  out += `xref\n0 ${count}\n0000000000 65535 f \n`;
  out += entries.join("");
  out += `trailer\n<< /Root ${catalog} 0 R /Size ${count} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A page of body text: a title at 24 points above lines of 12 point prose, one line each 16 points down. */
export function proseLines(lines: string[], opts: { title?: string } = {}): PdfPage {
  const texts: PdfText[] = [];
  let y = 740;
  if (opts.title) {
    texts.push({ x: 72, y, size: 24, text: opts.title });
    y -= 40;
  }
  for (const line of lines) {
    texts.push({ x: 72, y, size: 12, text: line });
    y -= 16;
  }
  return { texts };
}
