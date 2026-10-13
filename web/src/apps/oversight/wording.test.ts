import { describe, expect, it } from "vitest";
import { agreementWords, driftText, driftView, mappingName, overrideCounts, periodText, plainIds, smallBaseNote } from "./monitorWords";
import { packPreviewText, packRuns, previewSplit, sizeText } from "./packWords";
import { personName } from "./model";
import { basisSentences, chainState, checkTitle, conflictPartner, evidenceName, findingLead, ledgerNote, missingSteps, modelName, plainRationale, queueBlock, stepWord, toolName } from "./wording";
import { factSentence } from "./ProofText";

const label = (id: string) => id.replace(/^[a-z]+:/, "");

describe("wording of the trace", () => {
  it("names checks, tools, models, evidence and steps without codes", () => {
    expect(checkTitle("O04")).toBe("Decision with no cited instruction");
    expect(checkTitle("X99")).toBe("Finding");
    expect(toolName("alert-queue-read")).toBe("Read the alert queue");
    expect(toolName("watchlist-lookup")).toBe("Look up the watchlist");
    expect(modelName("model:ngt-triage-2-2026-09")).toBe("Triage model, version 2 (September 2026)");
    expect(evidenceName("alert-AL-2026-0001")).toBe("Alert AL-2026-0001");
    expect(evidenceName("watchlist-entry-WL-0013")).toBe("Watchlist entry WL-0013");
    expect(stepWord("retrieval")).toBe("Retrieval of records");
    expect(personName([], "ranviera-matcher")).toBe("The automatic matching tool");
  });

  it("words a finding about the case", () => {
    expect(findingLead({ check: "O04", proof: { fact: "not has_cited(x)" } }, "AL-2026-0012", null)).toBe("AL-2026-0012 was decided with no instruction cited at the decision step.");
    expect(findingLead({ check: "O11" }, "AL-2026-0041", "Step 3 is missing from it.")).toBe("The record of AL-2026-0041 is incomplete. Step 3 is missing from it.");
    expect(findingLead({ check: "O01" }, "AL-2026-0041", null)).toBe("An obligation that applies to the agent has no ratified link to a control, a policy clause and an instruction in force.");
    expect(findingLead({ check: "O08" }, null, null)).toBe("A typology in scope has no instruction in force that detects it.");
    expect(findingLead({ check: "O04" }, null, null)).toBeNull();
  });

  it("locates the break in the ledger", () => {
    expect(ledgerNote({ entries: 8, verified: false, breaks: 1, notes: [{ step: 3 }] }, 9)).toBe("The ledger holds 8 of the 9 steps. Step 3 is missing from it. The check found no other break, so the entries it does hold chain correctly.");
    expect(ledgerNote({ entries: 8, verified: true, breaks: 0 }, 9)).toBeNull();
    expect(ledgerNote({ entries: 8, verified: false, breaks: 2 }, 9)).toBe("The ledger chain of this run is broken at 2 points.");
  });

  it("says whether the cited instructions are linked to policy", () => {
    const ok = [{ status: "ratified" }, { status: "ratified" }];
    const proposed = [{ status: "ratified" }, { status: "proposed" }];
    expect(chainState([])).toBe("unmapped");
    expect(chainState([{ status: "missing" }])).toBe("unmapped");
    expect(chainState([{ status: "ratified" }, { status: "missing" }])).toBe("incomplete");
    expect(chainState(proposed)).toBe("proposed");
    const cited = [
      { id: "a", label: "Compare names", in_force: true },
      { id: "b", label: "Maintain policies", in_force: true },
      { id: "c", label: "Check dates", in_force: false, self_approved: true },
    ];
    const text = basisSentences(cited, { a: [{ status: "missing" }], b: proposed, c: ok }).join(" ");
    expect(text).toContain("The agent cited 3 instructions.");
    expect(text).toContain("1 has no mapped policy clause");
    expect(text).toContain("1 has links that are proposed and that no checker has ratified");
    expect(text).toContain("not approved");
    expect(text).toContain("Check dates was not in force.");
    expect(text).toContain("Earlier versions");
    expect(basisSentences([], {})[0]).toContain("cited no instruction");
    expect(basisSentences([cited[2]], { c: ok }).join(" ")).toContain("Every cited instruction is linked to policy by ratified links.");
  });
});

