import { useState } from "react";
import type { SampleRecord } from "@shared/types";
import { Button } from "../../components/Button";
import { Empty } from "../../components/Empty";
import { NodeChip } from "../../components/NodeChip";
import { Section } from "../../components/Section";
import { api } from "../../lib/api";
import { toast } from "../../shell/toastStore";
import { useLoad } from "./load";
import { useStore } from "../../lib/store";
import { agentName, boundText, longDate, outsideBound, perMilleText, plural, when, type Agent } from "./model";
import { DRIFT_KIND, agreementWords, driftView, overrideCounts, periodText, plainIds, smallBaseNote, upperFirst } from "./monitorWords";
import { modelShort } from "./wording";
import { ErrorLine, FindingList, INPUT, Loading, Person, StateChip } from "./parts";

function Measures({ a }: { a: Agent }) {
  const rows: { name: string; value: string; bound: string; out: boolean }[] = [
    {
      name: "Override rate",
      value: perMilleText(a.override_per_mille),
      bound: boundText(a.bounds.override, " in 1,000"),
      out: outsideBound(a.override_per_mille, a.bounds.override),
    },
    {
      name: "Mean review time",
      value: a.review_seconds_mean === null ? "No reviews with a time" : `${a.review_seconds_mean} seconds`,
      bound: boundText(a.bounds.review_seconds, " seconds"),
      out: outsideBound(a.review_seconds_mean, a.bounds.review_seconds),
    },
  ];
  return (
    <table className="w-full min-w-0 table-fixed border-collapse text-small">
      <caption className="sr-only">Measures of {agentName(a.label)} against the bounds that the bank set</caption>
      <thead>
        <tr className="border-b border-rule text-left text-ink-faint">
          <th scope="col" className="w-1/4 px-2 py-1.5 font-medium">Measure</th>
          <th scope="col" className="w-1/3 px-2 py-1.5 font-medium">Value</th>
          <th scope="col" className="w-1/4 px-2 py-1.5 font-medium">Bound of the bank</th>
          <th scope="col" className="w-1/6 px-2 py-1.5 font-medium">Result</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} className="border-b border-rule">
            <th scope="row" className="px-2 py-1.5 text-left font-normal text-ink">
              {r.name}
              {r.name === "Override rate" ? <span className="block text-caption text-ink-faint">How often a reviewer disagreed with the agent and changed the outcome</span> : null}
            </th>
            <td className="px-2 py-1.5 text-ink">
              {r.value}
              {r.name === "Override rate" && smallBaseNote(a.override_per_mille, a.reviewed) ? <span className="block text-caption text-hold">{smallBaseNote(a.override_per_mille, a.reviewed)}</span> : null}
            </td>
            <td className="px-2 py-1.5 text-ink-soft">{r.bound}</td>
            <td className="px-2 py-1.5">
              {r.bound === "No bound set by the bank" ? <StateChip tone="idle">Not checked</StateChip> : <StateChip tone={r.out ? "block" : "pass"}>{r.out ? "Outside" : "Within"}</StateChip>}
              {r.name === "Override rate" && overrideCounts(a.override_per_mille, a.reviewed) ? <span className="mt-0.5 block text-caption text-ink-faint">{overrideCounts(a.override_per_mille, a.reviewed)}</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Sampling({ agents, onChange }: { agents: Agent[]; onChange: () => void }) {
  const [agent, setAgent] = useState(agents[0]?.id ?? "");
  const [size, setSize] = useState("5");
  const [seed, setSeed] = useState("");
  const [weighted, setWeighted] = useState(false);
  const [sample, setSample] = useState<SampleRecord | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const guard = async (act: () => Promise<void>) => {
    setBusy(true);
    setRefusal(null);
    try {
      await act();
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : "The server could not complete the request.");
    } finally {
      setBusy(false);
    }
  };
  const n = Number(size);
  const okSize = Number.isInteger(n) && n >= 1 && n <= 1000;
  const okSeed = seed.trim() === "" || Number.isInteger(Number(seed));
  return (
    <div className="min-w-0 space-y-3">
      <form
        className="flex min-w-0 flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void guard(async () => {
            setSample(await api.drawSample(agent, n, seed.trim() === "" ? undefined : Number(seed), weighted));
            toast("A sample was drawn.");
            onChange();
          });
        }}
      >
        <label className="min-w-0 text-small text-ink-soft">
          Agent
          <select className={`${INPUT} mt-0.5 block`} value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{agentName(a.label)}</option>
            ))}
          </select>
        </label>
        <label className="text-small text-ink-soft">
          Size of the sample
          <input className={`${INPUT} mt-0.5 block w-28`} inputMode="numeric" value={size} onChange={(e) => setSize(e.target.value)} />
        </label>
        <label className="text-small text-ink-soft">
          Seed, optional
          <input className={`${INPUT} mt-0.5 block w-28`} inputMode="numeric" value={seed} onChange={(e) => setSeed(e.target.value)} />
        </label>
        <label className="flex h-8 items-center gap-1.5 text-body text-ink">
          <input type="checkbox" checked={weighted} onChange={(e) => setWeighted(e.target.checked)} />
          Weight by risk
        </label>
        <Button type="submit" variant="primary" disabled={busy || !agent || !okSize || !okSeed}>Draw a sample</Button>
      </form>
      {!okSize ? <p className="text-small text-hold">The size must be a whole number from 1 to 1,000.</p> : null}
      {refusal ? <ErrorLine>{refusal}</ErrorLine> : null}
      {sample ? (
        <div className="min-w-0 rounded-md border border-rule p-3">
          <p className="text-body text-ink">
            Sample <span className="addr">{sample.id}</span> holds {sample.runs.length} of {sample.pool} runs, drawn by <Person id={sample.drawn_by} /> on {when(sample.drawn_at)}.
          </p>
          <ul className="mt-2 space-y-2">
            {sample.runs.map((r) => (
              <li key={r.run} className="flex min-w-0 flex-wrap items-center gap-2">
                <NodeChip id={r.run} />
                {r.verdict ? (
                  <StateChip tone={r.verdict === "agree" ? "pass" : "hold"}>{r.verdict === "agree" ? "Agrees with the agent" : "Disagrees with the agent"}</StateChip>
                ) : (
                  <>
                    <input
                      aria-label={`Reason for the verdict on ${r.run}`}
                      className={`${INPUT} w-56`}
                      placeholder="Reason, optional"
                      value={reasons[r.run] ?? ""}
                      onChange={(e) => setReasons({ ...reasons, [r.run]: e.target.value })}
                    />
                    {(["agree", "disagree"] as const).map((v) => (
                      <Button
                        key={v}
                        disabled={busy}
                        onClick={() =>
                          void guard(async () => {
                            setSample(await api.sampleVerdict(sample.id, r.run, v, reasons[r.run]?.trim() || undefined));
                            onChange();
                          })
                        }
                      >
                        {v === "agree" ? "Agree" : "Disagree"}
                      </Button>
                    ))}
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function MonitoringTab() {
  const load = useLoad(() => api.oversightMonitoring(), "monitoring");
  const byId = useStore((s) => s.byId);
  const labelOf = (id: string) => byId.get(id)?.label;
  const runs = useLoad(() => api.oversightRuns(), "monitoring-runs");
  const span = (() => {
    const days = (runs.data ?? []).map((r) => r.ts).filter(Boolean).sort();
    return days.length ? ` The ${days.length} runs recorded run from ${longDate(days[0])} to ${longDate(days[days.length - 1])}.` : "";
  })();
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <Loading load={load} what="the monitoring report">
        {(m) => (
          <>
            {m.agents.length === 0 ? <Empty>No agent has recorded decisions.</Empty> : null}
            {m.agents.map((a) => (
              <Section key={a.id} title={agentName(a.label)} note={`${plural(a.decisions, "decision")}, of which ${a.reviewed} ${a.reviewed === 1 ? "was" : "were"} reviewed by a person. ${periodText(m.from, m.to)}${m.from || m.to ? "" : span}`}>
                <div className="min-w-0 space-y-4">
                  <Measures a={a} />
                  <div className="min-w-0">
                    <h4 className="mb-1 text-body font-medium text-ink">Agreement with the agent, by instruction version</h4>
                    <p className="mb-1 text-small text-ink-faint">A reviewer compares a sample of runs with the agent. Each line gives the number of sampled runs that loaded the version and agreed with the agent.</p>
                    {Object.keys(a.agreement_by_version).length ? (
                      <ul className="space-y-0.5 text-small text-ink-soft">
                        {Object.entries(a.agreement_by_version).map(([v, x]) => (
                          <li key={v} className="flex min-w-0 flex-wrap items-center gap-2"><NodeChip id={v} /><span>{agreementWords(x)}</span></li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-small text-ink-soft">No sample has a verdict yet, so there is no agreement to show.</p>
                    )}
                  </div>
                  <div className="min-w-0">
                    <h4 className="mb-1 text-body font-medium text-ink">Drift</h4>
                    {a.drift.length ? (
                      <ul className="space-y-1">
                        {a.drift.map((d, i) => (
                          <li key={i} className="min-w-0 text-small text-ink">
                            <StateChip tone="hold">{DRIFT_KIND[d.kind] ?? d.kind}</StateChip> {driftView(d.detail, d.since, labelOf).text}
                            {driftView(d.detail, d.since, labelOf).items.length ? (
                              <ul className="ml-4 mt-0.5 list-disc space-y-0.5 text-ink-soft">
                                {driftView(d.detail, d.since, labelOf).items.map((x) => (
                                  <li key={x}>{x}</li>
                                ))}
                              </ul>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-small text-ink-soft">No drift is recorded. The agent owner is not prompted to re-validate.</p>
                    )}
                  </div>
                  <div className="min-w-0">
                    <h4 className="mb-1 text-body font-medium text-ink">Back-tests</h4>
                    {a.backtests.length ? (
                      <table className="w-full min-w-0 table-fixed border-collapse text-small">
                        <thead>
                          <tr className="border-b border-rule text-left text-ink-faint">
                            <th scope="col" className="w-1/2 px-2 py-1.5 font-medium">Instructions and model version tested</th>
                            <th scope="col" className="px-2 py-1.5 font-medium">Alerts</th>
                            <th scope="col" className="px-2 py-1.5 font-medium">Agreement</th>
                            <th scope="col" className="px-2 py-1.5 font-medium">False closures</th>
                            <th scope="col" className="px-2 py-1.5 font-medium">False escalations</th>
                          </tr>
                        </thead>
                        <tbody>
                          {a.backtests.map((b) => (
                            <tr key={b.id} className="border-b border-rule">
                              <td className="whitespace-normal break-words px-2 py-1.5 text-ink" title={b.version}>{upperFirst(plainIds(b.version.replace(/\b[a-z]+-[a-z]+-\d+-\d{4}-\d{2}\b/g, (x) => modelShort(labelOf(`model:${x}`) ?? x)), labelOf))}</td>
                              <td className="num px-2 py-1.5">{b.n}</td>
                              <td className="num px-2 py-1.5">{Math.round(b.agreement * 100)}%</td>
                              <td className="num px-2 py-1.5">{b.false_closures}</td>
                              <td className="num px-2 py-1.5">{b.false_escalations}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="text-small text-ink-soft">No back-test has been recorded. The bank sets the pass threshold.</p>
                    )}
                  </div>
                </div>
              </Section>
            ))}
            <Section title="Findings" note="The check compares each measure with the bound that the bank set. The bank sets each bound.">
              <FindingList findings={m.findings} none="No monitoring finding is open." />
            </Section>
            <Section title="Sample draw" note="A reviewer draws runs of one agent, then records whether the reviewer agrees with the agent. The verdict shows agreement and does not show that a decision was correct.">
              {m.agents.length ? <Sampling agents={m.agents} onChange={load.reload} /> : <p className="text-body text-ink-soft">No agent has runs to sample.</p>}
            </Section>
          </>
        )}
      </Loading>
    </div>
  );
}
