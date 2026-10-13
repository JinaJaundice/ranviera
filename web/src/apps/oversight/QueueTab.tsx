import { useState } from "react";
import type { MappingRecord, OversightStatus } from "@shared/types";
import { Button } from "../../components/Button";
import { Empty } from "../../components/Empty";
import { NodeChip } from "../../components/NodeChip";
import { api } from "../../lib/api";
import { toast } from "../../shell/toastStore";
import { useLoad } from "./load";
import { ageLine, ownersOf, personName, queueRows, relationWord, type QueueRow } from "./model";
import { NO_ACTOR_DEMO, NO_ACTOR_FIXED } from "./model";
import { queueBlock } from "./wording";
import { ErrorLine, INPUT, Loading, Person, StateChip } from "./parts";

type Mode = "reject" | "reassign" | null;

type Actor = OversightStatus["people"][number] | null;

const ORIGIN: Record<MappingRecord["origin"], string> = {
  reviewer: "Entered by a reviewer",
  suggested: "Suggested by the automatic matching tool from the source records",
  imported: "Imported from an existing register",
};

function Row({ row, people, done, actor, demo, shared }: { row: QueueRow; people: OversightStatus["people"]; done: () => void; actor: Actor; demo: boolean; shared: boolean }) {
  const m = row.mapping;
  const stop = { ratify: queueBlock(actor, demo, m.maker, "ratify"), reject: queueBlock(actor, demo, m.maker, "reject"), reassign: queueBlock(actor, demo, m.maker, "reassign") };
  const why = row.kind === "proposed" ? stop.ratify : stop.reassign;
  const checkers = people.filter((p) => p.roles.includes("checker") && p.id !== m.maker.replace(/^person:/, ""));
  const [mode, setMode] = useState<Mode>(null);
  const [reason, setReason] = useState("");
  const [owner, setOwner] = useState(people[0] ? `person:${people[0].id}` : "");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const run = async (act: () => Promise<MappingRecord>, said: string) => {
    setBusy(true);
    setRefusal(null);
    try {
      await act();
      toast(said);
      setMode(null);
      done();
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : "The server could not complete the request.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="min-w-0 border-b border-rule px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <StateChip tone={row.kind === "stale" ? "block" : "hold"}>{row.kind === "stale" ? "Stale" : "Proposed"}</StateChip>
        <span className="text-small text-ink-soft">{relationWord(m.relation)}</span>
        <NodeChip id={m.s} />
        <span className="text-ink-faint" aria-hidden="true">to</span>
        <NodeChip id={m.t} />
      </div>
      <p className="mt-1 text-body text-ink">{m.basis || "No basis is recorded."}</p>
      <p className="text-small text-ink-faint">{ORIGIN[m.origin] ?? m.origin}.</p>
      <p className="mt-1 flex min-w-0 flex-wrap gap-x-4 text-small text-ink-soft">
        <span>Owner <Person id={m.owner} /></span>
        <span>Proposed by <Person id={m.maker} /></span>
        <span title={m.id}>{ageLine(row.kind, row.days)}</span>
      </p>
      {row.kind === "proposed" ? (
        <p className="mt-1 text-small text-ink-soft">
          Waiting for a checker. {checkers.length ? `A checker other than the maker may ratify it: ${checkers.map((c) => c.name).join(", ")}.` : "No checker other than the maker is on the list of people."}
        </p>
      ) : null}
      {row.kind === "stale" ? (
        <p className="mt-1 text-small text-hold">The clause, control or obligation at one end changed after this mapping was ratified. The owner should review it again.</p>
      ) : null}
      {refusal ? <div className="mt-2"><ErrorLine>{refusal}</ErrorLine></div> : null}
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        {row.kind === "proposed" ? (
          <Button variant={stop.ratify === null ? "primary" : "secondary"} disabled={busy || stop.ratify !== null} title={stop.ratify ?? undefined} onClick={() => void run(() => api.ratifyMapping(m.id), "The mapping was ratified.")}>Ratify</Button>
        ) : null}
        {row.kind === "proposed" ? (
          <Button disabled={busy || stop.reject !== null} title={stop.reject ?? undefined} aria-expanded={mode === "reject"} onClick={() => setMode(mode === "reject" ? null : "reject")}>Reject</Button>
        ) : null}
        <Button disabled={busy || stop.reassign !== null} title={stop.reassign ?? undefined} aria-expanded={mode === "reassign"} onClick={() => setMode(mode === "reassign" ? null : "reassign")}>Reassign</Button>
        {why && !shared ? <span className="min-w-0 text-small text-hold">{why}</span> : null}
      </div>
      {mode === "reject" ? (
        <form
          className="mt-2 flex min-w-0 flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.rejectMapping(m.id, reason), "The mapping was rejected.");
          }}
        >
          <label className="sr-only" htmlFor={`rej-${m.id}`}>Reason for the rejection</label>
          <input id={`rej-${m.id}`} className={`${INPUT} flex-1`} placeholder="Reason for the rejection" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button type="submit" variant="primary" disabled={busy || !reason.trim()}>Confirm the rejection</Button>
        </form>
      ) : null}
      {mode === "reassign" ? (
        <form
          className="mt-2 flex min-w-0 flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.reassignMapping(m.id, owner), `The mapping was reassigned to ${personName(people, owner)}.`);
          }}
        >
          <label className="text-small text-ink-soft" htmlFor={`own-${m.id}`}>New owner</label>
          <select id={`own-${m.id}`} className={INPUT} value={owner} onChange={(e) => setOwner(e.target.value)}>
            {people.map((p) => (
              <option key={p.id} value={`person:${p.id}`}>{p.name}</option>
            ))}
          </select>
          <Button type="submit" variant="primary" disabled={busy || !owner}>Confirm the new owner</Button>
        </form>
      ) : null}
    </li>
  );
}

