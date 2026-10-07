// Pure helpers for the Lexicon window. Tested in model.test.ts.
import type { LexiconConcept, LexiconHit, LexiconScheme } from "@shared/types";

const NAMES: Record<string, string> = {
  "scheme:entities": "Named things",
  "scheme:house-phrases": "House phrases",
  "scheme:banned-words": "Banned words",
  "scheme:domain-terms": "Domain terms",
};

/** The plain name of a scheme. A private overlay of named things is shown as "Named things (private)". */
export function schemeName(s: Pick<LexiconScheme, "id" | "label">): string {
  if (NAMES[s.id]) return NAMES[s.id];
  if (/private/i.test(s.id) || /private/i.test(s.label)) return "Named things (private)";
  return s.label;
}

/** The order of the tabs: the 4 fixed schemes first, then any other. */
export function orderedSchemes(schemes: LexiconScheme[]): LexiconScheme[] {
  const rank = (s: LexiconScheme) => {
    const i = Object.keys(NAMES).indexOf(s.id);
    return i === -1 ? 99 : i;
  };
  return [...schemes].sort((a, b) => rank(a) - rank(b));
}

export interface Decision {
  scheme: string;
  concept: LexiconConcept;
  others: { form: string; count: number }[];
}

/** The forms in variant_counts other than the preferred form, most used first. */
export function otherForms(c: LexiconConcept): { form: string; count: number }[] {
  return Object.entries(c.variant_counts ?? {})
    .filter(([form]) => form.toLowerCase() !== c.prefLabel.toLowerCase())
    .map(([form, count]) => ({ form, count }))
    .sort((a, b) => b.count - a.count || a.form.localeCompare(b.form));
}

/** Every proposed concept with a note, or with more than one form in its variant counts. */
export function decisionsNeeded(schemes: LexiconScheme[]): Decision[] {
  const out: Decision[] = [];
  for (const s of schemes) {
    for (const c of s.concepts) {
      if (c.status !== "proposed") continue;
      const forms = Object.keys(c.variant_counts ?? {}).length;
      if (c.note || forms > 1) out.push({ scheme: schemeName(s), concept: c, others: otherForms(c) });
    }
  }
  return out;
}

export interface Segment {
  text: string;
  hit?: LexiconHit;
}

/** Split a text into plain and marked parts. Hits that overlap an earlier hit are dropped. */
export function markText(text: string, hits: LexiconHit[]): Segment[] {
  const sorted = [...hits].sort((a, b) => a.index - b.index);
  const out: Segment[] = [];
  let pos = 0;
  for (const h of sorted) {
    const end = h.index + h.found.length;
    if (h.index < pos || end > text.length) continue;
    if (h.index > pos) out.push({ text: text.slice(pos, h.index) });
    out.push({ text: text.slice(h.index, end), hit: h });
    pos = end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos) });
  return out;
}

export interface UseLine {
  line: string;
  severity: "warn" | "fail";
}

/** One "Use <preferred> for <found>" line for each distinct pair, the more serious severity kept. */
export function replacementLines(hits: LexiconHit[]): UseLine[] {
  const seen = new Map<string, UseLine>();
  for (const h of hits) {
    const key = `${h.found.toLowerCase()}|${h.preferred}`;
    const prior = seen.get(key);
    if (!prior) seen.set(key, { line: `Use ${h.preferred} for ${h.found}`, severity: h.severity });
    else if (h.severity === "fail") prior.severity = "fail";
  }
  return [...seen.values()];
}

/** Hold for a warning and block for a failure, in the words of the register checks. */
export function severityWord(s: "warn" | "fail"): string {
  return s === "fail" ? "Block" : "Hold";
}
