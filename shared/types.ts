// Shared data shapes. The source of truth is docs/CONTRACTS.md, and a change
// is made there first.

import type { BrainDomains } from "./brain.ts";

export type Family = "instruction" | "machinery" | "record" | "work" | "world" | "language";
export type Sensitivity = "public" | "internal" | "client-confidential";

export interface ClassDef {
  id: string;
  label: string;
  parent: string | null;
  family: Family;
  description: string;
}

export interface RelationDef {
  id: string;
  label: string;
  inverse_label: string;
  weight: number;
  reverse_weight: number;
}

export interface NodeMetrics {
  uses: number;
  last_used: string | null;
  base_level: number | null;
  degree: number;
  /** rank of the base level among used nodes, 0.15 to 1, and 0 for a node never used (added 6 October 2026) */
  heat?: number;
}

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  family: Family;
  path: string | null;
  summary: string | null;
  date: string | null;
  status: string | null;
  sensitivity: Sensitivity;
  props: Record<string, unknown>;
  metrics: NodeMetrics;
}

export type Provenance = "stated" | "computed" | "ratified" | "proposed" | "inferred";

export interface GraphEdge {
  s: string;
  r: string;
  t: string;
  w: number;
  evidence: string | null;
  /** where the edge comes from (docs/CONTRACTS.md, 6 October 2026); absent in graphs built before that date */
  provenance?: Provenance;
  inferred?: true;
}

