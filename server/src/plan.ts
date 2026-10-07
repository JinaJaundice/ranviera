// Builds a plan for a prompt from the routes, the entities and the graph.
import type { GraphNode, IndexFile, Plan } from "../../shared/types.ts";
import { spread } from "./activation.ts";
import type { GraphView } from "./graph.ts";
import { sha } from "./util.ts";

const AGENT_ORDER = ["writer", "builder", "researcher", "scout", "librarian"];

const PURPOSE: Record<string, string> = {
  writer: "Draft the document",
  builder: "Make the change to the app",
  researcher: "Research the sources",
  scout: "Search the files and past chats",
  librarian: "Update the memory and the records",
  checker: "Check the work before it is handed over",
  main: "Carry out the task in the main Claude Code session",
};

function testPattern(pattern: string, text: string): string | null {
  try {
    const m = new RegExp(pattern, "i").exec(text);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

function labelOf(view: GraphView, id: string, fallback: string): string {
  return view.byId.get(id)?.label ?? fallback;
}

export function agentName(id: string, node?: GraphNode): string {
  const p = node?.props?.name;
  return typeof p === "string" && p ? p : id.replace(/^agent:/, "");
}

export function plan(prompt: string, view: GraphView, index: IndexFile): Plan {
  // Task types: every route whose patterns match gives the task: nodes it fires.
  const taskMatches = new Map<string, string[]>();
  for (const route of index.routes) {
    const matched = route.patterns.map((p) => testPattern(p, prompt)).filter((m): m is string => m !== null);
    if (matched.length === 0) continue;
    for (const id of route.fires) {
      if (!id.startsWith("task:")) continue;
      const list = taskMatches.get(id) ?? [];
      for (const m of matched) if (!list.includes(m)) list.push(m);
      taskMatches.set(id, list);
    }
  }
  if (taskMatches.size === 0) taskMatches.set("task:reply", []);
  const task_types = [...taskMatches].map(([id, matched]) => ({ id, label: labelOf(view, id, id), matched }));

  // Entities: the index terms that the prompt names.
  const entities: Plan["entities"] = [];
  const entityNodes = new Set<string>();
  for (const term of index.terms) {
    const m = testPattern(term.pattern, prompt);
    if (m === null) continue;
    const first = term.fires.find((f) => view.byId.has(f));
    entities.push({ id: term.id, label: labelOf(view, term.id, first ? labelOf(view, first, term.id) : term.id), matched: m });
    entityNodes.add(term.id);
    for (const f of term.fires) entityNodes.add(f);
  }

  // Files to read first.
  const load: Plan["load"] = [];
  const loaded = new Set<string>();
  const addLoad = (node: GraphNode | undefined, reason: string) => {
    if (!node || !node.path || loaded.has(node.id)) return;
    loaded.add(node.id);
    load.push({ path: node.path, node: node.id, reason });
  };
  for (const t of task_types) {
    // A task type may name family files, one file for each family of the task. Only the families the
    // prompt names are read, and where it names none, all are read.
    const families = (view.byId.get(t.id)?.props?.family_files ?? {}) as Record<string, string>;
    const familyFiles = new Set(Object.values(families));
    const named = new Set(Object.entries(families).filter(([term]) => entityNodes.has(term)).map(([, file]) => file));
    for (const e of view.out.get(t.id) ?? []) {
      if (e.r !== "readsFirst") continue;
      if (familyFiles.has(e.t) && named.size > 0 && !named.has(e.t)) continue;
      const why = familyFiles.has(e.t)
        ? named.size > 0
          ? `The family file for ${t.label}, because the task names ${labelOf(view, e.t, e.t)}`
          : `A family file for ${t.label}, because the task names no family and so all are read`
        : `Read first for ${t.label}`;
      addLoad(view.byId.get(e.t), why);
    }
  }
  for (const id of entityNodes) {
    const node = view.byId.get(id);
    if (!node || node.type !== "Project") continue;
    for (const e of view.out.get(id) ?? []) {
      if (e.r !== "documentedIn") continue;
      const target = view.byId.get(e.t);
      if (target && (target.type === "MemoryFile" || target.type === "BacklogSection")) addLoad(target, `Project record for ${node.label}`);
    }
  }

  // Steps: the agents that handle the task types, the checker last.
  const found = new Set<string>();
  for (const t of task_types) {
    for (const e of view.out.get(t.id) ?? []) {
      if (e.r === "handledBy") found.add(agentName(e.t, view.byId.get(e.t)));
    }
  }
  const worker = [...found].filter((a) => a !== "checker");
  worker.sort((a, b) => {
    const ia = AGENT_ORDER.indexOf(a);
    const ib = AGENT_ORDER.indexOf(b);
    return (ia < 0 ? AGENT_ORDER.length : ia) - (ib < 0 ? AGENT_ORDER.length : ib) || (a < b ? -1 : 1);
  });
  const names = found.has("checker") ? [...worker, "checker"] : worker;
  // A checker needs earlier work to check, so the main session does the work when no other agent is named.
  if (worker.length === 0) names.unshift("main");
  const steps = names.map((agent) => ({ agent, purpose: PURPOSE[agent] ?? `Carry out the work of the ${agent} agent` }));

  // Gates.
  const gates: Plan["gates"] = [];
  const gateSeen = new Set<string>();
  for (const t of task_types) {
    for (const e of view.out.get(t.id) ?? []) {
      if (e.r !== "checkedBy" || gateSeen.has(e.t)) continue;
      const g = view.byId.get(e.t);
      if (!g || g.type !== "Gate") continue;
      gateSeen.add(e.t);
      const cmd = g.props?.command;
      gates.push({ node: g.id, command: typeof cmd === "string" && cmd ? cmd : g.label });
    }
  }

  // Cautions.
  const cautions: string[] = [];
  const touched = new Set<string>([...loaded, ...entityNodes]);
  const confidential = [...touched]
    .map((id) => view.byId.get(id))
    .filter((n): n is GraphNode => !!n && n.sensitivity === "client-confidential")
    .map((n) => n.label);
  if (confidential.length) cautions.push(`This mission touches client-confidential material: ${confidential.join(", ")}.`);
  cautions.push("Sending, publishing and pushing are switched off for missions. Approve them in a normal Claude Code session.");

  // The nodes the plan fires.
  const seeds = new Set<string>();
  for (const t of task_types) if (view.byId.has(t.id)) seeds.add(t.id);
  for (const id of entityNodes) if (view.byId.has(id)) seeds.add(id);
  // A concept and the thing it names share a label (a term and the client or project it denotes can share a name), so the list keeps the
  // thing and drops the concept. Both still fire in the graph through the spread below.
  const denotedInList = (termId: string, ids: Set<string>) =>
    (view.out.get(termId) ?? []).some((e) => e.r === "denotes" && ids.has(e.t));
  const spreadAll = spread(view.adj, [...seeds].map((id) => [id, 1.0] as [string, number]), view.params);
  const ids = new Set(spreadAll.map((x) => x.id));
  const fire = spreadAll
    .filter((x) => !(x.id.startsWith("term:") && denotedInList(x.id, ids)))
    .slice(0, 40)
    .map((x) => ({ id: x.id, a: x.a }));

  return { prompt_hash: sha(prompt), task_types, entities, fire, load, steps, gates, cautions, spread: spreadAll.slice(0, 300) };
}
