// Reader for Markdown and text (kinds notes, claude-memory, claude-instructions and projects-md).
// The text is returned unchanged, so that a line number of a locator is a line number of the file. Front matter,
// wiki links and headings are returned as hints beside it.

export interface Heading {
  /** 1 based line number */
  line: number;
  level: number;
  text: string;
}

export interface NoteRead {
  text: string;
  lineCount: number;
  headings: Heading[];
  frontMatter: Record<string, string> | null;
  wikiLinks: string[];
}

export const splitLines = (text: string): string[] => text.split(/\r\n|\n|\r/);

/** A NUL byte in the first 8,192 bytes marks a binary file. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

export function decodeText(buf: Buffer): string {
  const text = buf.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseFrontMatter(lines: string[]): { data: Record<string, string>; end: number } | null {
  if (lines[0]?.trim() !== "---") return null;
  const data: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return { data, end: i + 1 };
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (m) data[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

export function parseNote(text: string): NoteRead {
  const lines = splitLines(text);
  const fm = parseFrontMatter(lines);
  const headings: Heading[] = [];
  let fence: string | null = null;
  for (let i = fm ? fm.end : 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) headings.push({ line: i + 1, level: h[1].length, text: h[2] });
  }
  const links = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]\n|#]+)(?:[#|][^\]\n]*)?\]\]/g)) links.add(m[1].trim());
  return { text, lineCount: lines.length, headings, frontMatter: fm?.data ?? null, wikiLinks: [...links] };
}

/** The nearest heading at or before a line, or null. */
export function headingAt(headings: Heading[], line: number): string | null {
  let found: string | null = null;
  for (const h of headings) {
    if (h.line > line) break;
    found = h.text;
  }
  return found;
}
