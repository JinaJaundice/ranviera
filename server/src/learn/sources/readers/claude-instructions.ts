// Reader for CLAUDE.md, the rule files and the skills. The bullets of these files are already `rule:` nodes of the harness graph,
// so the reader marks the file as a `rulefile:` and leaves the bullets in the text for the extractor.
import { parseNote, type NoteRead } from "./notes.ts";

export interface InstructionsRead extends NoteRead {
  nodeHint: { prefix: "rulefile"; name: string };
  role: "claude-md" | "rule" | "skill";
}

export function readClaudeInstructions(text: string, relPath: string): InstructionsRead {
  const note = parseNote(text);
  const role = relPath === "CLAUDE.md" ? "claude-md" : relPath.startsWith("skills/") ? "skill" : "rule";
  const stem = role === "skill" ? relPath.split("/").slice(-2, -1)[0] : relPath.split("/").pop()!.replace(/\.[^.]+$/, "");
  return { ...note, nodeHint: { prefix: "rulefile", name: stem }, role };
}
