// Reader for the Markdown files of the Projects folder. Read only: nothing here opens a file for writing.
// A file under `deliverables/` points to a `deliverable:` node, and any other file has none, so that a claim from it gets a `source:` node.
import { parseNote, type NoteRead } from "./notes.ts";

export interface ProjectsMdRead extends NoteRead {
  nodeHint: { prefix: "deliverable" | "source"; name: string };
}

export function readProjectsMd(text: string, relPath: string): ProjectsMdRead {
  const note = parseNote(text);
  const stem = relPath.split("/").pop()!.replace(/\.[^.]+$/, "");
  return { ...note, nodeHint: { prefix: relPath.startsWith("deliverables/") ? "deliverable" : "source", name: stem } };
}
