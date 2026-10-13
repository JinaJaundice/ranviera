// The words of the Oversight window for a reader who is not an engineer: names of checks, tools, models and steps, and the
// sentences that say what a decision rests on. Pure functions, so that each one is tested.
import type { TraceFinding } from "@shared/types";
import { NO_ACTOR_DEMO, NO_ACTOR_FIXED, plural } from "./model";

const CHECK_TITLE: Record<string, string> = {
  O01: "Obligation with no ratified chain to an instruction",
  O02: "Instruction with no ratified policy clause",
  O03: "Conflicting instructions",
  O04: "Decision with no cited instruction",
  O05: "Ratified mapping that is out of date",
  O06: "Fault in the approval of an instruction",
  O07: "Instruction used outside its dates",
  O08: "Typology that no instruction detects",
  O09: "Loaded instruction differs from the approved text",
  O10: "Run that cannot be replayed",
  O11: "Incomplete run record",
  O12: "Model version that is not approved",
  O13: "Measure outside the bound of the bank",
  O14: "Retrieved item with no verified source",
};

/** The name of a check in words. The code stays in the title attribute for those who need it. */
export const checkTitle = (code: string): string => CHECK_TITLE[code] ?? "Finding";

export const SEVERITY_NOTE: Record<TraceFinding["severity"], string> = {
  violation: "A violation breaks a control or a rule of the bank.",
  warning: "A warning needs a review but does not break a control.",
  info: "A note is for information.",
};

/** The sentence of a coverage check in the words of a financial crime reader. */
const COVERAGE_LEAD: Record<string, string> = {
  O01: "An obligation that applies to the agent has no ratified link to a control, a policy clause and an instruction in force.",
  O02: "An instruction in force has no ratified link to a policy clause.",
  O08: "A typology in scope has no instruction in force that detects it.",
};

/** A sentence about this case for a finding, or null where the message of the check is the best wording. */
export function findingLead(f: { check: string; proof?: unknown }, subject: string | null, ledgerNote: string | null): string | null {
  if (COVERAGE_LEAD[f.check]) return COVERAGE_LEAD[f.check];
  if (!subject) return null;
  const proofText = JSON.stringify(f.proof ?? "");
  switch (f.check) {
    case "O04":
      return /has_cited/.test(proofText) ? `${subject} was decided with no instruction cited at the decision step.` : null;
    case "O09":
      return `An instruction that the agent loaded for ${subject} has text that differs from the approved text.`;
    case "O11":
      return `The record of ${subject} is incomplete.${ledgerNote ? ` ${ledgerNote}` : ""}`;
    case "O12":
      return `${subject} ran on a model version that is not approved for this agent.`;
    default:
      return null;
  }
}

/** The ledger steps that a run lacks, from the notes of the ledger. */
export const missingSteps = (l: { notes?: { step: number | null }[] }): number[] => (l.notes ?? []).flatMap((n) => (n.step === null ? [] : [n.step]));

/** The text of an agent with its evidence references shown by name, such as Alert AL-2026-0001 in place of alert-AL-2026-0001. */
export function plainRationale(text: string): string {
  return text.replace(/\b(alert|customer|payment|watchlist-entry)-((?:AL|C|P|WL)-[A-Za-z0-9-]*\d)\b/g, (_m, kind: string, id: string) => evidenceName(`${kind}-${id}`));
}

/** The other instruction of a conflict, read from the proof of rule O03, or null. */
export function conflictPartner(proof: unknown, self: string): string | null {
  const walk = (n: unknown): string | null => {
    if (!n || typeof n !== "object") return null;
    const node = n as { fact?: unknown; children?: unknown };
    const m = typeof node.fact === "string" ? /^conflict\("([^"]+)", "([^"]+)"\)/.exec(node.fact) : null;
    if (m) return m[1] === self ? m[2] : m[1];
    for (const c of Array.isArray(node.children) ? node.children : []) {
      const found = walk(c);
      if (found) return found;
    }
    return null;
  };
  return walk(proof);
}

