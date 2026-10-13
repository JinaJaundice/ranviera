// The regions of the brain view and the mapping from a node to its region. The source of truth is docs/BRAIN.md
// (table "Regions" and the paragraph on domains). The server and the web app both import this file, so it holds
// no enum and no import beyond a type, which lets Node run it as it stands.
import type { GraphNode } from "./types.ts";

export type RegionId =
  | "prefrontal"
  | "language"
  | "occipital"
  | "motor"
  | "parietal"
  | "memory"
  | "basal"
  | "thalamus"
  | "cerebellum"
  | "brainstem";

export interface RegionDef {
  id: RegionId;
  /** the category name shown on captions, labels, the legend and the trail (docs/BRAIN.md, revision of 6 October 2026) */
  label: string;
  /** what the region holds, in plain words */
  holds: string;
  /** the anatomical name, shown only as a second line in the legend */
  name: string;
  /** what the anatomical region does, in the words of its source */
  func: string;
  source: string;
}

export const REGIONS: RegionDef[] = [
  { id: "prefrontal", label: "Rules and decisions", holds: "Instruction files, rule files, skills, references, sections, rules, path scopes and decisions, and for a deployed agent its instruction versions, policies, clauses, obligations, mappings and decisions", name: "Prefrontal cortex", func: "Planning, reasoning and problem solving", source: "Queensland Brain Institute, Lobes of the brain" },
  { id: "language", label: "Writing and vocabulary", holds: "Concepts, concept schemes, the output style and the writing rules, and the typologies, risk indicators and stated rationale of a deployed agent", name: "Language areas", func: "Broca's area shapes speech and Wernicke's area supports understanding", source: "NIDCD, Aphasia, March 2025" },
  { id: "occipital", label: "Decks and visuals", holds: "Templates and the deck, chart and design rules", name: "Occipital lobe", func: "The major visual processing centre", source: "Queensland Brain Institute, Lobes of the brain" },
  { id: "motor", label: "Tools and scripts", holds: "Tools, built-in tools, launch configurations and the tool calls of an agent run", name: "Motor cortex", func: "The main region for voluntary movement", source: "Queensland Brain Institute, Lobes of the brain" },
  { id: "parietal", label: "Projects and deliverables", holds: "Projects, apps, deliverables, folders, backlog sections, open items, organisations, clients, people, roles, instruments and legislative provisions", name: "Parietal lobe", func: "Brings sensory information together", source: "Queensland Brain Institute, Lobes of the brain" },
  { id: "memory", label: "Memory and history", holds: "Memory files, record stores and history files, and the evidence, knowledge sources and ledger entries of agent runs", name: "Temporal lobe and hippocampus", func: "Where memory is formed", source: "Queensland Brain Institute, Lobes of the brain and Limbic system" },
  { id: "basal", label: "Checks and gates", holds: "Gates, fault checks and findings, and the controls, control frameworks, reviews, samples, back-tests and test scripts", name: "Basal ganglia", func: "Select and start actions", source: "Coizet and Ambroggi 2024" },
  { id: "thalamus", label: "Task routing", holds: "Task types and routes", name: "Thalamus", func: "Relays incoming signals to the cortex", source: "Queensland Brain Institute, Forebrain" },
  { id: "cerebellum", label: "Agents", holds: "Agents, deployed agents, model versions, runs and steps", name: "Cerebellum", func: "Coordinates movement", source: "Queensland Brain Institute, Hindbrain" },
  { id: "brainstem", label: "Hooks and schedules", holds: "Hooks and scheduled tasks", name: "Brainstem", func: "Runs vital functions such as breathing without conscious control", source: "Queensland Brain Institute, Hindbrain" },
];

export const REGION_IDS: RegionId[] = REGIONS.map((r) => r.id);

export interface BrainDomains {
  writing: string[];
  visual: string[];
}

/** The word lists of docs/BRAIN.md. The configuration key brain_domains replaces them. */
export const DEFAULT_BRAIN_DOMAINS: BrainDomains = {
  writing: ["writ", "voice", "register", "style", "tone", "prose", "lexicon"],
  visual: ["deck", "slide", "visual", "chart", "figure", "poster", "design", "template"],
};

