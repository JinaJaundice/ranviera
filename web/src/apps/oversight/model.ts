// Pure helpers for the Oversight window.
import type { MappingRecord, MonitoringReport, ProofNode, TraceFinding } from "@shared/types";
import type { Tone } from "../../components/StatusDot";

export const LIMITS_NOTE =
  "The trace shows what the agent had in context, the tools it called, the evidence it read and the text it wrote. It does not show the internal computation of the model, and a complete trace does not show that a decision was correct.";

export const UNAVAILABLE_NOTE =
  "No agent runs, mappings or instruction stores are loaded. To open the demonstrator, run npm run demo from the Ranviera folder, which builds a sample installation and starts the server on it.";

export const NO_BOUND = "No bound set by the bank";

export function isProofNode(v: unknown): v is ProofNode {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return typeof n.fact === "string" && Array.isArray(n.children);
}

export const severityTone = (s: TraceFinding["severity"]): Tone => (s === "violation" ? "block" : s === "warning" ? "hold" : "idle");

export const severityWord = (s: TraceFinding["severity"]): string => (s === "violation" ? "Violation" : s === "warning" ? "Warning" : "Note");

/** The findings of a run that no step carries, so that they are listed once and not twice. */
export function unplacedFindings(all: TraceFinding[], steps: { findings: TraceFinding[] }[]): TraceFinding[] {
  const key = (f: TraceFinding) => `${f.check}|${f.node}|${f.message}`;
  const placed = new Set(steps.flatMap((s) => s.findings.map(key)));
  return all.filter((f) => !placed.has(key(f)));
}

/** Whole days from an ISO date or timestamp to now, or null where the date cannot be read. */
export function ageDays(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

export function ageText(days: number | null): string {
  if (days === null) return "Age not known";
  if (days === 0) return "Today";
  return days === 1 ? "1 day" : `${days} days`;
}

/** What the days of a queue row count, such as Proposed 20 days ago or Ratified 3 days ago. */
export function ageLine(kind: "proposed" | "stale", days: number | null): string {
  const verb = kind === "proposed" ? "Proposed" : "Ratified";
  if (days === null) return `${verb}, date not known`;
  if (days === 0) return `${verb} today`;
  return `${verb} ${days === 1 ? "1 day" : `${days} days`} ago`;
}

/** The date a mapping entered its present state, from its history. */
export function sinceOf(m: MappingRecord): string | null {
  const last = m.history[m.history.length - 1];
  return last?.ts ?? m.valid_from ?? null;
}

export interface QueueRow {
  mapping: MappingRecord;
  kind: "proposed" | "stale";
  days: number | null;
}

/** Proposed and stale mappings, by owner and then oldest first. */
export function queueRows(proposed: MappingRecord[], stale: MappingRecord[], now: number): QueueRow[] {
  const rows: QueueRow[] = [
    ...proposed.filter((m) => m.status === "proposed").map((m) => ({ mapping: m, kind: "proposed" as const, days: ageDays(sinceOf(m), now) })),
    ...stale.filter((m) => m.status === "ratified").map((m) => ({ mapping: m, kind: "stale" as const, days: ageDays(sinceOf(m), now) })),
  ];
  return rows.sort((a, b) => a.mapping.owner.localeCompare(b.mapping.owner) || (b.days ?? -1) - (a.days ?? -1) || a.mapping.id.localeCompare(b.mapping.id));
}

export function ownersOf(rows: QueueRow[]): string[] {
  return [...new Set(rows.map((r) => r.mapping.owner))].sort();
}

export function diffCounts(lines: { op: "same" | "add" | "remove" }[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.op === "add").length, removed: lines.filter((l) => l.op === "remove").length };
}

/** The text of the later version, rebuilt from the diff, so that a draft can start from it. */
export function latestText(lines: { op: "same" | "add" | "remove"; text: string }[]): string {
  return lines.filter((l) => l.op !== "remove").map((l) => l.text).join("\n");
}

export function boundText(b: { min: number | null; max: number | null } | undefined, unit: string): string {
  if (!b || (b.min === null && b.max === null)) return NO_BOUND;
  const parts: string[] = [];
  if (b.min !== null) parts.push(`at least ${b.min}${unit}`);
  if (b.max !== null) parts.push(`at most ${b.max}${unit}`);
  return parts.join(" and ");
}

export function outsideBound(v: number | null, b: { min: number | null; max: number | null } | undefined): boolean {
  if (v === null || !b) return false;
  return (b.min !== null && v < b.min) || (b.max !== null && v > b.max);
}

export function agreementText(a: { sampled: number; agree: number }): string {
  return a.sampled === 0 ? "No runs sampled" : `${Math.round((a.agree / a.sampled) * 100)}% of ${a.sampled}`;
}

export function perMilleText(v: number | null): string {
  return v === null ? "No reviewed decisions" : `${v} in every 1,000 reviewed decisions`;
}

export type Agent = MonitoringReport["agents"][number];

export type ScopeKind = "alert" | "run" | "agent" | "period";

/** The scope string of `pack export`, or null where the input is not complete. */
export function scopeOf(kind: ScopeKind, value: string, from: string, to: string): string | null {
  if (kind === "period") return /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to ? `period:${from}..${to}` : null;
  const v = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(v) ? `${kind}:${v}` : null;
}

