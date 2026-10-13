import { useState } from "react";
import type { InstructionDetail } from "@shared/types";
import { Button } from "../../components/Button";
import { Empty } from "../../components/Empty";
import { NodeChip } from "../../components/NodeChip";
import { Section } from "../../components/Section";
import { api } from "../../lib/api";
import { toast } from "../../shell/toastStore";
import { useLoad } from "./load";
import { agentName, diffCounts, latestText, longDate, plural, relationWord, shortHash, statusWord, when } from "./model";
import { mappingName } from "./monitorWords";
import { ErrorLine, FindingList, INPUT, Loading, Person, StateChip } from "./parts";

const STATUS_TONE = { draft: "hold", approved: "pass", withdrawn: "idle" } as const;
const OP_MARK = { same: " ", add: "+", remove: "-" } as const;
const OP_CLASS = { same: "text-ink-soft", add: "bg-pass-soft text-ink", remove: "bg-block-soft text-ink" } as const;

function Draft({ d, onDone }: { d: InstructionDetail; onDone: () => void }) {
  const [text, setText] = useState(() => (d.diff ? latestText(d.diff.lines) : ""));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await api.draftInstruction(d.id, text);
      toast("The draft was saved as a new version. It needs an approver other than its maker.");
      onDone();
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : "The server could not complete the request.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-w-0 space-y-2">
      <label className="block text-small text-ink-soft" htmlFor="ov-draft">Text of the new draft</label>
      <textarea id="ov-draft" className={`${INPUT} h-40 w-full resize-y py-1.5 font-mono text-small`} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy || !text.trim()} onClick={() => void save()}>Save as a draft</Button>
        <span className="text-small text-ink-soft">A draft changes nothing until an approver approves it.</span>
      </div>
      {refusal ? <ErrorLine>{refusal}</ErrorLine> : null}
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const load = useLoad(() => api.oversightInstruction(id), `instruction:${id}`);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const approve = async (version: string) => {
    setBusy(true);
    setRefusal(null);
    try {
      await api.approveVersion(version);
      toast(`Version ${version} was approved.`);
      load.reload();
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : "The server could not complete the request.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Loading load={load} what="the instruction">
      {(d) => {
        const latest = d.versions[d.versions.length - 1];
        const draft = latest && latest.status === "draft" ? latest : null;
        const counts = d.diff ? diffCounts(d.diff.lines) : null;
        return (
          <div>
            <div className="min-w-0 border-b border-rule px-4 py-3">
              <h2 className="min-w-0 truncate text-ui font-medium text-ink">{d.label}</h2>
              <p className="text-small text-ink-soft" title={d.file}>Instruction of the <span title={d.agent}>{agentName(d.agent)}</span> agent</p>
              <p className="mt-1 text-small text-ink-faint">The agent may run text that differs from the approved version until the bank checks the signed copy each time the agent starts. Each run records the text that the agent loaded, and a difference from the approved text is reported as a finding.</p>
            </div>
            <Section title="Versions">
              <ul className="space-y-2">
                {d.versions.map((v) => (
                  <li key={v.id} className="min-w-0 rounded-md border border-rule p-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="text-body font-medium text-ink" title={`Fingerprint ${shortHash(v.hash)}`}>Version {v.version}</span>
                      <StateChip tone={STATUS_TONE[v.status]}>{statusWord(v.status)}</StateChip>
                      {v.in_force ? <StateChip tone="pass">In force</StateChip> : null}
                    </div>
                    <p className="mt-1 text-small text-ink-soft">
                      Made by <Person id={v.maker} />. {v.approver ? <>Approved by <Person id={v.approver} /></> : "Not approved"}
                      {v.valid_from ? `, valid from ${longDate(v.valid_from)}${v.valid_to ? ` to ${longDate(v.valid_to)}` : ""}` : ""}.
                    </p>
                    {v.status === "approved" && v.approved_hash && v.approved_hash !== v.hash ? (
                      <p className="mt-1 text-small text-block">The text now differs from the text that was approved.</p>
                    ) : null}
                    {v.status === "draft" ? (
                      <div className="mt-2">
                        <Button disabled={busy} onClick={() => void approve(v.id)}>Approve version {v.version}</Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
              {refusal ? <div className="mt-2"><ErrorLine>{refusal}</ErrorLine></div> : null}
            </Section>
            <Section title="Change between the last two versions" note={counts ? `${counts.added} ${counts.added === 1 ? "line" : "lines"} added and ${counts.removed} ${counts.removed === 1 ? "line" : "lines"} removed.` : undefined}>
              {d.diff ? (
                <pre className="min-w-0 overflow-x-auto rounded-md border border-rule bg-sunken p-2 font-mono text-small" aria-label="Line difference">
                  {d.diff.lines.map((l, i) => (
                    <span key={i} className={`block whitespace-pre-wrap ${OP_CLASS[l.op]}`}>{`${OP_MARK[l.op]} ${l.text}`}</span>
                  ))}
                </pre>
              ) : (
                <p className="text-body text-ink-soft">This instruction has one version, so there is nothing to compare.</p>
              )}
            </Section>
            <Section title="Impact of the latest draft" note="The mappings that would become stale and the past decisions that used the version in force.">
              {draft ? (
                <div className="min-w-0 space-y-2">
                  <p className="text-body text-ink">
                    Version {draft.version} would make <span className="num">{plural(d.impact.stale_mappings.length, "mapping")}</span> stale and touches <span className="num">{plural(d.impact.decisions.length, "past decision")}</span>.
                  </p>
                  {d.impact.stale_mappings.length ? (
                    <div className="flex min-w-0 flex-wrap gap-1.5">
                      {d.impact.stale_mappings.map((m) => (
                        <span key={m} className="rounded-md border border-rule px-2 py-0.5 text-small text-ink" title={m}>{mappingName(m)}</span>
                      ))}
                    </div>
                  ) : null}
                  {d.impact.decisions.length ? (
                    <ul className="space-y-0.5 text-small text-ink-soft">
                      {d.impact.decisions.map((x) => (
                        <li key={x.decision} className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span title={x.decision}>Decision of {when(x.ts)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : (
                <p className="text-body text-ink-soft">No draft is waiting, so there is no impact to show.</p>
              )}
            </Section>
            <Section title="Mappings">
              {d.mappings.length ? (
                <ul className="space-y-1.5">
                  {d.mappings.map((m) => (
                    <li key={m.id} className="flex min-w-0 flex-wrap items-center gap-1.5 text-small text-ink-soft">
                      <StateChip tone={m.status === "ratified" ? "pass" : m.status === "proposed" ? "hold" : "idle"}>{statusWord(m.status)}</StateChip>
                      <span>{relationWord(m.relation)}</span>
                      <NodeChip id={m.s} />
                      <NodeChip id={m.t} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-body text-ink-soft">No mapping names this instruction.</p>
              )}
            </Section>
            <Section title="Findings">
              <FindingList findings={d.findings} none="No finding concerns this instruction." />
            </Section>
            <Section title="New draft">
              <Draft key={`${d.id}-${d.versions.length}`} d={d} onDone={load.reload} />
            </Section>
          </div>
        );
      }}
    </Loading>
  );
}

export function InstructionsTab() {
  const list = useLoad(() => api.oversightInstructions(), "instructions");
  const [chosen, setChosen] = useState("");
  const id = chosen || list.data?.[0]?.id || "";
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
      <nav aria-label="Instructions" className="min-h-0 min-w-0 overflow-y-auto border-r border-rule p-2">
        <Loading load={list} what="the instructions">
          {(items) =>
            items.length ? (
              <ul>
                {items.map((i) => (
                  <li key={i.id} className="min-w-0">
                    <button type="button" title={i.label} aria-current={i.id === id} onClick={() => setChosen(i.id)} className={`block w-full min-w-0 rounded-md px-2 py-1.5 text-left hover:bg-raised ${i.id === id ? "bg-raised" : ""}`}>
                      <span className="line-clamp-2 break-words text-body text-ink">{i.label}</span>
                      <span className="block truncate text-small text-ink-faint">{plural(i.versions, "version")}{i.findings ? `, ${plural(i.findings, "finding")}` : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No instruction store is loaded.</Empty>
            )
          }
        </Loading>
      </nav>
      <div className="min-h-0 min-w-0 overflow-y-auto">{id ? <Detail key={id} id={id} /> : <Empty>Choose an instruction.</Empty>}</div>
    </div>
  );
}