export interface GraphFile {
  v: 1;
  built: string;
  source: { claude_home: string; projects_root: string; git: string | null; host: string };
  classes: ClassDef[];
  relations: RelationDef[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  schemes: { id: string; label: string; concept_count: number }[];
  health: { errors: number; warnings: number; infos: number; checked: string };
  stats: { nodes: number; edges: number; by_class: Record<string, number> };
}

export interface IndexFile {
  v: 1;
  built: string;
  paths: Record<string, string>;
  prefixes: [string, string][];
  routes: { id: string; patterns: string[]; fires: string[] }[];
  skills: Record<string, string>;
  agents: Record<string, string>;
  tools: Record<string, string>;
  terms: { id: string; pattern: string; fires: string[] }[];
  faults: Record<string, string>;
  hooks: Record<string, string[]>;
  always: string[];
}

export interface RegisterDay {
  day: string;
  replies: number;
  clean: number;
  faults: number;
}

export type EventKind =
  | "session.start"
  | "session.end"
  | "prompt"
  | "route"
  | "instructions"
  | "read"
  | "write"
  | "skill"
  | "agent.start"
  | "agent.stop"
  | "workflow"
  | "tool"
  | "fault"
  | "check"
  | "compile"
  | "mission.start"
  | "mission.step"
  | "mission.end";

export interface CortexEvent {
  v: 1;
  ts: string;
  session: string;
  source: "hook" | "orchestrator" | "replay" | "cortex";
  kind: EventKind;
  nodes: string[];
  weight: number;
  label: string;
  key: string | null;
  meta: Record<string, unknown>;
}

export interface Activation {
  id: string;
  a: number;
  hop: number;
  via: string | null;
}

export interface Plan {
  prompt_hash: string;
  task_types: { id: string; label: string; matched: string[] }[];
  entities: { id: string; label: string; matched: string }[];
  fire: { id: string; a: number }[];
  load: { path: string; node: string; reason: string }[];
  steps: { agent: string; purpose: string }[];
  gates: { node: string; command: string }[];
  cautions: string[];
  /** the activation of the plan, with the hop and the via node of each node, for the brain view (6 October 2026) */
  spread?: Activation[];
}

export type MissionState = "planned" | "running" | "checking" | "done" | "failed" | "stopped";

export interface MissionLine {
  ts: string;
  kind: "text" | "tool" | "result" | "error" | "system";
  text: string;
  tool?: string;
  path?: string;
}

export interface Mission {
  id: string;
  prompt: string;
  created: string;
  state: MissionState;
  plan: Plan;
  step: number;
  steps: {
    agent: string;
    purpose: string;
    state: MissionState;
    session_id: string | null;
    started: string | null;
    ended: string | null;
    cost_usd: number | null;
    files: string[];
  }[];
  lines: MissionLine[];
}

export interface HealthFinding {
  check: string;
  severity: "violation" | "warning" | "info";
  message: string;
  node: string | null;
  evidence: string | null;
}

export interface HealthFile {
  v: 1;
  checked: string;
  graph_built?: string | null;
  inferred_built?: string | null;
  /** set by the server when the health file describes an older graph than the one it holds */
  stale?: boolean;
  counts: { violation: number; warning: number; info: number };
  findings: HealthFinding[];
  drift: { checked: string; changed: string[]; missing_in_mirror: string[]; missing_in_home: string[] } | null;
}

export interface ServerStatus {
  built: string | null;
  nodes: number;
  edges: number;
  events_today: number;
  /** today's events by kind, from the event file (6 October 2026) */
  events_today_by_kind?: Record<string, number>;
  claude: { installed: boolean; logged_in: boolean; version: string | null };
  missions_running: number;
  data_dir: string;
  /** present when inferred.json exists (6 October 2026) */
  reasoning?: { engine: string | null; facts: number; built: string };
  /** the product this copy runs as, and its version (6 October 2026) */
  product?: Product;
  version?: string;
  /** the word lists of the brain regions from the configuration key brain_domains; the defaults apply when absent */
  brain_domains?: BrainDomains;
}

/** The owner's own copy runs as "cortex", and the public product as "ranviera" (docs/DISTRIBUTION.md). */
export type Product = "cortex" | "ranviera";

/** <data_dir>/setup.json: the consent given in the first run. A null time means the step has not been agreed. */
export interface SetupFile {
  v: 1;
  accepted_at: string | null;
  read_consent_at: string | null;
  hooks_installed_at: string | null;
  missions_consent_at: string | null;
  version: string;
}

export interface SetupState extends SetupFile {
  product: Product;
  claude_home: string;
  claude_home_found: boolean;
  projects_root: string | null;
  memory_dirs: string[];
  graph_built: string | null;
  counts: { nodes: number; edges: number } | null;
}

/** One hook entry that Cortex adds to ~/.claude/settings.json. */
export interface HookEntry {
  event: string;
  matcher?: string;
  command: string;
  async?: boolean;
}

export interface HooksState {
  installed: boolean;
  settings_path: string;
  entries: HookEntry[];
  backup_dir: string;
}

/** The state of the person's own Claude Code. It never holds an e-mail address, a token or a code. */
export interface ClaudeState {
  installed: boolean;
  version: string | null;
  signed_in: boolean;
  auth_method: string | null;
  plan: string | null;
  checked: string;
}

export interface LexiconConcept {
  id: string;
  prefLabel: string;
  altLabels: string[];
  hiddenLabels: string[];
  definition: string | null;
  denotes: string[];
  status: "ratified" | "proposed";
  ratified: string | null;
  severity: "warn" | "fail";
  source: string | null;
  variant_counts: Record<string, number>;
  note?: string;
}

export interface LexiconScheme {
  id: string;
  label: string;
  description: string;
  concepts: LexiconConcept[];
}

export interface LexiconHit {
  concept: string;
  found: string;
  preferred: string;
  index: number;
  severity: "warn" | "fail";
  status: "ratified" | "proposed";
}

// ---- reasoning (docs/REASONING.md, 6 October 2026)

/** A step of a proof. A negated condition appears as a child with fact "not <atom>" and rule "absent from the graph". */
export interface ProofNode {
  fact: string;
  rule: string | null;
  children: ProofNode[];
}

export interface InferredRule {
  id: string;
  kind: "violation" | "warning" | "info" | "inference";
  message: string;
  text: string;
}

export interface InferredFact {
  key: string;
  rule: string;
  kind: string;
  args: string[];
  proof: ProofNode | null;
}

export interface InferredFile {
  v: 1;
  built: string;
  engine: { name: "nemo"; version: string } | null;
  rules: InferredRule[];
  facts: InferredFact[];
  /** the one date the rules used for the whole run, as YYYY-MM-DD (6 October 2026) */
  today?: string;
  /** the graph the rules read, so that a reader can tell whether the facts describe the current graph */
  inputs?: { graph_built: string; graph_sha256: string };
  /** the helper rules that derive intermediate facts, with identifiers H01 onwards */
  helpers?: { id: string; text: string }[];
}

export interface SavedQuery {
  id: string;
  title: string;
  query: string;
}

export type SparqlTerm = { type: "uri" | "literal" | "bnode"; value: string; node?: string };

export type SparqlResult =
  | { kind: "select"; vars: string[]; rows: Record<string, SparqlTerm>[]; truncated: boolean; ms: number }
  | { kind: "ask"; value: boolean; ms: number }
  | { kind: "construct"; triples: [SparqlTerm, SparqlTerm, SparqlTerm][]; truncated: boolean; ms: number };

export type StreamMessage =
  | { type: "hello"; built: string; status: unknown }
  | { type: "fire"; event: CortexEvent; activation: Activation[] }
  | { type: "graph"; built: string }
  | { type: "mission"; id: string; state: MissionState; step?: number; line?: MissionLine }
  | { type: "heartbeat"; ts: string };