/** A time in the form 1 October 2026 at 09:00. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "Not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} at ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

export const shortHash = (h: string | null | undefined): string => (h ? h.replace(/^sha256:/, "").slice(0, 12) : "none");

/** A date in the form 12 August 2026, from a date or a timestamp. */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return "Not recorded";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = new Date(dateOnly ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", ...(dateOnly ? { timeZone: "UTC" } : {}) });
}

/** A count with its noun, such as 1 version or 2 versions. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The name of an agent for a reader, from its identifier or its label: dagent:alert-triage becomes Alert triage. */
export function agentName(idOrLabel: string): string {
  const s = idOrLabel.replace(/^dagent:/, "").replace(/[-_]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : idOrLabel;
}

const OUTCOME_WORD: Record<string, string> = { close: "Closed", escalate: "Escalated", "request-information": "Information requested" };

/** The outcome of a decision in the words of a reader. */
export function outcomeWord(outcome: string | null | undefined): string {
  if (!outcome) return "None";
  if (OUTCOME_WORD[outcome]) return OUTCOME_WORD[outcome];
  const s = outcome.replace(/[-_]+/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const RELATION_WORD: Record<string, string> = {
  implementsClause: "implements the clause",
  realises: "realises the control",
  satisfies: "satisfies the obligation",
  expressedIn: "is expressed in the provision",
  notDischargedBy: "is not discharged by",
  detects: "detects the typology",
  appliesTo: "applies to",
};

/** A relation of the graph in plain words. */
export const relationWord = (r: string): string => RELATION_WORD[r] ?? r.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

const TYPE_WORD: Record<string, string> = { PolicyClause: "Clause", Control: "Control", Obligation: "Obligation", LegislativeProvision: "Provision", InstructionVersion: "Instruction" };

export const nodeTypeWord = (t: string): string => TYPE_WORD[t] ?? t;

export const statusWord = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export interface Named {
  id: string;
  name: string;
}

/** The name of a person from the people file, or the identifier without its prefix where the person is not listed. */
export function personName(people: Named[], id: string | null | undefined): string {
  if (!id) return "Not recorded";
  const bare = id.replace(/^person:/, "");
  if (bare === "ranviera-matcher") return "The automatic matching tool";
  const found = people.find((p) => p.id === bare)?.name;
  if (found) return found;
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(bare) ? agentName(bare) : bare;
}

export interface ContextStep {
  step: number;
  in_context: { id: string; label: string }[];
}

export interface ContextNote {
  step: number;
  /** full: the first list, same: nothing changed since `from`, changed: some instructions differ from the step before */
  kind: "full" | "same" | "changed";
  from: number;
  /** true where `from` is the first step of the run */
  atStart: boolean;
  added: { id: string; label: string }[];
  removed: { id: string; label: string }[];
}

/** For each step, whether the instructions in context are listed in full, are the same as an earlier step or have changed. */
export function contextNotes(steps: ContextStep[]): ContextNote[] {
  const notes: ContextNote[] = [];
  let prev: ContextStep | null = null;
  let origin = 0;
  let first = 0;
  for (const s of steps) {
    if (!prev) {
      origin = s.step;
      first = s.step;
      notes.push({ step: s.step, kind: "full", from: s.step, atStart: true, added: s.in_context, removed: [] });
    } else {
      const before = new Set(prev.in_context.map((i) => i.id));
      const now = new Set(s.in_context.map((i) => i.id));
      const added = s.in_context.filter((i) => !before.has(i.id));
      const removed = prev.in_context.filter((i) => !now.has(i.id));
      if (added.length === 0 && removed.length === 0) {
        notes.push({ step: s.step, kind: "same", from: origin, atStart: origin === first, added, removed });
      } else {
        origin = s.step;
        notes.push({ step: s.step, kind: "changed", from: prev.step, atStart: prev.step === first, added, removed });
      }
    }
    prev = s;
  }
  return notes;
}

/** The evidence that the run read up to and including the decision step, each item once. */
export function evidenceUpTo<E extends { id: string }>(steps: { step: number; evidence: E[] }[], decisionStep: number | null): E[] {
  const seen = new Set<string>();
  const out: E[] = [];
  for (const s of steps) {
    if (decisionStep !== null && s.step > decisionStep) continue;
    for (const e of s.evidence) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        out.push(e);
      }
    }
  }
  return out;
}

export const NO_ACTOR_DEMO = "Choose who is acting to ratify, reject or reassign";
export const NO_ACTOR_FIXED = "No person is set to act, so changes are refused";

const MESSAGE_WORDS: Record<string, string> = { implementsClause: "implements the clause", notDischargedBy: "is not discharged by", appliesTo: "applies to", expressedIn: "is expressed in" };

/** The message of a finding with the names of graph relations in plain words. */
export function plainMessage(m: string): string {
  return m
    .replace(/\bedges\b/g, "links")
    .replace(/\bedge\b/g, "link")
    .replace(/\b[a-z]+[A-Z][A-Za-z]*\b/g, (w) => MESSAGE_WORDS[w] ?? w.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
}
