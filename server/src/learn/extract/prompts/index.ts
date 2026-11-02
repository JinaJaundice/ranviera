// The prompt fragments of the extraction stages. They are Markdown files in a folder beside this module, or beside the
// bundle in the packaged server (see ../../prompt-folder.ts), read once. The extractor prompt is the shared core
// followed by the framing of the kind of source.
import fs from "node:fs";
import path from "node:path";
import { promptFolder } from "../../prompt-folder.ts";
import type { SourceShape } from "../types.ts";

const FRAMING: Record<SourceShape, string> = {
  notes: "extractor-notes",
  transcript: "extractor-transcript",
  session: "extractor-session",
};

/** Every fragment that the two prompts read. The packaging test requires each of them in the bundle. */
export const EXTRACT_FRAGMENTS: readonly string[] = ["extractor-core", ...Object.values(FRAMING), "auditor"].map((n) => `${n}.md`);

export interface ExtractPrompts {
  extractorPrompt(shape: SourceShape): string;
  auditorPrompt(): string;
}

/** The prompts read from one folder. A missing fragment throws when its prompt is first asked for. */
export function createExtractPrompts(dir: string): ExtractPrompts {
  const cache = new Map<string, string>();
  const read = (name: string): string => {
    let text = cache.get(name);
    if (text === undefined) {
      text = fs.readFileSync(path.join(dir, `${name}.md`), "utf8").replace(/\r\n/g, "\n").trim();
      cache.set(name, text);
    }
    return text;
  };
  return {
    extractorPrompt: (shape) => `${read("extractor-core")}\n\n${read(FRAMING[shape])}`,
    auditorPrompt: () => read("auditor"),
  };
}

let shared: ExtractPrompts | null = null;
const prompts = (): ExtractPrompts => (shared ??= createExtractPrompts(promptFolder(import.meta.url, "extract")));

/** The system prompt of the extractor for a kind of source. */
export function extractorPrompt(shape: SourceShape): string {
  return prompts().extractorPrompt(shape);
}

/** The system prompt of the auditor. */
export function auditorPrompt(): string {
  return prompts().auditorPrompt();
}