export function QueueTab({ people, acting }: { people: OversightStatus["people"]; acting: { actor: string | null; demo: boolean } }) {
  const actor = people.find((p) => p.id === acting.actor) ?? null;
  const checkers = people.filter((p) => p.roles.includes("checker")).map((p) => p.name);
  const q = useLoad(async () => ({ proposed: await api.oversightMappings({ status: "proposed" }), stale: await api.oversightMappings({ stale: true }) }), "queue");
  const [owner, setOwner] = useState("");
  // one notice at the top where the person cannot act on any row, so that it is not repeated on every row
  const shared = !actor || !actor.roles.includes("checker");
  // the age is counted from the time the section opened, because the current time is not read while the view draws
  const [now] = useState(() => Date.now());
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <Loading load={q} what="the review queue">
        {(d) => {
          const rows = queueRows(d.proposed, d.stale, now);
          const shown = rows.filter((r) => !owner || r.mapping.owner === owner);
          return (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-rule px-4 py-3">
                <label className="text-small text-ink-soft" htmlFor="ov-q-owner">Owner</label>
                <select id="ov-q-owner" className={INPUT} value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="">All owners</option>
                  {ownersOf(rows).map((o) => (
                    <option key={o} value={o}>{personName(people, o)}</option>
                  ))}
                </select>
                <span className="num text-small text-ink-soft">{shown.length} of {rows.length} mappings</span>
              </div>
              {shared ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-rule bg-sunken px-4 py-2">
                  <p className="min-w-0 text-body text-hold">{acting.demo && !actor ? NO_ACTOR_DEMO : actor ? `${actor.name} is not a checker, so the buttons below are disabled` : NO_ACTOR_FIXED}.</p>
                  {acting.demo ? (
                    <Button variant="secondary" className="h-6 px-2 text-small" onClick={() => document.getElementById("ov-acting")?.focus()}>Choose who is acting</Button>
                  ) : null}
                </div>
              ) : null}
              <p className="border-b border-rule px-4 py-2 text-small text-ink-soft">
                A proposed mapping takes effect when a checker other than its maker ratifies it. {checkers.length ? `The checkers on the list of people are ${checkers.join(", ")}.` : "The list of people names no checker."} Only a checker may ratify, reject or reassign a mapping, and the server refuses anyone else.
              </p>
              {shown.length ? (
                <ul>
                  {shown.map((r) => (
                    <Row key={`${r.kind}-${r.mapping.id}`} row={r} people={people} done={q.reload} actor={actor} demo={acting.demo} shared={shared} />
                  ))}
                </ul>
              ) : (
                <Empty>{rows.length ? "No mapping is waiting for this owner." : "No mapping is proposed or stale."}</Empty>
              )}
            </>
          );
        }}
      </Loading>
    </div>
  );
}