const capital = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The name of a tool call for a reader, such as Read the alert queue. */
export function toolName(tool: string): string {
  const words = (s: string) => s.replace(/[-_]+/g, " ");
  const m = /^(.+)-(read|lookup)$/.exec(tool);
  if (m) return m[2] === "read" ? `Read the ${words(m[1])}` : `Look up the ${words(m[1])}`;
  return capital(words(tool));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A model version without its month, such as Triage model, version 2. */
export function modelShort(idOrLabel: string): string {
  const bare = idOrLabel.replace(/^model:/, "");
  const m = /^[a-z]+-([a-z]+)-(\d+)-\d{4}-\d{2}$/.exec(bare);
  return m ? `${capital(m[1])} model, version ${m[2]}` : modelName(idOrLabel);
}

/** A model version for a reader, such as Triage model, version 2 (September 2026). */
export function modelName(idOrLabel: string): string {
  const bare = idOrLabel.replace(/^model:/, "");
  const m = /^[a-z]+-([a-z]+)-(\d+)-(\d{4})-(\d{2})$/.exec(bare);
  const month = m ? MONTHS[Number(m[4]) - 1] : undefined;
  return m && month ? `${capital(m[1])} model, version ${m[2]} (${month} ${m[3]})` : capital(bare.replace(/[-_]+/g, " "));
}

const EVIDENCE_WORD: Record<string, string> = { alert: "Alert", customer: "Customer record", payment: "Payment", "watchlist-entry": "Watchlist entry" };

/** An evidence item for a reader, such as Alert AL-2026-0001. */
export function evidenceName(label: string): string {
  const m = /^(alert|customer|payment|watchlist-entry)-(.+)$/.exec(label);
  return m ? `${EVIDENCE_WORD[m[1]]} ${m[2]}` : label;
}

const STEP_WORD: Record<string, string> = {
  start: "Start of the run",
  evidence: "Evidence read",
  retrieval: "Retrieval of records",
  rationale: "Rationale written",
  decision: "Decision",
  review: "Human review",
  end: "End of the run",
};

export const stepWord = (kind: string): string => STEP_WORD[kind] ?? capital(kind.replace(/[-_]+/g, " "));

/** The label of a statement that is derived from the record, as against one that the agent stated. */
export const WORKED_OUT = "derived from the record";

export const LINK_LEGEND =
  "Ratified means that a checker other than the maker approved the link. Proposed means that the link was suggested and no checker has ratified it yet. Missing means that no link exists.";

export type ChainState = "ratified" | "proposed" | "incomplete" | "unmapped";

/** How far an instruction version is linked to policy: ratified throughout, with a link still proposed, with a link missing part way, or with no clause. */
export function chainState(links: { status: string }[]): ChainState {
  if (links.length === 0 || (links.length === 1 && links[0].status === "missing")) return "unmapped";
  if (links.some((l) => l.status === "missing")) return "incomplete";
  if (links.some((l) => l.status === "proposed")) return "proposed";
  return "ratified";
}

interface CitedLike {
  id: string;
  label: string;
  in_force: boolean;
  self_approved?: boolean;
}

/** Plain sentences that say whether the cited instructions support the decision. */
export function basisSentences(cited: CitedLike[], chains: Record<string, { status: string }[]>): string[] {
  if (cited.length === 0) return ["The agent cited no instruction at the decision step, so the record gives no basis for the decision."];
  const count: Record<ChainState, number> = { ratified: 0, proposed: 0, incomplete: 0, unmapped: 0 };
  for (const c of cited) count[chainState(chains[c.id] ?? [])]++;
  const who = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
  const parts: string[] = [];
  if (count.ratified) parts.push(`${who(count.ratified, "is", "are")} linked to a clause, a control and an obligation by ratified links only`);
  if (count.proposed) parts.push(`${who(count.proposed, "has", "have")} links that are proposed and that no checker has ratified`);
  if (count.incomplete) parts.push(`${who(count.incomplete, "has", "have")} a clause but no complete chain to a control and an obligation`);
  if (count.unmapped) parts.push(`${who(count.unmapped, "has", "have")} no mapped policy clause`);
  const out = [`The agent cited ${plural(cited.length, "instruction")}. ${parts.map(capital).join(". ")}.`];
  if (count.proposed + count.incomplete + count.unmapped > 0) {
    out.push("The decision therefore rests in part on an instruction whose link to policy is not approved. No check raises this as a finding of this run. The Coverage tab lists the instruction versions in force today that lack a ratified clause, and lists versions that have since been replaced under Earlier versions.");
  } else {
    out.push("Every cited instruction is linked to policy by ratified links.");
  }
  const late = cited.filter((c) => !c.in_force);
  if (late.length) out.push(`${late.map((c) => c.label).join(" and ")} ${late.length === 1 ? "was" : "were"} not in force.`);
  return out;
}

/** The sentence that says where the ledger of a run is broken, or null where it is whole. */
export function ledgerNote(l: { entries: number; verified: boolean | null; breaks: number; notes?: { step: number | null }[] }, steps: number): string | null {
  if (l.verified !== false) return null;
  const missing = (l.notes ?? []).flatMap((n) => (n.step === null ? [] : [n.step]));
  if (missing.length) {
    const only = l.breaks === missing.length ? " The check found no other break, so the entries it does hold chain correctly." : "";
    return `The ledger holds ${l.entries} of the ${steps} steps. ${missing.length === 1 ? `Step ${missing[0]} is` : `Steps ${missing.join(" and ")} are`} missing from it.${only}`;
  }
  return `The ledger chain of this run is broken at ${plural(l.breaks, "point")}.`;
}

/** The reason a person may not ratify, reject or reassign a mapping, or null where the person may. The server checks again. */
export function queueBlock(
  actor: { id: string; name: string; roles: string[] } | null,
  demo: boolean,
  maker: string,
  act: "ratify" | "reject" | "reassign",
): string | null {
  if (!actor) return demo ? NO_ACTOR_DEMO : NO_ACTOR_FIXED;
  if (!actor.roles.includes("checker")) return `${actor.name} is not a checker, and only a checker may ${act} a mapping.`;
  if (act !== "reassign" && actor.id === maker.replace(/^person:/, "")) return `${actor.name} made this mapping, and a checker other than its maker must ${act} it.`;
  return null;
}
