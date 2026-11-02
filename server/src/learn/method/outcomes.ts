// The outcomes ledger, cortex/outcomes.jsonl, exactly as CONTRACTS "Cortex
// extension files" states it. A line is derived from the saved record: one for
// each graded choice answer that carries a target, and one for each conclude of
// a problem that carries a target. A free recall answer writes no line. The
// identifier is a hash of the session and the tool call, so a second sync of
// the same record appends nothing.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AnswerDetails, NativeMessage, OutcomeLine, SessionRecord } from "../../../../shared/learn/index.ts";
import { toolCallsOf, type ToolCallRef } from "../runtime/scans.ts";
import type { LearnEvents, TargetResolver } from "./deps.ts";
import { targetsOfCall } from "./tools/state.ts";

export const outcomesPath = (learnDir: string): string => path.join(learnDir, "cortex", "outcomes.jsonl");

export const outcomeId = (sessionId: string, toolCallId: string): string =>
  `out_${createHash("sha256").update(`${sessionId}/${toolCallId}`).digest("hex").slice(0, 12)}`;

const RUNGS = new Set(["R0", "R1", "R2", "R3", "R4", "R5"]);
const MISS = new Set(["cue", "discrimination", "execution", "careless", "structural"]);
const OUTCOMES = new Set(["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"]);

const isOutcomeLine = (v: unknown): v is OutcomeLine => {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.at === "string" &&
    typeof o.sessionId === "string" &&
    typeof o.toolCallId === "string" &&
    (o.tool === "quiz" || o.tool === "probe" || o.tool === "problem") &&
    (o.source === "choice" || o.source === "practice") &&
    Array.isArray(o.target) &&
    o.target.length > 0 &&
    o.target.every((t) => typeof t === "string")
  );
};

/** A strict read: a line with bad JSON or the wrong shape is skipped and never repaired. */
export function readOutcomes(learnDir: string): OutcomeLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(outcomesPath(learnDir), "utf8");
  } catch {
    return [];
  }
  const out: OutcomeLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isOutcomeLine(v)) out.push(v);
    } catch {
      // a torn append never takes the ledger down
    }
  }
  return out;
}

export const outcomesForNode = (lines: OutcomeLine[], nodeId: string): OutcomeLine[] => lines.filter((l) => l.target.includes(nodeId));

/** Appends the lines whose identifier the file does not hold yet, and returns the lines that were added. */
export function appendOutcomes(learnDir: string, lines: OutcomeLine[]): OutcomeLine[] {
  if (lines.length === 0) return [];
  const known = new Set(readOutcomes(learnDir).map((l) => l.id));
  const fresh = lines.filter((l, i) => !known.has(l.id) && lines.findIndex((x) => x.id === l.id) === i);
  if (fresh.length === 0) return [];
  const file = outcomesPath(learnDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // a torn last line is closed first, so that the new lines start on their own line
  let prefix = "";
  try {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, "r");
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      fs.closeSync(fd);
      if (last[0] !== 0x0a) prefix = "\n";
    }
  } catch {
    // the file does not exist yet
  }
  fs.appendFileSync(file, prefix + fresh.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return fresh;
}

const iso = (ms: unknown, fallback: number): string => new Date(typeof ms === "number" && Number.isFinite(ms) ? ms : fallback).toISOString();

const isClean = (m: NativeMessage & { role: "toolResult" }): boolean => !m.isError && (m.details as { ok?: unknown } | null | undefined)?.ok !== false;