/** The class of each node and the region it belongs to, by the table in docs/BRAIN.md. */
export const CLASS_REGION: Record<string, RegionId> = {
  InstructionFile: "prefrontal",
  MapFile: "prefrontal",
  RuleFile: "prefrontal",
  Skill: "prefrontal",
  ReferenceFile: "prefrontal",
  GuideFile: "prefrontal",
  Section: "prefrontal",
  Rule: "prefrontal",
  PathScope: "prefrontal",
  Decision: "prefrontal",
  OutputStyle: "language",
  Concept: "language",
  ConceptScheme: "language",
  Template: "occipital",
  Tool: "motor",
  BuiltinTool: "motor",
  LaunchConfig: "motor",
  Project: "parietal",
  App: "parietal",
  Deliverable: "parietal",
  Folder: "parietal",
  BacklogSection: "parietal",
  OpenItem: "parietal",
  Organisation: "parietal",
  Client: "parietal",
  Person: "parietal",
  Instrument: "parietal",
  MemoryFile: "memory",
  RecordStore: "memory",
  HistoryFile: "memory",
  Gate: "basal",
  FaultCheck: "basal",
  Finding: "basal",
  TaskType: "thalamus",
  Route: "thalamus",
  Agent: "cerebellum",
  Hook: "brainstem",
  ScheduledTask: "brainstem",
  // the agent transparency classes of docs/ONTOLOGY.md (7 October 2026)
  DeployedAgent: "cerebellum",
  ModelVersion: "cerebellum",
  Run: "cerebellum",
  Step: "cerebellum",
  ToolCall: "motor",
  InstructionVersion: "prefrontal",
  PolicyClause: "prefrontal",
  Mapping: "prefrontal",
  AgentDecision: "prefrontal",
  Obligation: "prefrontal",
  PolicyException: "prefrontal",
  Policy: "prefrontal",
  StatedRationale: "language",
  Typology: "language",
  RiskIndicator: "language",
  KnowledgeSource: "memory",
  Evidence: "memory",
  LedgerEntry: "memory",
  Review: "basal",
  Sample: "basal",
  BackTest: "basal",
  TestScript: "basal",
  TestStep: "basal",
  Requirement: "basal",
  Control: "basal",
  ControlFramework: "basal",
  LegislativeProvision: "parietal",
  OrganisationalRole: "parietal",
};

/** The instruction classes, whose domain comes from the path of the file that contains them. */
const DOMAIN_CLASSES = new Set(["InstructionFile", "MapFile", "RuleFile", "Skill", "ReferenceFile", "GuideFile", "Section", "Rule"]);

const reported = new Set<string>();

/** True when the path holds one of the words at the start of a word, eg "writ" in "rules/writing.md" but not in "rewrite". */
export function pathMatches(path: string, words: string[]): boolean {
  const p = path.toLowerCase();
  return words.some((w) => {
    const word = w.toLowerCase();
    if (!word) return false;
    let at = p.indexOf(word);
    while (at >= 0) {
      const before = at === 0 ? "" : p[at - 1];
      if (!/[a-z]/.test(before)) return true;
      at = p.indexOf(word, at + 1);
    }
    return false;
  });
}

/**
 * The region of a node. An instruction node takes its domain from the path of the file that contains it: the writing
 * words give the language region, the visual words the occipital region, and anything else the prefrontal region. A
 * class that the table does not name goes to the prefrontal region and is reported once.
 */
export function regionOf(
  node: Pick<GraphNode, "type"> & { path?: string | null },
  containerPath?: string | null,
  domains: BrainDomains = DEFAULT_BRAIN_DOMAINS,
): RegionId {
  const base = CLASS_REGION[node.type];
  if (!base) {
    if (!reported.has(node.type)) {
      reported.add(node.type);
      console.warn(`brain: the class ${node.type} has no region in docs/BRAIN.md, so its nodes are placed in the prefrontal region`);
    }
    return "prefrontal";
  }
  if (!DOMAIN_CLASSES.has(node.type)) return base;
  const path = containerPath ?? node.path ?? "";
  if (path && pathMatches(path, domains.writing)) return "language";
  if (path && pathMatches(path, domains.visual)) return "occipital";
  return base;
}

// ------------------------------------------------------------------- clusters

/** A cluster is the container that a node belongs to inside its region: a file, a project, a type or the node itself. */
export interface ClusterRef {
  key: string;
  label: string;
}

type ClusterNode = Pick<GraphNode, "type" | "id" | "label"> & { path?: string | null; props?: Record<string, unknown> };

const FILE_CLASSES = new Set(["InstructionFile", "MapFile", "RuleFile", "Skill", "ReferenceFile", "GuideFile", "OutputStyle", "Section", "Rule", "Decision", "LaunchConfig", "Route"]);
const SELF_CLASSES = new Set(["Agent", "TaskType", "Hook"]);
const KIND_LABEL: Record<string, string> = {
  Project: "Projects",
  App: "Apps",
  Organisation: "Organisations",
  Client: "Clients",
  Person: "People",
  Instrument: "Instruments",
  Template: "Templates",
  RecordStore: "Record stores",
  ScheduledTask: "Scheduled tasks",
  Finding: "Findings",
  ConceptScheme: "Concept schemes",
};

const slash = (p: string): string => p.split(String.fromCharCode(92)).join("/");
const prop = (n: ClusterNode, k: string): string | null => {
  const v = n.props?.[k];
  return typeof v === "string" && v ? v : null;
};
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const stem = (name: string): string => name.replace(/\.[A-Za-z0-9]+$/, "");

