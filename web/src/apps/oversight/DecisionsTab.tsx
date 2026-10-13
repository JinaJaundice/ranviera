import { useState } from "react";
import { ChevronDown, ChevronRight, FileDown } from "lucide-react";
import type { ChainLink, DecisionTrace, InstrRef, RunSummary } from "@shared/types";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { Empty } from "../../components/Empty";
import { NodeChip } from "../../components/NodeChip";
import { StatusDot } from "../../components/StatusDot";
import { api } from "../../lib/api";
import { useLoad } from "./load";
import { LIMITS_NOTE, agentName, contextNotes, evidenceUpTo, longDate, nodeTypeWord, outcomeWord, plural, relationWord, shortHash, statusWord, when, type ContextNote } from "./model";
import { AgentName, Fact, FindingList, LabelTag, Loading, Person, StateChip } from "./parts";
import { LINK_LEGEND, WORKED_OUT, basisSentences, chainState, checkTitle, evidenceName, ledgerNote, missingSteps, modelName, plainRationale, stepWord, toolName, type ChainState } from "./wording";

type Trace = DecisionTrace;

const LINK_TONE: Record<ChainLink["status"], "pass" | "hold" | "block" | "idle"> = { ratified: "pass", stated: "idle", proposed: "hold", missing: "block" };

