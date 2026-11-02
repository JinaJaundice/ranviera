// The words and tones of the Sources window, as pure functions so that they are tested without a screen.
import type { FileRecord } from "@shared/learn/sources";
import { OUTCOME_WORDS, REASON_WORDS, STATE_WORDS, statsLine } from "../../lib/learn/sources";
import { LearnApiError } from "../../lib/learn/models";
import type { Tone } from "../../components/StatusDot";
import type { TreeNode } from "./tree";

export const STATE_TONE: Record<FileRecord["state"], Tone> = { pending: "idle", current: "pass", missing: "hold", refused: "block" };

/** What a file row says in its result column: the outcome and the figures, the refusal reason, or the words for not read. */
export function resultWords(f: FileRecord): string {
  if (f.state === "refused") return f.reason ? REASON_WORDS[f.reason] : "The file was refused.";
  if (!f.outcome) return f.state === "missing" ? STATE_WORDS.missing : "Not read yet";
  const base = OUTCOME_WORDS[f.outcome];
  return f.stats ? `${base}, ${statsLine(f.stats)}` : base;
}

/** The counts of a folder or root as one line: how many files are in each state that is not empty. */
export function countsWords(c: TreeNode["counts"]): string {
  if (c.files === 0) return "No files";
  const parts: string[] = [];
  if (c.current) parts.push(`${c.current} up to date`);
  if (c.pending) parts.push(`${c.pending} not read`);
  if (c.missing) parts.push(`${c.missing} not found`);
  if (c.refused) parts.push(`${c.refused} refused`);
  return parts.join(", ");
}

export function fileCountWords(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

/** The line above the tree: how many roots and files are on show. */
export function summaryWords(roots: number, files: number): string {
  return `${roots} ${roots === 1 ? "root" : "roots"}, ${fileCountWords(files)}`;
}

export function bytesWords(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function extractWords(started: number, queued: number): string {
  if (!started && !queued) return "Nothing was queued, because no selected file needs reading.";
  const files = fileCountWords(started + queued);
  return queued ? `${files} accepted. ${started} started and ${queued} waiting.` : `${files} accepted and started.`;
}

/** The figures of a confirm_required refusal, or null for any other failure. */
export function confirmNeeded(e: unknown): { files: number; tokens: number } | null {
  if (!(e instanceof LearnApiError) || e.code !== "confirm_required") return null;
  const { files, tokens } = e.body;
  return typeof files === "number" && typeof tokens === "number" ? { files, tokens } : null;
}

/** The question that the Sources window asks before a large extraction. */
export function confirmWords(c: { files: number; tokens: number }): string {
  return `This will read ${fileCountWords(c.files)}, an estimated ${c.tokens.toLocaleString("en-GB")} ${c.tokens === 1 ? "token" : "tokens"} of text. Confirm to start the extraction.`;
}
