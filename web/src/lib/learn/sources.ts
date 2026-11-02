// Typed calls to routes 38 and 40 to 46 of docs/CONTRACTS.md ("Routes"), and the pure helpers of the Sources window.
import type { AddRoot, FileRecord, Passage, RootChange, RootSummary, ScanResult, SourceRoot } from "@shared/learn/sources";
import type { DeletionMode, DeletionStats } from "@shared/learn/knowledge";
import { learnRequest } from "./http";

export const learnSources = {
  roots: async () => (await learnRequest<{ roots: RootSummary[] }>("GET", "sources")).roots,
  add: async (body: AddRoot) => (await learnRequest<{ root: SourceRoot }>("POST", "sources", body)).root,
  change: async (rootId: string, body: RootChange) => (await learnRequest<{ root: SourceRoot }>("PATCH", `sources/${encodeURIComponent(rootId)}`, body)).root,
  remove: (rootId: string, mode: DeletionMode) =>
    learnRequest<{ mode: DeletionMode; files: number; stats?: DeletionStats }>("DELETE", `sources/${encodeURIComponent(rootId)}?mode=${mode}`),
  scan: (rootId: string) => learnRequest<ScanResult>("POST", `sources/${encodeURIComponent(rootId)}/scan`, {}),
  extract: (rootId: string, body: { paths?: string[]; force?: boolean; confirm?: boolean } = {}) =>
    learnRequest<{ started: number; queued: number }>("POST", `sources/${encodeURIComponent(rootId)}/extract`, body),
  files: async (rootId: string) => (await learnRequest<{ files: FileRecord[] }>("GET", `sources/${encodeURIComponent(rootId)}/files`)).files,
  passage: (source: string, from = 1, to = from + 199) =>
    learnRequest<Passage>("GET", `passage?source=${encodeURIComponent(source)}&from=${from}&to=${to}`),
};

export const KIND_LABELS: Record<SourceRoot["kind"], string> = {
  notes: "Notes folder",
  pdf: "PDF file",
  "claude-memory": "Claude memory",
  "claude-transcripts": "Claude transcripts",
  "claude-instructions": "Claude instructions",
  "projects-md": "Project documents",
  learnharness: "LearnHarness folder",
};

export const KIND_OPTIONS = Object.keys(KIND_LABELS) as SourceRoot["kind"][];

export const SENSITIVITY_LABELS = { public: "Public", internal: "Internal", "client-confidential": "Client confidential" } as const;

/** What a hosted provider may receive, in the words shown beside the consent switch. */
/**
 * What the Hosted providers switch of a root means. The gate of the contracts ("Sensitivity gate and model policy") lets
 * any model read a public or internal root, and lets a hosted provider read a client-confidential root only after the
 * person records consent for it, so the switch matters only for a client-confidential root (2 November 2026).
 */
export function consentExplanation(root: Pick<SourceRoot, "sensitivity" | "hostedConsentAt">): string {
  const base = "A hosted provider is a model service that runs outside this computer.";
  if (root.sensitivity !== "client-confidential") {
    return `${base} This root is not client confidential, so the model that you chose may read it. Mark the root client confidential to keep its text on Claude Code or on a model of your own.`;
  }
  return root.hostedConsentAt
    ? `${base} You allowed hosted providers to read this client confidential root. Switch it off to stop any further text going to a hosted provider.`
    : `${base} This root is client confidential, so only Claude Code, which runs under your own agreement with Anthropic, or a model on your own computer or network may read it. Switch this on to let a hosted provider read it too.`;
}

export const STATE_WORDS: Record<FileRecord["state"], string> = {
  pending: "Not read yet",
  current: "Up to date",
  missing: "File not found",
  refused: "Refused",
};

export const OUTCOME_WORDS: Record<NonNullable<FileRecord["outcome"]>, string> = {
  completed: "Read in full",
  partial: "Partly read",
  failed: "Failed",
  aborted: "Stopped",
  busy: "Busy, try again",
};

export const REASON_WORDS: Record<NonNullable<FileRecord["reason"]>, string> = {
  unsupported: "The file type is not supported.",
  hidden: "The file is hidden, so it was left out.",
  too_large: "The file is larger than the limit of 25 MiB.",
  too_long: "The file is longer than a model can read in one pass.",
  unreadable: "The file could not be read.",
  no_text: "The file holds no text to read.",
  forbidden_path: "The path is on the list of places that are never read.",
  sensitivity: "The sensitivity of the root does not allow the chosen provider to read it.",
  symlink: "The file is a link to another place, so it was left out.",
  excluded: "A pattern of the root excludes this file.",
};

export function statsLine(s: { nodes: number; chains: number; droppedChains?: number }): string {
  const base = `${s.nodes} ${s.nodes === 1 ? "proposition" : "propositions"}, ${s.chains} ${s.chains === 1 ? "chain" : "chains"}`;
  return s.droppedChains ? `${base}, ${s.droppedChains} dropped` : base;
}

/** The state of a file as one plain sentence for the detail pane. */
export function fileSummary(f: FileRecord): string {
  const parts: string[] = [STATE_WORDS[f.state]];
  if (f.outcome) parts.push(OUTCOME_WORDS[f.outcome]);
  if (f.stats) parts.push(statsLine(f.stats));
  return `${parts.join(". ")}.`;
}

/** Splits a glob list typed one per line or separated by commas. */
export function parseGlobs(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((g) => g.trim())
    .filter(Boolean);
}

export function dateWord(iso: string | null): string {
  if (!iso) return "Not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not recorded";
  return d.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
}