describe("second pass wording", () => {
  it("shows evidence references in the text of an agent by name", () => {
    expect(plainRationale("Closed. Evidence read: alert-AL-2026-0001, customer-C-0002, payment-P-00001, watchlist-entry-WL-0002.")).toBe(
      "Closed. Evidence read: Alert AL-2026-0001, Customer record C-0002, Payment P-00001, Watchlist entry WL-0002.",
    );
    expect(plainRationale("The name matches the alias.")).toBe("The name matches the alias.");
  });

  it("reads the partner of a conflict and the missing ledger steps", () => {
    const proof = { fact: "violation(x)", rule: "O03", children: [{ fact: 'conflict("instr:a-v1", "instr:b-v1")', rule: "H27", children: [] }] };
    expect(conflictPartner(proof, "instr:a-v1")).toBe("instr:b-v1");
    expect(conflictPartner(proof, "instr:b-v1")).toBe("instr:a-v1");
    expect(conflictPartner(null, "instr:a-v1")).toBeNull();
    expect(missingSteps({ notes: [{ step: 3 }, { step: null }] })).toEqual([3]);
    expect(missingSteps({})).toEqual([]);
  });

  it("words drift entries and the base of an override rate", () => {
    const labels: Record<string, string> = { "instr:x-v1": "Compare names (version 1)", "instr:x-v2": "Compare names (version 2)" };
    const d = driftView("The instruction versions in context changed: added instr:x-v2, instr:y-v2; removed instr:x-v1, instr:y-v1.", "2026-09-21T09:56:21.000Z", (id) => labels[id]);
    expect(d.text).toBe("From 21 September 2026, 2 instruction versions in the context of the agent changed.");
    expect(d.items[0]).toBe("Compare names (version 1) was replaced by Compare names (version 2)");
    expect(d.items.length).toBe(2);
    const m = driftView("The model version changed from model:ngt-triage-3-2026-10 to model:ngt-triage-2-2026-09.", "2026-10-02T12:01:10.000Z", () => undefined);
    expect(m.text).toBe("The model changed from Triage model, version 3 to version 2 on 2 October 2026. This returns the agent to an earlier model version.");
    expect(smallBaseNote(100, 30)).toContain("33 in every 1,000");
    expect(smallBaseNote(100, 300)).toBeNull();
    expect(smallBaseNote(null, 0)).toBeNull();
  });

  it("puts the runs with a finding or an override first in a pack preview", () => {
    const run = (n: string, findings: number, override: boolean) => ({ run: n, agent: "a", case_ref: n, ts: "2026-09-02T10:00:00Z", reviewed: true, override, findings });
    const s = previewSplit([run("a", 0, false), run("b", 1, false), run("c", 0, true)]);
    expect(s.notable.map((r) => r.run)).toEqual(["b", "c"]);
    expect(s.others.map((r) => r.run)).toEqual(["a"]);
  });
});

describe("who may ratify", () => {
  const maker = { id: "teveric-halmstow", name: "Teveric Halmstow", roles: ["maker"] };
  const checker = { id: "orlen-quasby", name: "Orlen Quasby", roles: ["checker", "approver"] };
  const both = { id: "dessa", name: "Dessa", roles: ["maker", "checker"] };
  it("gives the reason or null", () => {
    expect(queueBlock(null, true, "person:x", "ratify")).toBe("Choose who is acting to ratify, reject or reassign");
    expect(queueBlock(maker, true, "teveric-halmstow", "ratify")).toBe("Teveric Halmstow is not a checker, and only a checker may ratify a mapping.");
    expect(queueBlock(checker, true, "teveric-halmstow", "ratify")).toBeNull();
    expect(queueBlock(both, true, "dessa", "reject")).toBe("Dessa made this mapping, and a checker other than its maker must reject it.");
    expect(queueBlock(both, true, "person:dessa", "reassign")).toBeNull();
  });
});

