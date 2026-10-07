import { describe, expect, it } from "vitest";
import type { LexiconConcept, LexiconHit, LexiconScheme } from "@shared/types";
import { decisionsNeeded, markText, orderedSchemes, otherForms, schemeName, severityWord, replacementLines } from "./model";

const concept = (over: Partial<LexiconConcept>): LexiconConcept => ({
  id: "term:x", prefLabel: "Milestones", altLabels: [], hiddenLabels: [], definition: null, denotes: [], status: "ratified",
  ratified: "2026-10-05", severity: "warn", source: null, variant_counts: {}, ...over,
});
const scheme = (id: string, concepts: LexiconConcept[]): LexiconScheme => ({ id, label: id, description: "", concepts });

describe("lexicon model", () => {
  it("names the schemes in plain words, with the private overlay marked", () => {
    expect(schemeName({ id: "scheme:entities", label: "x" })).toBe("Named things");
    expect(schemeName({ id: "scheme:banned-words", label: "x" })).toBe("Banned words");
    expect(schemeName({ id: "scheme:entities-private", label: "Entities" })).toBe("Named things (private)");
    expect(orderedSchemes([scheme("scheme:domain-terms", []), scheme("scheme:entities", [])]).map((s) => s.id)).toEqual(["scheme:entities", "scheme:domain-terms"]);
  });

  it("lists the other forms by count, leaving out the preferred form", () => {
    const c = concept({ variant_counts: { Milestones: 40, "Milestones TM": 3, Northstar: 12 } });
    expect(otherForms(c)).toEqual([{ form: "Northstar", count: 12 }, { form: "Milestones TM", count: 3 }]);
  });

  it("needs a decision for a proposed concept with a note or with more than one form", () => {
    const schemes = [
      scheme("scheme:entities", [
        concept({ id: "term:a", status: "proposed", note: "Check the spelling." }),
        concept({ id: "term:b", status: "proposed", variant_counts: { A: 1, B: 2 } }),
        concept({ id: "term:c", status: "proposed", variant_counts: { A: 1 } }),
        concept({ id: "term:d", status: "ratified", note: "Ignored." }),
      ]),
    ];
    expect(decisionsNeeded(schemes).map((d) => d.concept.id)).toEqual(["term:a", "term:b"]);
  });

  it("marks each hit in the text and drops an overlapping hit", () => {
    const hit = (found: string, index: number, severity: "warn" | "fail"): LexiconHit => ({ concept: "term:x", found, preferred: "Milestones", index, severity, status: "ratified" });
    const segs = markText("Use Northstar now, Northstar later", [hit("Northstar", 4, "warn"), hit("Northstar", 19, "fail"), hit("sight", 7, "warn")]);
    expect(segs.map((s) => s.text)).toEqual(["Use ", "Northstar", " now, ", "Northstar", " later"]);
    expect(segs[3].hit?.severity).toBe("fail");
  });

  it("writes one Use line for each pair and keeps the stronger severity", () => {
    const h = (severity: "warn" | "fail", index: number): LexiconHit => ({ concept: "t", found: "Northstar", preferred: "Milestones", index, severity, status: "ratified" });
    expect(replacementLines([h("warn", 0), h("fail", 20)])).toEqual([{ line: "Use Milestones for Northstar", severity: "fail" }]);
    expect(severityWord("warn")).toBe("Hold");
    expect(severityWord("fail")).toBe("Block");
  });
});
