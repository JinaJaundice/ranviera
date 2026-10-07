// Pure helpers for the Query window: reading a fact in plain words, mapping result cells and grouping by rule.
import type { InferredFact, InferredRule, SparqlResult, SparqlTerm } from "@shared/types";

export const MAX_DEPTH = 8;

export interface ParsedFact {
  predicate: string;
  args: string[];
}

/** Splits a fact such as edge("a","restates","b") into its predicate and unquoted arguments. Returns null for text that is not a fact. */
export function parseFact(text: string): ParsedFact | null {
  const m = /^\s*([A-Za-z_][\w]*)\s*\((.*)\)\s*$/s.exec(text);
  if (!m) return null;
  const args: string[] = [];
  let cur = "";
  let quote = false;
  let angle = 0;
  const flush = () => {
    let a = cur.trim();
    if (a.length >= 2 && a.startsWith('"') && a.endsWith('"')) a = a.slice(1, -1);
    else if (a.length >= 2 && a.startsWith("<") && a.endsWith(">")) a = a.slice(1, -1);
    args.push(a);
    cur = "";
  };
  for (const ch of m[2]) {
    if (ch === '"') quote = !quote;
    else if (!quote && ch === "<") angle++;
    else if (!quote && ch === ">") angle = Math.max(0, angle - 1);
    if (ch === "," && !quote && angle === 0) flush();
    else cur += ch;
  }
  if (cur.trim() !== "" || args.length > 0) flush();
  return { predicate: m[1], args };
}

/** The fact inside a negated body atom such as `not edge("a","r","b")`, `~edge(...)` or `not(edge(...))`, or null where the text is not negated. */
export function negatedFact(text: string): string | null {
  const t = text.trim();
  const m = /^not\s*\((.+)\)$/s.exec(t) ?? /^(?:not\s+|~\s*)(.+)$/s.exec(t);
  if (!m) return null;
  const inner = m[1].trim();
  return parseFact(inner) ? inner : null;
}

export type Segment = { kind: "text"; text: string } | { kind: "node"; id: string };

/** Turns a relation id such as supersedesChain into words, supersedes chain. */
export function relationWords(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/** A fact in plain words, as text and node segments. A fact that has no wording is shown in its own form. */
export function factWords(text: string, isNode: (id: string) => boolean): Segment[] {
  const f = parseFact(text);
  const t = (s: string): Segment => ({ kind: "text", text: s });
  const arg = (s: string): Segment => (isNode(s) ? { kind: "node", id: s } : t(s));
  if (!f) return [t(text)];
  const a = f.args;
  switch (f.predicate) {
    case "edge":
    case "inferred":
      if (a.length === 3) return [arg(a[0]), t(` ${relationWords(a[1])} `), arg(a[2])];
      break;
    case "node":
      if (a.length === 2) return [arg(a[0]), t(` is of class ${a[1]}`)];
      break;
    case "status":
      if (a.length === 2) return [arg(a[0]), t(` has the status ${a[1]}`)];
      break;
    case "day":
      if (a.length === 2) return [arg(a[0]), t(` is dated ${a[1]}`)];
      break;
    case "active":
      if (a.length === 1) return [arg(a[0]), t(" is active")];
      break;
    case "overrides":
      if (a.length === 2) return [arg(a[0]), t(" overrides "), arg(a[1])];
      break;
    case "violation":
    case "warning":
    case "info":
      if (a.length === 2) {
        const verb = f.predicate === "violation" ? "breaks" : f.predicate === "warning" ? "raises a warning under" : "is noted under";
        return [arg(a[1]), t(` ${verb} check ${a[0]}`)];
      }
      break;
    default:
  }
  const out: Segment[] = [t(`${f.predicate} of `)];
  a.forEach((x, i) => {
    if (i > 0) out.push(t(", "));
    out.push(arg(x));
  });
  return out;
}

export function segmentsText(segs: Segment[], label: (id: string) => string = (id) => id): string {
  return segs.map((s) => (s.kind === "text" ? s.text : label(s.id))).join("");
}

export type Cell =
  | { kind: "node"; id: string; value: string }
  | { kind: "iri"; value: string }
  | { kind: "literal"; value: string };

/** Maps one result term to what a table cell shows. */
export function cellView(term: SparqlTerm | undefined): Cell {
  if (!term) return { kind: "literal", value: "" };
  if (term.node) return { kind: "node", id: term.node, value: term.value };
  if (term.type === "uri") return { kind: "iri", value: term.value };
  return { kind: "literal", value: term.value };
}

/** The distinct node ids that a result holds, in order of appearance. */
export function resultNodeIds(r: SparqlResult): string[] {
  const seen = new Set<string>();
  const take = (t: SparqlTerm | undefined) => {
    if (t?.node) seen.add(t.node);
  };
  if (r.kind === "select") r.rows.forEach((row) => r.vars.forEach((v) => take(row[v])));
  else if (r.kind === "construct") r.triples.forEach((tr) => tr.forEach(take));
  return [...seen];
}

export interface RuleGroup {
  id: string;
  rule: InferredRule | null;
  kind: InferredRule["kind"] | string;
  message: string;
  facts: InferredFact[];
}

const KIND_ORDER = ["violation", "warning", "info", "inference"];

/** Groups facts by the rule that derived them, most serious kind first. */
export function groupByRule(facts: InferredFact[], rules: InferredRule[]): RuleGroup[] {
  const byRule = new Map(rules.map((r) => [r.id, r]));
  const groups = new Map<string, RuleGroup>();
  for (const f of facts) {
    let g = groups.get(f.rule);
    if (!g) {
      const rule = byRule.get(f.rule) ?? null;
      g = { id: f.rule, rule, kind: rule?.kind ?? f.kind, message: rule?.message ?? "", facts: [] };
      groups.set(f.rule, g);
    }
    g.facts.push(f);
  }
  const rank = (k: string) => {
    const i = KIND_ORDER.indexOf(k);
    return i < 0 ? KIND_ORDER.length : i;
  };
  return [...groups.values()].sort((a, b) => rank(a.kind) - rank(b.kind) || a.id.localeCompare(b.id));
}

export function kindTone(kind: string): "block" | "hold" | "pass" {
  return kind === "violation" ? "block" : kind === "warning" ? "hold" : "pass";
}

export const KIND_LABEL: Record<string, string> = {
  violation: "Violation",
  warning: "Warning",
  info: "Information",
  inference: "Inference",
};
