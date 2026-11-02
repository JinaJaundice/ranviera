// Route 38: at most 200 lines of a source file by line range, with the nearest heading. The lines are those of the text that the
// extractor read, which is the file itself, the converted PDF or the prose view of a transcript, so that a locator line is a line here.
import fs from "node:fs";
import type { Passage, SourceRoot } from "../../../../shared/learn/sources.ts";
import { badRequest, notFound } from "./errors.ts";
import type { FileStore } from "./files.ts";
import { resolveInRoot, type DenyList } from "./paths.ts";
import { readSourceText, type Limits } from "./readers/index.ts";
import { headingAt, parseNote, splitLines } from "./readers/notes.ts";

export const MAX_PASSAGE_LINES = 200;

export interface PassageDeps {
  files: FileStore;
  deny: DenyList;
  limits: Limits;
  getRoot: (id: string) => SourceRoot | null;
}

export async function readPassage(deps: PassageDeps, sourceId: string, from: number, to: number): Promise<Passage> {
  if (!/^src_[0-9a-f]{12}$/.test(sourceId)) throw badRequest("The source id is not valid.");
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw badRequest("The line range must be whole numbers with from at least 1 and to at least from.");
  const rec = deps.files.all().get(sourceId);
  const root = rec ? deps.getRoot(rec.rootId) : null;
  if (!rec || !root) throw notFound("No linked file has that source id.");
  const rootIsFile = fs.existsSync(root.path) && fs.lstatSync(root.path).isFile();
  const abs = resolveInRoot(deps.deny, root.path, rec.path, rootIsFile);
  const text = await readSourceText(root.kind, abs, deps.limits);
  if (!text.ok) throw badRequest(text.message);
  const lines = splitLines(text.text);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (from > lines.length) throw notFound("The passage starts after the end of the file.");
  const end = Math.min(to, from + MAX_PASSAGE_LINES - 1, lines.length);
  return {
    sourceId,
    path: rec.path,
    from,
    to: end,
    lines: lines.slice(from - 1, end),
    heading: headingAt(parseNote(text.text).headings, from),
    fileChanged: text.sha256 !== (rec.lastExtractedSha256 ?? rec.sha256),
  };
}
