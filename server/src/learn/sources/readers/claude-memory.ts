// Reader for the memory files of Claude. A claim from one of these files points to the existing `memory:` node of the graph,
// so the reader returns the file stem as a hint for the harvester, and the title and type that the front matter names.
import { parseNote, type NoteRead } from "./notes.ts";

export interface MemoryRead extends NoteRead {
  nodeHint: { prefix: "memory"; name: string };
  title: string | null;
  memoryType: string | null;
}

export function readClaudeMemory(text: string, relPath: string): MemoryRead {
  const note = parseNote(text);
  const stem = relPath.split("/").pop()!.replace(/\.[^.]+$/, "");
  return {
    ...note,
    nodeHint: { prefix: "memory", name: stem },
    title: note.frontMatter?.name ?? null,
    memoryType: note.frontMatter?.type ?? null,
  };
}
