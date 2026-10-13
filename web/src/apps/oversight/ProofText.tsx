// A proof in sentences for a reader who is not an engineer: no rule codes, no predicate names, no raw dates.
import type { ProofNode } from "@shared/types";
import { useStore } from "../../lib/store";
import { negatedFact, parseFact } from "../query/format";
import { agentName, longDate, personName, relationWord } from "./model";
import { usePeople } from "./people";
import { modelName } from "./wording";

type Label = (id: string) => string;

const EDGE_WORD: Record<string, string> = {
  performedBy: "was performed by",
  ranOn: "ran on",
  operatesUnder: "operates under",
  appliesTo: "applies to",
  approvedBy: "was approved by",
  proposedBy: "was made by",
  conflictsWith: "conflicts with",
  drawsOn: "draws on",
  detects: "detects",
};

const NEGATED: Record<string, (a: string[], l: Label) => string> = {
  has_cited: (a, l) => `${l(a[0])} cites no instruction`,
  has_control: (a, l) => `${l(a[0])} has no control that satisfies it`,
  has_clause_link: (a, l) => `${l(a[0])} has no ratified link to a policy clause`,
  expired: (a, l) => `${l(a[0])} has not expired`,
  ended: (a, l) => `${l(a[0])} has not ended`,
  exempt: (a, l) => `${l(a[0])} has no ratified exemption for ${l(a[1] ?? "")}`,
  approved_model: (a, l) => `${l(a[1] ?? "")} is not an approved model of ${l(a[0])}`,
  detected: (a, l) => `No in-force instruction detects ${l(a[0])}`,
  has_evidence: (a, l) => `${l(a[0])} has no recorded evidence`,
};

/** Reads a date written as 20260701 or 2026-07-01. */
function dateWords(s: string): string {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  return m ? longDate(`${m[1]}-${m[2]}-${m[3]}`) : s;
}

/** One fact in a sentence, or null where the fact adds nothing for a reader. */
export function factSentence(fact: string, label: Label): string | null {
  const absent = negatedFact(fact);
  if (absent) {
    const f = parseFact(absent);
    if (!f) return null;
    const make = NEGATED[f.predicate];
    return make ? make(f.args, label) : `No record shows that ${f.predicate.replace(/_/g, " ")} holds for ${f.args.map(label).join(" and ")}`;
  }
  const f = parseFact(fact);
  if (!f) return fact;
  const a = f.args;
  switch (f.predicate) {
    case "node":
      return null;
    case "edge":
    case "inferred":
      return a.length === 3 ? `${label(a[0])} ${EDGE_WORD[a[1]] ?? relationWord(a[1])} ${label(a[2])}` : null;
    case "status":
      return `${label(a[0])} is ${a[1]}`;
    case "day":
      return `${label(a[0])} is dated ${dateWords(a[1])}`;
    case "valid_from":
      return `${label(a[0])} is valid from ${dateWords(a[1])}`;
    case "valid_to":
      return `${label(a[0])} is valid until ${dateWords(a[1])}`;
    case "today":
      return `The check used the date ${dateWords(a[0])}`;
    case "in_force":
      return `${label(a[0])} is in force`;
    case "applicable":
      return `${label(a[0])} applies to ${label(a[1] ?? "")}`;
    case "conflict":
      return `${label(a[0])} conflicts with ${label(a[1] ?? "")}`;
    case "loaded_hash":
      return `The text of ${label(a[1] ?? "")} that the agent loaded has a recorded fingerprint`;
    case "approved_hash":
      return `The approved text of ${label(a[0])} has a different recorded fingerprint`;
    case "anchor":
      return `${label(a[0])} recorded a fingerprint of its ${a[1] === "s" ? "source" : "target"} when it was ratified`;
    case "end_hash":
      return `The ${a[1] === "s" ? "source" : "target"} of ${label(a[0])} now has a different fingerprint`;
    default:
      return `${f.predicate.replace(/_/g, " ")}: ${a.map(label).join(", ")}`;
  }
}

/** The identifiers that a fact names, for the title attribute of its sentence. */
function factIds(fact: string): string[] {
  const f = parseFact(negatedFact(fact) ?? fact);
  return f ? [...new Set(f.args.filter((a) => /^[a-z]+:\S+$/.test(a)))] : [];
}

/** The sentences already shown in one proof, so that a fact stated twice by two rules is shown once. */
type Seen = Set<string>;

function Level({ node, label, seen }: { node: ProofNode; label: Label; seen: Seen }) {
  const sentence = factSentence(node.fact, label)?.replace(/(.)The obligation\b/g, "$1the obligation") ?? null;
  const kids = node.children.filter((c) => c);
  if (!sentence || seen.has(sentence)) {
    return <>{kids.map((c, i) => <Level key={i} node={c} label={label} seen={seen} />)}</>;
  }
  seen.add(sentence);
  return (
    <li className="min-w-0">
      <p className="text-body text-ink" title={factIds(node.fact).join(". ") || undefined}>{sentence}.</p>
      {kids.length ? (
        <ul className="ml-3 mt-1 space-y-1 border-l border-rule pl-3">
          {kids.map((c, i) => <Level key={i} node={c} label={label} seen={seen} />)}
        </ul>
      ) : null}
    </li>
  );
}

/** The proof of a finding as a list of sentences. The top fact is the finding itself, so only what it rests on is listed. */
export function ProofText({ proof }: { proof: ProofNode }) {
  const byId = useStore((s) => s.byId);
  const people = usePeople();
  const seen: Seen = new Set();
  const named = new Set<string>();
  const label: Label = (id) => {
    // a long obligation name is given in full once and is then called the obligation, so that each line is short to scan
    if (byId.get(id)?.type === "Obligation") {
      if (named.has(id)) return "The obligation";
      named.add(id);
    }
    if (/^adec:/.test(id)) return "The decision";
    if (/^run:/.test(id)) return "The run";
    if (/^dagent:/.test(id)) return agentName(byId.get(id)?.label ?? id);
    if (/^person:/.test(id)) return personName(people, id);
    if (/^model:/.test(id)) return modelName(byId.get(id)?.label ?? id);
    const n = byId.get(id);
    const bare = id.replace(/^[a-z]+:/, "");
    // a node whose label is only its identifier reads as the identifier in words
    return n?.label && n.label !== id && n.label !== bare ? n.label : bare.replace(/[-_]+/g, " ");
  };
  const kids = proof.children;
  return (
    <div className="min-w-0">
      <p className="mb-1 text-small text-ink-soft">What the record shows</p>
      {kids.length ? (
        <ul className="min-w-0 space-y-1">
          {kids.map((c, i) => <Level key={i} node={c} label={label} seen={seen} />)}
        </ul>
      ) : (
        <p className="text-small text-ink-faint">The check holds no further steps for this finding.</p>
      )}
    </div>
  );
}
