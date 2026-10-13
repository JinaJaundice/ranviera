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
  /** true when the configuration opens the demonstrator (oversight_demo), so the first run shows only the welcome step */
  demo: boolean;
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

// Agent transparency: the oversight views (docs/CONTRACTS.md, "View shapes", 7 October 2026)

export type MappingStatus = "proposed" | "ratified" | "rejected" | "superseded";

export interface MappingRecord {
  id: string;
  relation: "implementsClause" | "realises" | "satisfies" | "notDischargedBy" | "detects" | "appliesTo";
  s: string;
  t: string;
  status: MappingStatus;
  basis: string;
  origin: "reviewer" | "suggested" | "imported";
  owner: string;
  maker: string;
  checker: string | null;
  valid_from: string | null;
  valid_to: string | null;
  anchors: { s_hash: string | null; t_hash: string | null };
  reason: string | null;
  superseded_by: string | null;
  history: { ts: string; action: "propose" | "ratify" | "reject" | "edit" | "supersede" | "reassign"; by: string; note: string | null }[];
  /** the mapping file that holds the record, added by the list command */
  scope?: string;
}

export interface InstructionVersionRecord {
  id: string;
  version: number;
  text: string;
  hash: string;
  status: "draft" | "approved" | "withdrawn";
  maker: string;
  approver: string | null;
  approved_hash: string | null;
  valid_from: string | null;
  valid_to: string | null;
  conflicts_with?: string[];
  overrides?: string[];
  history: { ts: string; action: "draft" | "approve" | "withdraw"; by: string; note: string | null }[];
}

export interface RunSummary {
  run: string;
  agent: string;
  case_ref: string | null;
  ts: string;
  outcome: string | null;
  reviewed: boolean;
  override: boolean;
  findings: number;
  replayable: boolean;
}

export interface InstrRef {
  id: string;
  label: string;
  version: number | null;
  status: string | null;
  in_force: boolean;
  /** who made and who approved the version, from the instruction store, and the day of the approval */
  maker: string | null;
  approver: string | null;
  approved_on: string | null;
  /** the approver is also the maker */
  self_approved: boolean;
}

export interface ChainLink {
  mapping: string | null;
  relation: string;
  from: string;
  to: string;
  to_label: string;
  to_type: string;
  status: "stated" | "ratified" | "proposed" | "missing";
  /** from the mapping record, absent on a missing link */
  maker?: string | null;
  checker?: string | null;
  since?: string | null;
  /** on a link to a policy clause: the clause number and the name of the policy that holds it (13 October 2026) */
  clause_ref?: string | null;
  policy?: string | null;
}

export interface TraceFinding {
  check: string;
  severity: "violation" | "warning" | "info";
  node: string;
  message: string;
  proof: unknown | null;
}

export interface DecisionTrace {
  run: string;
  agent: { id: string; label: string };
  model: { id: string; status: string | null; approved: boolean; approver?: string | null; approved_on?: string | null };
  case_ref: string | null;
  decision: { id: string; outcome: string; step: number; ts: string } | null;
  review: {
    reviewer: string;
    verdict: string | null;
    override: boolean;
    override_reason: string | null;
    time_open_s: number | null;
    items_viewed: number | null;
    checks_ticked: string[];
  } | null;
  steps: {
    id: string;
    step: number;
    kind: string;
    ts: string;
    tool: string | null;
    evidence: { id: string; label: string; hash: string | null; source: string | null }[];
    in_context: InstrRef[];
    cited: InstrRef[];
    rationale: { hash: string; content_ref: string | null; text: string | null } | null;
    findings: TraceFinding[];
  }[];
  chains: Record<string, ChainLink[]>;
  findings: TraceFinding[];
  ledger: { entries: number; verified: boolean | null; breaks: number; reported?: number; notes?: { seq: number | null; step: number | null; reason: string }[] };
  replayable: boolean;
  labels: { recorded: "recorded"; loaded: "loaded"; stated: "stated by the agent, cause unverified" };
}

export interface CoverageMatrix {
  agent: string | null;
  columns: { id: string; label: string; type: "Control" | "PolicyClause" | "InstructionVersion" }[];
  rows: {
    obligation: string;
    label: string;
    provision: { id: string; label: string } | null;
    state: "covered" | "partial" | "gap" | "exempt";
    cells: Record<string, "ratified" | "proposed" | "stated">;
  }[];
  findings: TraceFinding[];
  /** 13 October 2026: approved versions no longer in force, with no ratified clause, that past decisions cited */
  earlier_versions?: { id: string; label: string; runs: number }[];
}

export interface InstructionSummary {
  id: string;
  label: string;
  agent: string;
  file: string;
  versions: number;
  latest: string;
  in_force: string | null;
  findings: number;
}

export interface InstructionDetail {
  id: string;
  label: string;
  agent: string;
  file: string;
  versions: (InstructionVersionRecord & { in_force: boolean })[];
  diff: { from: string; to: string; lines: { op: "same" | "add" | "remove"; text: string }[] } | null;
  mappings: MappingRecord[];
  findings: TraceFinding[];
  impact: { stale_mappings: string[]; decisions: { run: string; decision: string; ts: string }[] };
}

export interface MonitoringReport {
  from: string | null;
  to: string | null;
  agents: {
    id: string;
    label: string;
    /** the runs of the agent in the period, and all its recorded runs (13 October 2026) */
    runs?: number;
    runs_recorded?: number;
    decisions: number;
    reviewed: number;
    override_per_mille: number | null;
    review_seconds_mean: number | null;
    agreement_by_version: Record<string, { sampled: number; agree: number }>;
    bounds: Record<string, { min: number | null; max: number | null }>;
    drift: { kind: "instruction" | "model" | "snapshot" | "override"; detail: string; since: string }[];
    backtests: { id: string; version: string; n: number; agreement: number; false_closures: number; false_escalations: number }[];
  }[];
  findings: TraceFinding[];
}

export type OversightRole = "maker" | "checker" | "approver" | "reviewer" | "viewer";

export interface PeopleFile {
  v: 1;
  people: { id: string; name: string; roles: OversightRole[] }[];
}

/** The answer of GET /api/oversight/status. `actor` is the person id who acts, or null where none is configured. */
export interface OversightStatus {
  available: boolean;
  actor: string | null;
  demo: boolean;
  people: PeopleFile["people"];
}

/** A sample of runs that a reviewer draws, as `sample draw` prints it. */
export interface SampleRecord {
  v: 1;
  id: string;
  agent: string;
  requested: number;
  size: number;
  seed: number | null;
  risk_weighted: boolean;
  pool: number;
  drawn_by: string;
  drawn_at: string;
  runs: { run: string; weight: number; verdict: "agree" | "disagree" | null; reason: string | null; by: string | null; at: string | null }[];
}

export interface PackResult {
  path: string;
  manifest: { v: 1; created: string; files: { path: string; sha256: string; bytes: number }[] };
}