function Chain({ links }: { links: ChainLink[] }) {
  if (links.length === 0) {
    return (
      <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-small text-ink-soft">
        <StateChip tone="block">Missing</StateChip>
        This instruction version has no mapped clause, control, obligation or provision.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {links.map((l, i) => (
        <li key={`${l.from}-${l.to}-${i}`} className="flex min-w-0 flex-wrap items-center gap-1.5 text-small text-ink-soft">
          <span>{relationWord(l.relation)}</span>
          {l.status === "missing" && !l.to_label ? (
            <span className="text-ink-faint">Nothing is mapped</span>
          ) : (
            <>
              <NodeChip id={l.to} label={l.to_label} />
              <span className="text-ink-faint">{nodeTypeWord(l.to_type)}</span>
            </>
          )}
          <StateChip tone={LINK_TONE[l.status]}>{statusWord(l.status)}</StateChip>
          {l.status === "ratified" && l.checker ? <span className="text-ink-faint">Ratified by <Person id={l.checker} />{l.since ? `, valid from ${longDate(l.since)}` : ""}</span> : null}
          {l.status === "proposed" && l.maker ? <span className="text-ink-faint">Proposed by <Person id={l.maker} />, waiting for a checker</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Who made and who approved an instruction version, and when. */
function Approval({ r }: { r: InstrRef }) {
  return (
    <p className="text-small text-ink-soft">
      Made by <Person id={r.maker} />.{" "}
      {r.approver ? (
        <>
          Approved by <Person id={r.approver} />
          {r.approved_on ? ` on ${longDate(r.approved_on)}` : ""}.
        </>
      ) : (
        "Not approved."
      )}
    </p>
  );
}

function InstructionRow({ ref_, chains, startOpen }: { ref_: InstrRef; chains: Record<string, ChainLink[]>; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <li className="min-w-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 flex-wrap items-center gap-1.5 text-left text-body text-ink hover:text-signal" title={ref_.id}>
        {open ? <ChevronDown size={14} aria-hidden="true" className="shrink-0" /> : <ChevronRight size={14} aria-hidden="true" className="shrink-0" />}
        <span className="min-w-0">{ref_.label}</span>
        {ref_.status ? <Chip>{statusWord(ref_.status)}</Chip> : null}
        <Chip>{ref_.in_force ? "In force" : "Not in force"}</Chip>
        {ref_.self_approved ? (
          <StateChip tone="block">Approved by its own maker</StateChip>
        ) : null}
      </button>
      {open ? (
        <div className="ml-5 mt-1 min-w-0 space-y-1 border-l border-rule pl-3">
          <Approval r={ref_} />
          <Chain links={chains[ref_.id] ?? []} />
        </div>
      ) : null}
    </li>
  );
}

function RefList({ refs, chains, none, startOpen = false }: { refs: InstrRef[]; chains: Record<string, ChainLink[]>; none: string; startOpen?: boolean }) {
  if (refs.length === 0) return <p className="text-small text-ink-faint">{none}</p>;
  return (
    <ul className="space-y-1.5">
      {refs.map((r) => (
        <InstructionRow key={r.id} ref_={r} chains={chains} startOpen={startOpen} />
      ))}
    </ul>
  );
}

function Review({ trace }: { trace: Trace }) {
  const r = trace.review;
  return (
    <div className="min-w-0 rounded-md border border-rule p-3">
      <h4 className="text-ui font-medium text-ink">Human review</h4>
      <p className="mb-2 text-small text-ink-soft">The review is a separate act from the decision, recorded by the reviewer.</p>
      {r ? (
        <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2">
          <Fact label="Reviewer"><Person id={r.reviewer} /></Fact>
          <Fact label="Verdict">{r.verdict ? statusWord(r.verdict) : "None recorded"}</Fact>
          <Fact label="Override">{r.override ? `Yes. ${r.override_reason ?? "No reason recorded."}` : "No"}</Fact>
          <Fact label="Time open">{r.time_open_s === null ? "Not recorded" : `${r.time_open_s} seconds`}</Fact>
          <Fact label="Items viewed">{r.items_viewed ?? "Not recorded"}</Fact>
          <Fact label="Checks ticked">{r.checks_ticked.length ? r.checks_ticked.join(", ") : "None"}</Fact>
        </dl>
      ) : (
        <p className="text-body text-ink-soft">No human review is recorded for this run.</p>
      )}
    </div>
  );
}

/** The instruction versions that any step loaded, each once. */
function loadedOnce(trace: Trace): InstrRef[] {
  const seen = new Map<string, InstrRef>();
  for (const s of trace.steps) for (const i of s.in_context) if (!seen.has(i.id)) seen.set(i.id, i);
  return [...seen.values()];
}

const POLICY_CHIP: Record<ChainState, { tone: "pass" | "hold" | "block"; text: string }> = {
  ratified: { tone: "pass", text: "Ratified links to policy" },
  proposed: { tone: "hold", text: "A link is proposed, not ratified" },
  incomplete: { tone: "hold", text: "Chain to policy incomplete" },
  unmapped: { tone: "block", text: "No policy clause mapped" },
};

/** One cited instruction in a line, with who made and who approved it, and its chain to policy on request. */
function CitedRow({ r, links, day }: { r: InstrRef; links: ChainLink[]; day: string }) {
  const [open, setOpen] = useState(false);
  const policy = POLICY_CHIP[chainState(links)];
  return (
    <>
      <tr className="border-b border-rule align-top">
        <td className="min-w-0 px-2 py-1.5">
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 items-start gap-1 text-left text-body text-ink hover:text-signal" title={r.id}>
            {open ? <ChevronDown size={14} aria-hidden="true" className="mt-1 shrink-0" /> : <ChevronRight size={14} aria-hidden="true" className="mt-1 shrink-0" />}
            <span className="min-w-0">{r.label}</span>
          </button>
          <span className="ml-5 mt-0.5 flex min-w-0 flex-wrap gap-1">
            <Chip>{r.in_force ? `In force on ${longDate(day)}` : `Not in force on ${longDate(day)}`}</Chip>
            {r.self_approved ? <StateChip tone="block">Approved by its own maker</StateChip> : null}
          </span>
        </td>
        <td className="min-w-0 px-2 py-1.5 text-ink"><Person id={r.maker} /></td>
        <td className="min-w-0 px-2 py-1.5 text-ink">
          {r.approver ? (
            <>
              <Person id={r.approver} />
              {r.approved_on ? <span className="block text-caption text-ink-faint">{longDate(r.approved_on)}</span> : null}
            </>
          ) : (
            "Not approved"
          )}
        </td>
        <td className="min-w-0 px-2 py-1.5"><StateChip tone={policy.tone}>{policy.text}</StateChip></td>
      </tr>
      {open ? (
        <tr className="border-b border-rule">
          <td colSpan={4} className="px-2 py-1.5">
            <div className="ml-5 min-w-0 border-l border-rule pl-3"><Chain links={links} /></div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function CitedTable({ refs, chains, day }: { refs: InstrRef[]; chains: Record<string, ChainLink[]>; day: string }) {
  return (
    <table className="w-full min-w-0 table-fixed border-collapse text-small">
      <caption className="sr-only">Instructions that the agent cited at the decision step, with their makers, approvers and links to policy</caption>
      <thead>
        <tr className="border-b border-rule text-left text-ink-faint">
          <th scope="col" className="w-5/12 px-2 py-1.5 font-medium">Instruction</th>
          <th scope="col" className="w-2/12 px-2 py-1.5 font-medium">Made by</th>
          <th scope="col" className="w-2/12 px-2 py-1.5 font-medium">Approved by</th>
          <th scope="col" className="w-3/12 px-2 py-1.5 font-medium">Link to policy</th>
        </tr>
      </thead>
      <tbody>
        {refs.map((r) => (
          <CitedRow key={r.id} r={r} links={chains[r.id] ?? []} day={day} />
        ))}
      </tbody>
    </table>
  );
}

/** The approval check on the instructions that a run loaded: whether any was approved by its own maker, and whether the agent cited it. */
function ApprovalCheck({ loaded, citedIds }: { loaded: InstrRef[]; citedIds: Set<string> }) {
  const own = loaded.filter((i) => i.self_approved);
  return (
    <div className="min-w-0">
      <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-small text-ink-soft">
        Approval of the {plural(loaded.length, "instruction")} loaded in this run <LabelTag title="Worked out from the loaded versions and the approval records. The agent did not state it.">{WORKED_OUT}</LabelTag>
      </p>
      {own.length === 0 ? (
        <p className="text-body text-ink">A person other than its maker approved each of them.</p>
      ) : (
        own.map((i) => (
          <p key={i.id} className={`text-body ${citedIds.has(i.id) ? "text-block" : "text-ink"}`}>
            {i.label} was approved by its own maker, <Person id={i.approver} />. {citedIds.has(i.id) ? "The agent cited it at the decision step." : "The agent did not cite it at the decision step, so it does not bear on the basis above."} A different approver should have approved it, and the Instructions tab reports it as a finding.
          </p>
        ))
      )}
    </div>
  );
}

/** The basis of the decision: what the agent cited, how each citation links to policy, what it read and the rationale it wrote. */
function Basis({ trace }: { trace: Trace }) {
  const L = trace.labels;
  const at = trace.decision?.step ?? null;
  const decisionStep = at === null ? undefined : trace.steps.find((s) => s.step === at);
  const cited = decisionStep?.cited ?? [];
  const evidence = evidenceUpTo(trace.steps, at);
  const rationale = [...trace.steps].reverse().find((s) => s.rationale && (at === null || s.step <= at))?.rationale ?? null;
  const loaded = loadedOnce(trace);
  const day = trace.decision?.ts ?? decisionStep?.ts ?? "";
  return (
    <section aria-label="Basis of the decision" className="min-w-0 rounded-md border border-rule p-3">
      <h3 className="text-ui font-medium text-ink">Basis of the decision</h3>
      <p className="mb-2 text-small text-ink-soft">What the record shows about why the agent reached this decision.</p>
      <div className="min-w-0 space-y-3">
        <div className="min-w-0 space-y-1 rounded-md bg-sunken p-2">
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-small text-ink-soft">
            Summary <LabelTag title="Worked out from the cited instructions and their links. The agent did not state it.">{WORKED_OUT}</LabelTag>
          </p>
          {basisSentences(cited, trace.chains).map((t) => (
            <p key={t} className="text-body text-ink">{t}</p>
          ))}
        </div>
        <div className="min-w-0">
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-small text-ink-soft">
            Instructions the agent cited at the decision step <LabelTag title="The agent states which instructions it relied on. The record cannot verify that they caused the decision.">{L.stated}</LabelTag>
          </p>
          <p className="mb-1 text-small text-ink-faint">The agent says it relied on these instructions. The record cannot show that they caused the outcome. {LINK_LEGEND}</p>
          {cited.length ? <CitedTable refs={cited} chains={trace.chains} day={day} /> : <p className="text-small text-ink-faint">The agent cited no instruction at the decision step.</p>}
        </div>
        <div className="min-w-0">
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-small text-ink-soft">
            Evidence read <LabelTag title="The evidence reference and its hash were recorded.">{L.recorded}</LabelTag>
          </p>
          {evidence.length ? (
            <ul className="mt-1 flex min-w-0 flex-wrap gap-1.5">
              {evidence.map((e) => (
                <li key={e.id} className="min-w-0" title={`${e.source ?? "No source recorded"}, fingerprint ${shortHash(e.hash)}`}>
                  <NodeChip id={e.id} label={evidenceName(e.label)} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-small text-ink-faint">No evidence is recorded before the decision.</p>
          )}
        </div>
        <div className="min-w-0">
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-small text-ink-soft">
            Rationale written by the agent <LabelTag title="The text that the agent wrote to explain itself.">{L.stated}</LabelTag>
          </p>
          {rationale?.text ? (
            <>
              <blockquote className="mt-1 min-w-0 border-l-2 border-rule-strong pl-3 text-body text-ink" title={`Fingerprint ${shortHash(rationale.hash)}`}>
                {plainRationale(rationale.text)}
              </blockquote>
              <p className="mt-0.5 text-caption text-ink-faint">The text is the agent&apos;s own. The references in it are shown by name.</p>
            </>
          ) : rationale ? (
            <p className="text-small text-ink-faint">The text is held in the content store and is not available to this view. Its fingerprint was recorded.</p>
          ) : (
            <p className="text-small text-ink-faint">No rationale is recorded before the decision.</p>
          )}
        </div>
        <ApprovalCheck loaded={loaded} citedIds={new Set(cited.map((i) => i.id))} />
      </div>
    </section>
  );
}

/** What a reviewer can say about a decision that cites no instruction: what the agent wrote, and what the record cannot show. */
function NoCitationDetail({ trace }: { trace: Trace }) {
  const L = trace.labels;
  const at = trace.decision?.step ?? null;
  const rationale = [...trace.steps].reverse().find((s) => s.rationale?.text && (at === null || s.step <= at))?.rationale ?? null;
  const loaded = loadedOnce(trace);
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-body text-ink">
        The agent cited no instruction when it {trace.decision ? outcomeWord(trace.decision.outcome).toLowerCase() : "decided"} this case, so the record does not show which rule it applied. The owner of the agent should say which of the {plural(loaded.length, "instruction")} loaded in this run governed the decision. No check judges whether the decision itself was correct.
      </p>
      {rationale?.text ? (
        <>
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-small text-ink-soft">What the agent wrote <LabelTag title="The text that the agent wrote to explain itself.">{L.stated}</LabelTag></p>
          <blockquote className="min-w-0 border-l-2 border-rule-strong pl-3 text-body text-ink">{plainRationale(rationale.text)}</blockquote>
        </>
      ) : null}
    </div>
  );
}

function ContextBlock({ note, refs, chains, label }: { note: ContextNote; refs: InstrRef[]; chains: Record<string, ChainLink[]>; label: Trace["labels"]["loaded"] }) {
  const [open, setOpen] = useState(false);
  const title = "The instruction versions that the agent loaded. It does not show that the model weighed them.";
  const summary =
    note.kind === "full"
      ? `${plural(refs.length, "instruction")} loaded at step ${note.step}`
      : note.kind === "same"
        ? note.atStart ? "Same instructions as at the start of the run" : `Same instructions as at step ${note.from}`
        : `Changed since step ${note.from}: ${plural(note.added.length, "instruction")} added and ${plural(note.removed.length, "instruction")} removed`;
  return (
    <div className="mt-2 min-w-0">
      <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-small text-ink-soft">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 items-center gap-1 text-left hover:text-signal">
          {open ? <ChevronDown size={14} aria-hidden="true" className="shrink-0" /> : <ChevronRight size={14} aria-hidden="true" className="shrink-0" />}
          <span>{summary}</span>
        </button>
        <LabelTag title={title}>{label}</LabelTag>
        <span className="text-ink-faint">{open ? "Hide the list" : "Show the list"}</span>
      </p>
      {note.kind === "changed" && !open ? (
        <ul className="ml-5 mt-1 space-y-0.5 text-small text-ink-soft">
          {note.added.map((i) => <li key={`a-${i.id}`}>Added: {i.label}</li>)}
          {note.removed.map((i) => <li key={`r-${i.id}`}>Removed: {i.label}</li>)}
        </ul>
      ) : null}
      {open ? (
        <div className="ml-5 mt-1">
          <RefList refs={refs} chains={chains} none="No instruction was loaded at this step." />
        </div>
      ) : null}
    </div>
  );
}

function TraceView({ trace, onExport }: { trace: Trace; onExport: (run: string) => void }) {
  const L = trace.labels;
  const notes = contextNotes(trace.steps);
  const at = trace.decision?.step ?? null;
  const subject = trace.case_ref ?? "This run";
  const broken = ledgerNote(trace.ledger, trace.steps.length);
  const absent = missingSteps(trace.ledger);
  const citedNow = trace.steps.find((s) => s.step === at)?.cited ?? [];
  const uncited = citedNow.length === 0;
  const unlinked = citedNow.some((i) => chainState(trace.chains[i.id] ?? []) !== "ratified");
  return (
    <div className="min-w-0 space-y-4 p-4">
      <div className="min-w-0 rounded-md border border-rule-strong p-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <h3 className="text-ui font-medium text-ink">Decision</h3>
          <Button variant="secondary" className="h-6 shrink-0 px-2 text-small" icon={<FileDown size={14} aria-hidden="true" />} onClick={() => onExport(trace.run)}>Export the evidence pack</Button>
        </div>
        {trace.decision ? (
          <p className="text-lead text-ink">
            <span className="font-medium" title={trace.decision.outcome}>{outcomeWord(trace.decision.outcome)}</span>
            <span className="text-body text-ink-soft"> at step {trace.decision.step}, {when(trace.decision.ts)}</span>
          </p>
        ) : (
          <p className="text-body text-ink-soft">This run records no decision.</p>
        )}
        <dl className="mt-2 grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">
          <Fact label="Agent"><AgentName id={trace.agent.id} label={trace.agent.label} /></Fact>
          <Fact label="Case reference">{trace.case_ref ?? "None"}</Fact>
          <Fact label="Model version">
            <span className="block" title={trace.model.id}>{modelName(trace.model.id)}</span>
            <StateChip tone={trace.model.approved ? "pass" : "block"}>{trace.model.approved ? "On the approved list of the agent" : "Not on the approved list of the agent"}</StateChip>
            <span className="mt-0.5 block text-small text-ink-faint">The record holds the list of approved models and not who approved each model.</span>
          </Fact>
          <Fact label="Record of the steps">
            {trace.ledger.verified === null ? "Not verified" : trace.ledger.verified ? `Verified, ${plural(trace.ledger.entries, "entry", "entries")}` : broken ?? "Not verified"}
            <span className="mt-0.5 block text-small text-ink-faint" title="Ledger">The ledger lists each recorded step of the run, and each entry is linked to the one before it. Verified means that no step is missing and no link is broken.</span>
          </Fact>
        </dl>
      </div>

      <section aria-label="Findings of this run" className="min-w-0 rounded-md border border-rule p-3">
        <h3 className="flex items-center gap-1.5 text-ui font-medium text-ink">
          <StatusDot tone={trace.findings.length ? "block" : "idle"} />
          Findings of this run
          <span className="num text-small text-ink-faint">{trace.findings.length}</span>
        </h3>
        <FindingList findings={trace.findings} none={unlinked ? "No finding is open for this run. The basis below notes cited instructions that lack a ratified link to policy." : "No finding is open for this run."} subject={subject} ledgerNote={broken} detailFor={(f) => (f.check === "O04" && uncited ? <NoCitationDetail trace={trace} /> : null)} />
      </section>

      <Basis trace={trace} />

      <Review trace={trace} />

      <section aria-label="Steps" className="min-w-0">
        <h3 className="mb-2 text-ui font-medium text-ink">Steps</h3>
        <ol className="space-y-3">
          {trace.steps.map((s, i) => (
            <li key={s.id} className="min-w-0 rounded-md border border-rule p-3">
              <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-body text-ink">
                <span className="num font-medium">Step {s.step}</span>
                <span title={s.tool ? `${stepWord(s.kind)}. ${s.tool}` : s.kind}>{s.tool ? toolName(s.tool) : stepWord(s.kind)}</span>
                {s.tool ? <LabelTag title="The tool call was recorded by the hook or the gateway.">{L.recorded}</LabelTag> : null}
                <span className="text-small text-ink-faint">{when(s.ts)}</span>
                {absent.includes(s.step) ? <StateChip tone="block">Missing from the ledger</StateChip> : null}
              </p>
              {absent.includes(s.step) ? (
                <p className="mt-1 text-small text-ink-soft">The run records this step, and the ledger holds no entry for it. The step is therefore not backed by the ledger.</p>
              ) : null}
              {s.evidence.length ? (
                <div className="mt-2 min-w-0">
                  <p className="flex items-center gap-1.5 text-small text-ink-soft">
                    Evidence read <LabelTag title="The evidence reference and its hash were recorded.">{L.recorded}</LabelTag>
                  </p>
                  <ul className="mt-1 flex min-w-0 flex-wrap gap-1.5">
                    {s.evidence.map((e) => (
                      <li key={e.id} className="min-w-0" title={`${e.source ?? "No source recorded"}, fingerprint ${shortHash(e.hash)}`}>
                        <NodeChip id={e.id} label={evidenceName(e.label)} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {s.rationale?.text ? (
                <div className="mt-2 min-w-0">
                  <p className="flex items-center gap-1.5 text-small text-ink-soft">
                    Rationale <LabelTag title="The text that the agent wrote to explain itself.">{L.stated}</LabelTag>
                  </p>
                  <blockquote className="mt-1 border-l-2 border-rule-strong pl-3 text-body text-ink">{plainRationale(s.rationale.text)}</blockquote>
                </div>
              ) : null}
              <ContextBlock note={notes[i]} refs={s.in_context} chains={trace.chains} label={L.loaded} />
              {s.cited.length && s.step !== at ? (
                <div className="mt-2 min-w-0">
                  <p className="flex items-center gap-1.5 text-small text-ink-soft">
                    Instructions cited <LabelTag title="The agent states which instructions it relied on. The record cannot verify that they caused the decision.">{L.stated}</LabelTag>
                  </p>
                  <RefList refs={s.cited} chains={trace.chains} none="" />
                </div>
              ) : null}
              {s.step === at ? (
                <p className="mt-2 text-small text-ink-soft">
                  Outcome: {outcomeWord(trace.decision?.outcome)}. The instructions that the agent cited, the evidence and the rationale are set out under Basis of the decision, above.
                </p>
              ) : null}
              {s.findings.length ? (
                <p className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-small text-ink">
                  <StatusDot tone="block" />
                  The {s.findings.length === 1 ? "finding" : "findings"} {s.findings.map((f) => `'${checkTitle(f.check)}'`).join(" and ")} {s.findings.length === 1 ? "concerns" : "concern"} this step. The proof is under the findings of this run.
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      <p className="rounded-md border border-rule bg-sunken p-3 text-small text-ink-soft">{LIMITS_NOTE}</p>
    </div>
  );
}

function RunTable({ runs, chosen, onChoose }: { runs: RunSummary[]; chosen: string; onChoose: (run: string) => void }) {
  if (runs.length === 0) return <Empty>No runs are recorded.</Empty>;
  return (
    <table className="w-full min-w-0 table-fixed border-collapse text-small">
      <caption className="sr-only">Agent runs. Choose a row to show its decision trace.</caption>
      <thead>
        <tr className="border-b border-rule text-left text-ink-faint">
          <th scope="col" className="w-3/12 px-1.5 py-1.5 font-medium">Case</th>
          <th scope="col" className="w-3/12 px-1.5 py-1.5 font-medium">Outcome</th>
          <th scope="col" className="w-2/12 px-1.5 py-1.5 font-medium">Reviewed</th>
          <th scope="col" className="w-2/12 px-1.5 py-1.5 font-medium">Override</th>
          <th scope="col" className="w-2/12 px-1.5 py-1.5 font-medium">Findings</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => {
          const on = r.run === chosen;
          return (
            <tr key={r.run} aria-selected={on} className={`border-b border-rule ${on ? "bg-raised" : "hover:bg-raised"}`}>
              <td className="min-w-0 px-1.5 py-1.5">
                <button type="button" onClick={() => onChoose(r.run)} aria-current={on} title={`${agentName(r.agent)}, ${r.run}`} className="block w-full min-w-0 text-left text-body text-ink">
                  <span className="block whitespace-nowrap">{r.case_ref ?? "No case reference"}</span>
                  <span className="block whitespace-nowrap text-caption text-ink-faint">{longDate(r.ts)}</span>
                </button>
              </td>
              <td className="px-1.5 py-1.5 text-ink" title={r.outcome ?? undefined}>{outcomeWord(r.outcome)}</td>
              <td className="px-1.5 py-1.5 text-ink-soft">{r.reviewed ? "Yes" : "No"}</td>
              <td className="px-1.5 py-1.5 text-ink-soft">{r.override ? "Yes" : "No"}</td>
              <td className="px-1.5 py-1.5">
                <span className="inline-flex items-center gap-1 text-ink"><StatusDot tone={r.findings ? "block" : "idle"} /><span className="num">{r.findings}</span></span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function DecisionsTab({ onExport }: { onExport: (run: string) => void }) {
  const runs = useLoad(() => api.oversightRuns(), "runs");
  const [chosen, setChosen] = useState("");
  const run = chosen || runs.data?.[0]?.run || "";
  const trace = useLoad(() => (run ? api.oversightTrace(run) : Promise.resolve(null)), `trace:${run}`);
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,500px)_minmax(0,1fr)]">
      <div className="min-h-0 min-w-0 overflow-y-auto border-r border-rule">
        <Loading load={runs} what="the runs">
          {(list) => <RunTable runs={list} chosen={run} onChoose={setChosen} />}
        </Loading>
      </div>
      <div className="min-h-0 min-w-0 overflow-y-auto">
        {!run ? (
          <Empty>Choose a run to show its decision trace.</Empty>
        ) : (
          <>
            <div className="flex justify-end px-4 pt-3">
              <Button variant="ghost" className="h-6 px-2 text-small" onClick={() => { runs.reload(); trace.reload(); }}>Refresh</Button>
            </div>
            <Loading load={trace} what="the decision trace">
              {(t) => (t ? <TraceView trace={t} onExport={onExport} /> : null)}
            </Loading>
          </>
        )}
      </div>
    </div>
  );
}