/** The lines that a record implies, in record order. Pure. */
export function outcomeLinesOf(record: SessionRecord, resolver: TargetResolver | undefined, now: () => number): OutcomeLine[] {
  const calls = new Map<string, ToolCallRef>();
  for (const m of record.messages) if (m.role === "assistant") for (const c of toolCallsOf(m)) calls.set(c.id, c);
  const thinkingByProblem = new Map<string, number>();
  for (const m of record.messages) {
    if (m.role === "custom" && m.customType === "practice-thinking") {
      const d = m.details as { problemCallId?: unknown; text?: unknown } | undefined;
      if (typeof d?.problemCallId === "string" && typeof d.text === "string") thinkingByProblem.set(d.problemCallId, (thinkingByProblem.get(d.problemCallId) ?? 0) + d.text.length);
    }
  }
  const out: OutcomeLine[] = [];
  let openProblem: ToolCallRef | null = null;
  for (const m of record.messages) {
    if (m.role !== "toolResult") continue;
    const call = calls.get(m.toolCallId);
    if (!call) continue;
    if (call.name === "problem" && isClean(m)) {
      openProblem = call;
      continue;
    }
    if (call.name === "conclude" && isClean(m)) {
      const d = (m.details ?? {}) as { problemCallId?: unknown; outcome?: unknown };
      const problem = typeof d.problemCallId === "string" ? (calls.get(d.problemCallId) ?? openProblem) : openProblem;
      openProblem = null;
      if (!problem) continue;
      const target = targetsOfCall(problem.arguments, resolver);
      const outcome = typeof d.outcome === "string" ? d.outcome : String(call.arguments.outcome);
      if (target.length === 0 || !OUTCOMES.has(outcome)) continue;
      const rung = typeof call.arguments.rung === "string" && RUNGS.has(call.arguments.rung) ? (call.arguments.rung as OutcomeLine["rung"]) : null;
      const missClass = typeof call.arguments.missClass === "string" && MISS.has(call.arguments.missClass) ? (call.arguments.missClass as OutcomeLine["missClass"]) : null;
      out.push({
        id: outcomeId(record.id, call.id),
        at: iso(m.timestamp, now()),
        sessionId: record.id,
        messageId: m.id,
        toolCallId: call.id,
        tool: "problem",
        source: "practice",
        planNode: null,
        target,
        correct: outcome === "solved" || outcome === "solvedWithHints" ? true : outcome === "dismissed" ? null : false,
        confidence: null,
        outcome: outcome as OutcomeLine["outcome"],
        rung,
        missClass,
        ...(call.arguments.retest === true ? { retest: true } : {}),
        thinkingChars: thinkingByProblem.get(problem.id) ?? 0,
      });
      continue;
    }
    if ((call.name === "quiz" || call.name === "probe") && m.details && typeof m.details === "object") {
      const d = m.details as AnswerDetails;
      if (d.kind !== "quiz" || d.dismissed || d.questionRecovery) continue;
      const target = targetsOfCall(call.arguments, resolver);
      if (target.length === 0) continue;
      const correct = d.dontKnow ? null : typeof d.correct === "boolean" ? d.correct : undefined;
      if (correct === undefined) continue;
      out.push({
        id: outcomeId(record.id, call.id),
        at: iso(m.timestamp, now()),
        sessionId: record.id,
        messageId: m.id,
        toolCallId: call.id,
        tool: call.name,
        source: "choice",
        planNode: typeof call.arguments.nodeId === "string" && call.arguments.nodeId ? call.arguments.nodeId : null,
        target,
        correct,
        confidence: d.dontKnow || typeof d.confidence !== "number" ? null : d.confidence,
        rung: null,
        missClass: null,
        thinkingChars: (d.thinking ?? "").length,
      });
    }
  }
  return out;
}

/** Writes the lines that the record implies and are not yet in the ledger, and fires the answer event once for each. */
export function syncOutcomes(learnDir: string, record: SessionRecord, deps: { resolver?: TargetResolver; events?: LearnEvents; now: () => number }): OutcomeLine[] {
  const added = appendOutcomes(learnDir, outcomeLinesOf(record, deps.resolver, deps.now));
  for (const line of added) {
    try {
      deps.events?.answer({ session: record.id, key: line.toolCallId, target: line.target, tool: line.tool, correct: line.correct });
    } catch {
      // an event sink never fails a settled turn
    }
  }
  return added;
}
