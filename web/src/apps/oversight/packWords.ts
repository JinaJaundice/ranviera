// Pure helpers for the Evidence pack section: which runs a scope covers, what the pack would hold and file sizes.
import { plural } from "./model";

interface RunLike {
  run: string;
  agent: string;
  case_ref: string | null;
  ts: string;
  reviewed: boolean;
  override: boolean;
  findings: number;
}

/** The runs that an evidence pack of this scope would cover. */
export function packRuns<R extends RunLike>(runs: R[], kind: "alert" | "run" | "agent" | "period", value: string, from: string, to: string): R[] {
  if (kind === "run") return runs.filter((r) => r.run === value);
  if (kind === "alert") return runs.filter((r) => r.case_ref === value);
  if (kind === "agent") return runs.filter((r) => r.agent === value);
  if (!from || !to) return [];
  return runs.filter((r) => r.ts.slice(0, 10) >= from && r.ts.slice(0, 10) <= to);
}

/** A sentence that says what a pack would hold, from the runs it covers. */
export function packPreviewText(runs: RunLike[]): string {
  if (runs.length === 0) return "No run matches this scope, so the pack would hold no decision trace.";
  const reviewed = runs.filter((r) => r.reviewed).length;
  const overridden = runs.filter((r) => r.override).length;
  const findings = runs.reduce((n, r) => n + r.findings, 0);
  return `The pack would cover ${plural(runs.length, "run")}, of which ${reviewed} ${reviewed === 1 ? "was" : "were"} reviewed by a person and ${overridden} ${overridden === 1 ? "was" : "were"} overridden. The runs carry ${plural(findings, "finding")}.`;
}

/** The runs of a pack that a reviewer should see before export: those with a finding or an override first, then the rest. */
export function previewSplit<R extends RunLike>(runs: R[]): { notable: R[]; others: R[] } {
  const notable = runs.filter((r) => r.findings > 0 || r.override);
  return { notable, others: runs.filter((r) => !(r.findings > 0 || r.override)) };
}

/** What a written pack holds, in the order of the readable document. */
export const PACK_CONTENTS: { file: string; text: string }[] = [
  { file: "Readable pack", text: "A document that prints. It holds the limits of the evidence, the decision traces, the instruction versions with their approvals, the links to policy, the findings with their proofs, the monitoring results and the back-tests. A period or agent pack opens with the coverage matrix." },
  { file: "Data file for audit tools", text: "The same content as structured data, with the identifiers of the records." },
  { file: "List of files with fingerprints", text: "A fingerprint and a size for each of the other two files, so that a later change to either file can be detected." },
];

/** The size of a file in words. */
export function sizeText(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : bytes >= 1000 ? `${Math.round(bytes / 1000)} KB` : `${bytes} bytes`;
}
