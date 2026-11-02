// The defaults table of docs/CONTRACTS.md ("Cortex extension files"), one row for each kind of linked root.
import type { Sensitivity, SourceKind, SourceRoot } from "../../../../shared/learn/sources.ts";

export interface KindDefaults {
  include: string[];
  exclude: string[];
  sensitivity: Sensitivity;
}

export const KIND_DEFAULTS: Record<SourceKind, KindDefaults> = {
  notes: {
    include: ["**/*.md", "**/*.markdown", "**/*.txt"],
    exclude: [".obsidian/**", ".git/**", "node_modules/**", ".trash/**"],
    sensitivity: "internal",
  },
  pdf: { include: ["**/*.pdf"], exclude: [], sensitivity: "internal" },
  "claude-memory": { include: ["*.md"], exclude: ["MEMORY.md"], sensitivity: "client-confidential" },
  "claude-transcripts": { include: ["*.jsonl"], exclude: [], sensitivity: "client-confidential" },
  "claude-instructions": {
    include: ["CLAUDE.md", "rules/**/*.md", "skills/**/SKILL.md"],
    exclude: ["skills/synced/**"],
    sensitivity: "internal",
  },
  "projects-md": {
    include: ["**/*.md"],
    exclude: ["node_modules/**", "archive/**", "_work/**", ".git/**"],
    sensitivity: "client-confidential",
  },
  learnharness: {
    include: ["graph/nodes.jsonl", "graph/chains.jsonl", "graph/sources.json", "chats/*.json"],
    exclude: [],
    sensitivity: "internal",
  },
};

export const SOURCE_KINDS = Object.keys(KIND_DEFAULTS) as SourceKind[];
export const SENSITIVITIES: Sensitivity[] = ["public", "internal", "client-confidential"];

export const isSourceKind = (v: unknown): v is SourceKind => typeof v === "string" && (SOURCE_KINDS as string[]).includes(v);
export const isSensitivity = (v: unknown): v is Sensitivity => typeof v === "string" && (SENSITIVITIES as string[]).includes(v);

/** The globs a scan applies: the include of the root, or the defaults of the kind when it is empty, and the excludes added to the defaults. */
export function effectiveGlobs(root: Pick<SourceRoot, "kind" | "include" | "exclude">): { include: string[]; exclude: string[] } {
  const d = KIND_DEFAULTS[root.kind];
  return { include: root.include.length ? root.include : d.include, exclude: [...d.exclude, ...root.exclude] };
}
