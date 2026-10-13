import { useState } from "react";
import type { CoverageMatrix } from "@shared/types";
import { Empty } from "../../components/Empty";
import { Section } from "../../components/Section";
import { StatusDot } from "../../components/StatusDot";
import { api } from "../../lib/api";
import { useLoad } from "./load";
import { agentName, plural, statusWord } from "./model";
import { FindingList, INPUT, Loading, StateChip } from "./parts";

const STATE_TONE = { covered: "pass", partial: "hold", gap: "block", exempt: "idle" } as const;
const STATE_WORD = { covered: "Covered", partial: "Partly covered", gap: "Not covered", exempt: "Exempt" } as const;
const CELL_TONE = { ratified: "pass", proposed: "hold", stated: "idle" } as const;
const GROUPS = [
  { type: "Control", title: "Controls that satisfy it" },
  { type: "PolicyClause", title: "Policy clauses that realise the controls" },
  { type: "InstructionVersion", title: "Instruction versions that implement the clauses" },
] as const;

/** One obligation per row, with the controls, clauses and instruction versions that link to it listed in the cell of their kind. */
function Matrix({ m }: { m: CoverageMatrix }) {
  if (m.rows.length === 0) return <Empty>No obligations are loaded for this view.</Empty>;
  return (
    <div className="min-w-0">
      <table className="w-full min-w-0 table-fixed border-collapse text-small">
        <caption className="sr-only">Coverage of each obligation by controls, policy clauses and instruction versions. Each link gives its status.</caption>
        <thead>
          <tr className="border-b border-rule-strong text-left text-ink-faint">
            <th scope="col" className="w-1/4 px-3 py-2 font-medium">Obligation</th>
            <th scope="col" className="w-1/12 px-2 py-2 font-medium">Coverage</th>
            {GROUPS.map((g) => (
              <th key={g.type} scope="col" className="w-1/5 px-2 py-2 font-medium">{g.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {m.rows.map((r) => (
            <tr key={r.obligation} className="border-b border-rule align-top">
              <th scope="row" className="min-w-0 px-3 py-2 text-left font-normal">
                <span className="block break-words text-body text-ink" title={r.obligation}>{r.label}</span>
                {r.provision ? <span className="mt-1 block break-words text-caption text-ink-faint">{r.provision.label}</span> : null}
              </th>
              <td className="px-2 py-2">
                <StateChip tone={STATE_TONE[r.state]}>{STATE_WORD[r.state]}</StateChip>
                {r.state === "covered" && Object.values(r.cells).includes("proposed") ? (
                  <span className="mt-1 block text-caption text-ink-faint">Rests on the ratified links only. Not counted, because it is only proposed: {m.columns.filter((c) => r.cells[c.id] === "proposed").map((c) => c.label).join(", ")}.</span>
                ) : null}
              </td>
              {GROUPS.map((g) => {
                const cols = m.columns.filter((c) => c.type === g.type && r.cells[c.id]);
                return (
                  <td key={g.type} className="min-w-0 px-2 py-2">
                    {cols.length ? (
                      <ul className="space-y-1">
                        {cols.map((c) => (
                          <li key={c.id} className="flex min-w-0 items-start gap-1.5 text-ink" title={`${c.label}, ${statusWord(r.cells[c.id])}`}>
                            <span className="mt-1 shrink-0"><StatusDot tone={CELL_TONE[r.cells[c.id]]} /></span>
                            <span className="min-w-0">
                              {c.label}
                              <span className="block text-caption text-ink-faint">{statusWord(r.cells[c.id])}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-ink-faint" aria-label="No link">&nbsp;</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CoverageTab() {
  const [agent, setAgent] = useState("");
  const agents = useLoad(() => api.oversightInstructions(), "coverage-agents");
  const cov = useLoad(() => api.oversightCoverage(agent || undefined), `coverage:${agent}`);
  const names = [...new Set((agents.data ?? []).map((i) => i.agent))].sort();
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-rule px-4 py-3">
        <label className="text-small text-ink-soft" htmlFor="ov-cov-agent">Agent</label>
        <select id="ov-cov-agent" className={INPUT} value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">All agents</option>
          {names.map((n) => (
            <option key={n} value={n}>{agentName(n)}</option>
          ))}
        </select>
        {cov.data ? <span className="num text-small text-ink-soft">{cov.data.rows.length} obligations</span> : null}
      </div>
      <Loading load={cov} what="the coverage matrix">
        {(m) => (
          <>
            <Section title="Findings" note="Three checks run on this tab. A violation is raised where an obligation that applies to the agent has no ratified link to a control, a policy clause and an instruction in force. A warning is raised where an instruction in force has no ratified link to a policy clause. A note is raised where a typology in scope has no instruction in force that detects it.">
              <FindingList findings={m.findings} none="No coverage finding is open." />
            </Section>
            {m.earlier_versions && m.earlier_versions.length ? (
              <Section title="Earlier versions" note="Instruction versions that are no longer in force, that no ratified clause covers and that the agent cited in past decisions. The three checks above read only the versions in force today, so these gaps appear here and in the basis of each decision.">
                <ul className="space-y-1">
                  {m.earlier_versions.map((e) => (
                    <li key={e.id} className="flex min-w-0 flex-wrap items-center gap-1.5 text-body text-ink" title={e.id}>
                      <StatusDot tone="hold" />
                      <span className="min-w-0">{e.label}</span>
                      <span className="text-small text-ink-soft">has no ratified policy clause and was cited in {plural(e.runs, "run")}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
            <p className="px-4 pt-3 text-small text-ink-soft">
              Each obligation lists the controls, clauses and instruction versions linked to it, with the status of each link. Ratified means that a checker approved the link, proposed means that it awaits a checker and stated means that the source record gives it. A blank cell means that no link of that kind exists. An obligation needs one complete chain, so a blank cell does not make it a gap.
            </p>
            <div className="pt-2">
              <Matrix m={m} />
            </div>
          </>
        )}
      </Loading>
    </div>
  );
}
