// Format stamp of the graph folder. docs/CONTRACTS.md, "Format stamp and
// strict reads": an absent file means version 1, the first write of any graph
// file creates it, a read never writes it, and a newer stamp refuses every read.

import fs from "node:fs";
import path from "node:path";
import { KnowledgeError } from "./errors.ts";

export const FORMAT_VERSION = 1;

/** Reads the stamp. An absent, unreadable or malformed file reads as version 1. */
export function readFormatVersion(graphDir: string): number {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(graphDir, "format.json"), "utf8"));
    if (parsed && typeof parsed === "object") {
      const v = (parsed as { version?: unknown }).version;
      if (typeof v === "number" && Number.isFinite(v) && v >= 1) return Math.floor(v);
    }
  } catch {
    // an absent or broken stamp counts as version 1
  }
  return 1;
}

/** Throws format_newer (503) when the folder was written by a newer build. Never writes. */
export function checkFormat(graphDir: string): void {
  const found = readFormatVersion(graphDir);
  if (found > FORMAT_VERSION) {
    throw new KnowledgeError(
      503,
      "format_newer",
      `The learning graph uses format ${found} and this build reads format ${FORMAT_VERSION}. Update this app to read it.`,
      { found, supported: FORMAT_VERSION },
    );
  }
}

/** Creates the stamp when it is absent. Called by the first write of any graph file. */
export function stampFormat(graphDir: string): void {
  const file = path.join(graphDir, "format.json");
  if (fs.existsSync(file)) return;
  fs.mkdirSync(graphDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: FORMAT_VERSION }, null, "\t")}\n`);
  fs.renameSync(tmp, file);
}