/** The path of a file relative to the claude folder or the Projects folder, so that a path and a piece of evidence name one file. */
export function fileKeyOf(path: string): string {
  const s = slash(path).replace(/:\d+$/, "").toLowerCase();
  const claude = s.indexOf("/.claude/");
  if (claude >= 0) return `claude/${s.slice(claude + 9)}`;
  const projects = s.indexOf("/projects/");
  if (projects >= 0) return `projects/${s.slice(projects + 10)}`;
  return s;
}

/** The name of a file for a label: the file name without its extension, or the folder of a SKILL.md or CLAUDE.md. */
function fileLabel(path: string): string {
  const parts = slash(path).replace(/:\d+$/, "").split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? path;
  if (/^(skill|claude)\.md$/i.test(last) && parts.length > 1) return parts[parts.length - 2].replace(/^\./, "");
  return stem(last);
}

const dirOf = (path: string): string => slash(path).replace(/:\d+$/, "").split("/").slice(0, -1).join("/");
const lastSegment = (path: string): string => slash(path).split("/").filter(Boolean).pop() ?? path;

/** The slug that an open item and its backlog section share: ids read openitem:<slug>-<hash> and backlog:<slug>. */
function backlogSlug(id: string): string {
  return id.replace(/^(openitem|backlog):/, "").replace(/-[0-9a-f]{6,}$/, "");
}

/**
 * The cluster of a node: the file that holds a rule or a section, the project that holds a deliverable, the backlog
 * section that holds an open item, the type of a memory file, the kind of a tool, and the node itself for an agent,
 * a task type or a hook. `lookup` finds a node by id, so that an open item takes the name of its backlog section.
 */
export function clusterOf(node: ClusterNode, lookup?: (id: string) => ClusterNode | undefined): ClusterRef {
  const t = node.type;
  const self = (): ClusterRef => ({ key: `self:${node.id}`, label: node.label });
  if (SELF_CLASSES.has(t)) return self();
  if (FILE_CLASSES.has(t)) {
    const path = node.path ?? null;
    if (path) return { key: `file:${fileKeyOf(path)}`, label: fileLabel(path) };
    const fileKey = prop(node, "file_key");
    return fileKey ? { key: `file:${fileKey.toLowerCase()}`, label: fileKey } : self();
  }
  switch (t) {
    case "PathScope": {
      const ev = prop(node, "evidence");
      return ev ? { key: `file:${fileKeyOf(ev)}`, label: fileLabel(ev) } : self();
    }
    case "Concept": {
      const ev = prop(node, "evidence");
      return ev ? { key: `concepts:${fileKeyOf(ev)}`, label: fileLabel(ev) } : { key: "concepts:other", label: "Concepts" };
    }
    case "HistoryFile": {
      const dir = node.path ? dirOf(node.path) : "";
      return dir ? { key: `history:${fileKeyOf(dir)}`, label: lastSegment(dir) } : { key: "history:other", label: "History" };
    }
    case "Folder": {
      const dir = node.path ? dirOf(node.path) : "";
      return dir ? { key: `folder:${fileKeyOf(dir)}`, label: lastSegment(dir) } : { key: "folder:other", label: "Folders" };
    }
    case "Deliverable": {
      let folder = prop(node, "folder");
      if (!folder && node.path) folder = slash(node.path).split("/deliverables/")[1]?.split("/")[0] ?? null;
      return folder ? { key: `project:${folder.toLowerCase()}`, label: folder } : { key: "project:other", label: "Other deliverables" };
    }
    case "BacklogSection":
    case "OpenItem": {
      const slug = backlogSlug(node.id);
      const named = t === "BacklogSection" ? node.label : lookup?.(`backlog:${slug}`)?.label;
      const label = (named ?? slug.replace(/-/g, " ")).replace(/^\d+\.\s*/, "");
      return { key: `backlog:${slug}`, label };
    }
    case "MemoryFile": {
      const kind = prop(node, "memoryType") ?? "other";
      return { key: `memory:${kind}`, label: `${cap(kind)} memory files` };
    }
    case "Tool": {
      const scope = prop(node, "scope") ?? "other";
      return { key: `tool:${scope}`, label: `${cap(scope)} tools` };
    }
    case "BuiltinTool": {
      const origin = prop(node, "origin") ?? "claude";
      return { key: `builtin:${origin}`, label: "Built-in tools" };
    }
    case "Gate": {
      const kind = prop(node, "kind") ?? "other";
      return { key: `gate:${kind}`, label: `${cap(kind)} gates` };
    }
    case "FaultCheck": {
      const script = prop(node, "script") ?? "other";
      return { key: `fault:${script.toLowerCase()}`, label: `${lastSegment(script)} checks` };
    }
    default:
      return { key: `kind:${t}`, label: KIND_LABEL[t] ?? t };
  }
}
