// Coverage: what the extractor has seen. Fingerprints of the extracted view of
// a session, the derived uncovered state and greedy batching that never splits
// a message. docs/CONTRACTS.md, "Sources, checkpoints and coverage".
//
// The fingerprint is the SHA-256 in hex of JSON.stringify([role, lines]), where
// lines are the view lines of the message, with no spaces in the JSON and
// non ASCII characters written as they are. A view line is
// "<LABEL> [<message id>] <trimmed text>".

import { createHash } from "node:crypto";
import type { CoverageLine } from "../../../../shared/learn/knowledge.ts";
import type { CoverageBlock, NativeMessage } from "../../../../shared/learn/sessions.ts";

export interface VisibleMessage {
  messageId: string;
  fp: string;
  tokens: number;
  lines: string[];
}

/** Tokens are the number of characters divided by 4, rounded up. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function viewLine(label: string, messageId: string, text: string): string {
  return `${label} [${messageId}] ${text.trim()}`;
}

export function fingerprint(role: string, lines: string[]): string {
  return createHash("sha256").update(JSON.stringify([role, lines])).digest("hex");
}

/** Builds one visible message from the trimmed texts it holds. A message with no text has zero tokens. */
export function visibleMessage(label: string, messageId: string, texts: string[]): VisibleMessage {
  const trimmed = texts.map((t) => t.trim()).filter((t) => t !== "");
  const lines = trimmed.map((t) => viewLine(label, messageId, t));
  return {
    messageId,
    fp: fingerprint(label, lines),
    tokens: estimateTokens(trimmed.reduce((n, t) => n + t.length, 0)),
    lines,
  };
}

/**
 * The extracted view of a session. The extractor sees only the teacher's prose:
 * ordinary text blocks and the output of a successful send_to_user call.
 * Learner messages, thinking, other tool calls and results, and markers are
 * invisible, and so is a failed output call.
 */
export function sessionView(messages: NativeMessage[]): VisibleMessage[] {
  const failed = new Set<string>();
  for (const m of messages) if (m.role === "toolResult" && m.isError) failed.add(m.toolCallId);
  const out: VisibleMessage[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const texts: string[] = [];
    for (const block of m.content) {
      if (block.type === "text") texts.push(block.text);
      else if (block.type === "toolCall" && block.name === "send_to_user" && !failed.has(block.id)) {
        const text = block.arguments.message;
        if (typeof text === "string") texts.push(text);
      }
    }
    out.push(visibleMessage("TEACHER", m.id, texts));
  }
  return out;
}

/** The visible messages whose fingerprint has no coverage line for the session, oldest first. Zero token messages are left out. */
export function uncoveredMessages(view: VisibleMessage[], covered: Pick<CoverageLine, "fp">[]): VisibleMessage[] {
  const done = new Set(covered.map((c) => c.fp));
  return view.filter((m) => m.tokens > 0 && !done.has(m.fp));
}

/**
 * The oldest uncovered messages, taken greedily in order up to the token
 * budget. A message is never split, and one that is over the budget alone
 * becomes its own batch. A budget that is not positive gives no batch.
 */
export function batches(uncovered: VisibleMessage[], budget: number): VisibleMessage[][] {
  if (!(budget > 0)) return [];
  const out: VisibleMessage[][] = [];
  let current: VisibleMessage[] = [];
  let used = 0;
  for (const m of uncovered) {
    if (current.length > 0 && used + m.tokens > budget) {
      out.push(current);
      current = [];
      used = 0;
    }
    current.push(m);
    used += m.tokens;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** The coverage block of a session detail, derived at read time. */
export function coverageBlock(
  view: VisibleMessage[],
  lines: CoverageLine[],
  opts: { running: boolean; threshold: number },
): CoverageBlock {
  const done = new Set(lines.map((l) => l.fp));
  const counted = view.filter((m) => m.tokens > 0);
  const covered = counted.filter((m) => done.has(m.fp));
  const uncovered = counted.filter((m) => !done.has(m.fp));
  const folded = lines.map((l) => l.foldedAt).sort();
  return {
    totalMessages: counted.length,
    coveredCount: covered.length,
    uncoveredCount: uncovered.length,
    coveredTokens: covered.reduce((n, m) => n + m.tokens, 0),
    uncoveredTokens: uncovered.reduce((n, m) => n + m.tokens, 0),
    running: opts.running,
    lastFoldedAt: folded.length > 0 ? folded[folded.length - 1] : null,
    threshold: opts.threshold,
  };
}
