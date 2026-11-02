// Reader for Claude Code transcripts, the *.jsonl files of ~/.claude/projects/<folder>. The prose view holds the prose of the
// person and of the assistant and nothing else: no tool call, no tool result, no thinking, no hook output and no image.
// Each message keeps the uuid of the transcript as its message id.
import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
import { visibleMessage } from "../../knowledge/coverage.ts";

export interface TranscriptMessage {
  /** the uuid of the transcript line */
  id: string;
  role: "user" | "assistant";
  label: "USER" | "ASSISTANT";
  text: string;
  at: string | null;
}

export interface TranscriptRead {
  messages: TranscriptMessage[];
  /** the prose view that is chunked and hashed */
  view: string;
  sha256: string;
  /** bytes of the prose view */
  proseBytes: number;
}

const BLOCK = /<(system-reminder|local-command-stdout|local-command-stderr|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;

// A line of a message that starts like the label of the view ("USER [id]" or "ASSISTANT: ...") would read as a new message
// from another speaker with an id of its own. The label is marked as quoted and the brackets of its id become parentheses.
const FORGED_LABEL = /^([ \t]*)(USER|ASSISTANT)(?=[ \t]*[[:])([ \t]*)(?:\[([^\]\n]*)\])?/gim;

/** Defuses message text that imitates the role and message id labels of the view. */
export function neutraliseLabels(text: string): string {
  return text.replace(FORGED_LABEL, (_all, lead: string, role: string, gap: string, id: string | undefined) => `${lead}quoted ${role.toLowerCase()}${gap}${id === undefined ? "" : `(id ${id})`}`);
}

function proseOf(content: unknown): string {
  const parts: string[] = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string") parts.push((b as { text: string }).text);
    }
  }
  return parts.join("\n\n").replace(BLOCK, "").trim();
}

/** Turns one line of a transcript into a message, or null when the line holds no prose of the person or the assistant. */
export function parseTranscriptLine(line: string): TranscriptMessage | null {
  let rec: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(line);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    rec = v as Record<string, unknown>;
  } catch {
    return null;
  }
  if (rec.type !== "user" && rec.type !== "assistant") return null;
  if (rec.isSidechain === true || rec.isMeta === true || rec.isCompactSummary === true) return null;
  if (typeof rec.uuid !== "string" || !rec.uuid) return null;
  const msg = rec.message;
  if (!msg || typeof msg !== "object") return null;
  const text = neutraliseLabels(proseOf((msg as { content?: unknown }).content));
  if (!text) return null;
  const role = rec.type;
  return {
    id: rec.uuid,
    role,
    label: role === "user" ? "USER" : "ASSISTANT",
    text,
    at: typeof rec.timestamp === "string" ? rec.timestamp : null,
  };
}

/** One message as the extractor sees it: the label, the id in square brackets and the trimmed text. */
export const viewOf = (m: TranscriptMessage): string => `${m.label} [${m.id}] ${m.text.trim()}`;

export const buildView = (messages: TranscriptMessage[]): string => messages.map(viewOf).join("\n\n");

/** The fingerprint of a covered message. It is the fingerprint of the extracted view in knowledge/coverage.ts, so that the scan and the extraction agree on what is covered. */
export function transcriptFingerprint(m: TranscriptMessage): string {
  return visibleMessage(m.label, m.id, [m.text]).fp;
}

/** Characters divided by 4, rounded up, as the contracts define a token estimate. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Reads the prose of a transcript as a stream. Returns "too_large" when the prose passes maxProseBytes. */
export async function readTranscript(file: string, opts: { maxProseBytes: number }): Promise<TranscriptRead | "too_large"> {
  const messages: TranscriptMessage[] = [];
  let bytes = 0;
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const m = parseTranscriptLine(line);
      if (!m) continue;
      bytes += Buffer.byteLength(viewOf(m)) + 2;
      if (bytes > opts.maxProseBytes) return "too_large";
      messages.push(m);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  const view = buildView(messages);
  return { messages, view, sha256: crypto.createHash("sha256").update(view).digest("hex"), proseBytes: bytes };
}
