// Learning upgrade: linked sources, scans, locators, outcomes and source
// organisation. The source of truth is docs/CONTRACTS.md, section "Learning
// and knowledge (1 November 2026)", and a change is made there first.

import type { Sensitivity } from "../types.ts";

export type { Sensitivity };

/** Source organisation: graph/source-organization.json, tab indented. */
export interface OrganizationFile {
  version: 1;
  folders: { id: string; name: string; parentId: string | null; createdAt: string; importPath?: string }[];
  /** keyed by source id, name is a display override */
  placements: Record<string, { folderId: string | null; name?: string }>;
}

/** Source organisation: body of POST /api/learn/source-organization. */
export type OrganizationAction =
  | { type: "create-folder"; name: string; parentId: string | null }
  | { type: "rename-folder"; id: string; name: string }
  | { type: "rename-source"; id: string; name: string }
  | { type: "move"; kind: "source" | "folder"; id: string; parentId: string | null }
  | { type: "delete-folder"; id: string };

/** Source organisation: GET /api/learn/source-organization. A missing entry stands for a provenance id that has no record. */
export interface SourceDirectory {
  organization: OrganizationFile;
  sources: { id: string; label: string | null; kind: "notes" | "chat" | "missing"; filePath?: string; createdAt: string | null }[];
}

/** Cortex extension files: the kinds of linked root. */
export type SourceKind =
  | "notes"
  | "pdf"
  | "claude-memory"
  | "claude-transcripts"
  | "claude-instructions"
  | "projects-md"
  | "learnharness";

/** Cortex extension files: one linked root, an entry of cortex/sources.json. */
export interface SourceRoot {
  /** root_<8 hex> */
  id: string;
  kind: SourceKind;
  /** absolute, forward slashes. A folder, or one file for the kind pdf */
  path: string;
  /** shown in the tree and used in SourceRecord.filePath */
  label: string;
  /** globs relative to the root. Empty means the defaults of the kind */
  include: string[];
  /** added to the defaults of the kind */
  exclude: string[];
  sensitivity: Sensitivity;
  mode: "manual" | "scan";
  /** false keeps the root and its knowledge, and stops scans and extraction */
  enabled: boolean;
  /** set when the person agrees that a hosted provider may receive this root */
  hostedConsentAt: string | null;
  createdAt: string;
  lastScanAt: string | null;
}

/** Cortex extension files: cortex/sources.json. */
export interface SourceRegistryFile {
  version: 1;
  roots: Record<string, SourceRoot>;
}

/** Cortex extension files: result of an extraction of one file. */
export type ExtractionOutcome = "completed" | "partial" | "failed" | "aborted" | "busy";

/** Cortex extension files: why a file was refused or skipped. */
export type SkipReason =
  | "unsupported"
  | "hidden"
  | "too_large"
  | "too_long"
  | "unreadable"
  | "no_text"
  | "forbidden_path"
  | "sensitivity"
  | "symlink"
  | "excluded";

/** Cortex extension files: a line of cortex/files.jsonl. The newest line for a sourceId wins. */
export interface FileRecord {
  sourceId: string;
  rootId: string;
  /** relative to the root, forward slashes */
  path: string;
  /** of the file bytes. For a transcript, of the prose view */
  sha256: string;
  bytes: number;
  mtimeMs: number;
  state: "pending" | "current" | "missing" | "refused";
  /** set when a scan saw the file move */
  previousPath?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastExtractedAt: string | null;
  lastExtractedSha256: string | null;
  /** transcripts only, derived from coverage.jsonl */
  uncoveredTokens?: number;
  outcome: ExtractionOutcome | null;
  stats?: { nodes: number; chains: number; droppedChains?: number };
  chunks?: number;
  pages?: number;
  imagePages?: number;
  /** for example the caveat of a converted PDF */
  notice?: string;
  /** why a file was refused or skipped */
  reason?: SkipReason;
}

/** Cortex extension files: a line of cortex/locators.jsonl, one line per proposition and source. */
export interface LocatorLine {
  nodeId: string;
  sourceId: string;
  /** hash of the file when it was extracted */
  fileSha256: string;
  /** 1 based and inclusive, null when the quote was not found */
  startLine: number | null;
  endLine: number | null;
  /** for a PDF, from the nearest page marker */
  page: number | null;
  /** nearest preceding Markdown heading */
  heading: string | null;
  /** the extractor's words, at most 280 characters */
  quote: string;
  /** true when the quote occurs word for word in the chunk */
  found: boolean;
  at: string;
}

/** Cortex extension files: a line of cortex/outcomes.jsonl, append only. */
export interface OutcomeLine {
  /** out_<12 hex> */
  id: string;
  at: string;
  sessionId: string;
  messageId: string;
  toolCallId: string;
  tool: "quiz" | "probe" | "problem";
  source: "choice" | "practice";
  planNode: string | null;
  /** proposition ids, at least 1. An answer with no target writes no line */
  target: string[];
  /** null when the learner chose the not known option */
  correct: boolean | null;
  /** choice only */
  confidence: number | null;
  /** practice only */
  outcome?: "solved" | "solvedWithHints" | "movedOn" | "surrendered" | "dismissed";
  rung: "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | null;
  missClass: "cue" | "discrimination" | "execution" | "careless" | "structural" | null;
  retest?: boolean;
  /** the length of the thinking field. The text stays in the session record */
  thinkingChars: number;
}

/** Request and response shapes: body of POST /api/learn/sources. */
export interface AddRoot {
  kind: SourceKind;
  path: string;
  label?: string;
  include?: string[];
  exclude?: string[];
  sensitivity?: Sensitivity;
  mode?: "manual" | "scan";
}

/** Request and response shapes: body of PATCH /api/learn/sources/:rootId. */
export interface RootChange {
  label?: string;
  include?: string[];
  exclude?: string[];
  sensitivity?: Sensitivity;
  mode?: "manual" | "scan";
  enabled?: boolean;
  hostedConsent?: boolean;
}

/** Request and response shapes: one row of GET /api/learn/sources. */
export interface RootSummary extends SourceRoot {
  counts: { files: number; pending: number; current: number; missing: number; refused: number };
}

/** Request and response shapes: POST /api/learn/sources/:rootId/scan. */
export interface ScanResult {
  rootId: string;
  startedAt: string;
  files: {
    path: string;
    sourceId: string | null;
    change: "new" | "changed" | "unchanged" | "moved" | "missing";
    state: FileRecord["state"];
    reason?: SkipReason;
  }[];
  counts: { new: number; changed: number; unchanged: number; moved: number; missing: number; refused: number };
}

/** Request and response shapes: GET /api/learn/passage, at most 200 lines. */
export interface Passage {
  sourceId: string;
  path: string;
  from: number;
  to: number;
  lines: string[];
  heading: string | null;
  fileChanged: boolean;
}