describe("proof sentences", () => {
  it("reads facts without predicate names or raw dates", () => {
    expect(factSentence('not has_cited("adec:x")', () => "The decision")).toBe("The decision cites no instruction");
    expect(factSentence('day("obligation:a", 20260701)', label)).toBe("a is dated 1 July 2026");
    expect(factSentence('edge("a", "implementsClause", "b")', label)).toBe("a implements the clause b");
    expect(factSentence('node("a", "Obligation")', label)).toBeNull();
    expect(factSentence('today(20261013)', label)).toBe("The check used the date 13 October 2026");
  });
});

describe("monitoring and pack wording", () => {
  it("replaces identifiers and explains percentages", () => {
    expect(plainIds("added instr:alert-triage-compare-names-v2, removed instr:x-v1.", (id) => (id === "instr:x-v1" ? "Old one" : undefined))).toBe("added alert triage compare names v2, removed Old one.");
    expect(plainIds("changed from model:ngt-triage-1-2026-08 to model:ngt-triage-2-2026-09.", () => undefined)).toBe("changed from Triage model, version 1 (August 2026) to Triage model, version 2 (September 2026).");
    expect(driftText("The override rate changed from 118 to 77 in thousandths of reviewed decisions (17 and 13 reviews), and no threshold was applied.", "2026-09-25", () => undefined)).toContain("118 in every 1,000 reviewed decisions before 25 September 2026 (17 reviews) and 77 in every 1,000 after it (13 reviews)");
    expect(agreementWords({ sampled: 12, agree: 11 })).toBe("11 of 12 sampled runs agreed (92%)");
    expect(agreementWords({ sampled: 1, agree: 1 })).toBe("1 of 1 sampled run agreed (100%)");
    expect(overrideCounts(100, 30)).toBe("3 overrides in 30 reviewed decisions");
    expect(overrideCounts(null, 0)).toBeNull();
    expect(periodText(null, null)).toBe("The figures cover every decision recorded.");
    expect(periodText("2026-09-01", "2026-09-30")).toBe("The figures cover decisions from 1 September 2026 to 30 September 2026.");
    expect(mappingName("map:20260922-005")).toBe("Mapping 5 of 22 September 2026");
  });

  it("works out the runs of a pack and its preview", () => {
    const runs = [
      { run: "run:a", agent: "dagent:t", case_ref: "AL-1", ts: "2026-09-02T10:00:00Z", reviewed: true, override: false, findings: 0 },
      { run: "run:b", agent: "dagent:t", case_ref: "AL-2", ts: "2026-10-02T10:00:00Z", reviewed: true, override: true, findings: 2 },
    ];
    expect(packRuns(runs, "run", "run:a", "", "").length).toBe(1);
    expect(packRuns(runs, "alert", "AL-2", "", "")[0].run).toBe("run:b");
    expect(packRuns(runs, "agent", "dagent:t", "", "").length).toBe(2);
    expect(packRuns(runs, "period", "", "2026-09-01", "2026-09-30").map((r) => r.run)).toEqual(["run:a"]);
    expect(packRuns(runs, "period", "", "", "")).toEqual([]);
    expect(packPreviewText(runs)).toBe("The pack would cover 2 runs, of which 2 were reviewed by a person and 1 was overridden. The runs carry 2 findings.");
    expect(packPreviewText([])).toContain("No run matches");
    expect(sizeText(247835)).toBe("248 KB");
    expect(sizeText(5489654)).toBe("5.5 MB");
    expect(sizeText(90)).toBe("90 bytes");
  });
});
