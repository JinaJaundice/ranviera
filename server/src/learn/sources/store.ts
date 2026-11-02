// File helpers of the sources area. JSON is tab indented and written through a temporary file and a rename, and
// JSON Lines files are appended one object to a line with LF (docs/CONTRACTS.md, "Conventions").
import fs from "node:fs";
import path from "node:path";

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, "\t") + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function appendJsonLines(file: string, lines: unknown[]): void {
  if (!lines.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l) + "\n").join(""), "utf8");
}

/** A strict read: a line with bad JSON or the wrong shape is skipped and never repaired. */
export function readJsonLines<T>(file: string, guard: (v: unknown) => v is T): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (guard(v)) out.push(v);
    } catch {
      // a torn append is skipped
    }
  }
  return out;
}

export function rewriteJsonLines(file: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, lines.map((l) => JSON.stringify(l) + "\n").join(""), "utf8");
  fs.renameSync(tmp, file);
}

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
