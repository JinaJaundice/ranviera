// Small pieces that the sections of the Oversight window share.
import { useState, type ReactNode } from "react";
import type { MonitoringReport, TraceFinding } from "@shared/types";
import { Loader2 } from "lucide-react";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { NodeChip } from "../../components/NodeChip";
import { StatusDot } from "../../components/StatusDot";
import { useStore } from "../../lib/store";
import { agentName, isProofNode, personName, plainMessage, severityTone, severityWord } from "./model";
import { usePeople } from "./people";
import type { Loaded } from "./load";
import { ProofText } from "./ProofText";
import { SEVERITY_NOTE, checkTitle, conflictPartner, findingLead } from "./wording";

export const INPUT = "h-8 min-w-0 rounded-md border border-rule-strong bg-sunken px-2 text-body text-ink placeholder:text-ink-faint";

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" aria-label="Oversight sections" className="flex min-w-0 flex-wrap gap-1">
      {tabs.map((t) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            id={`ov-tab-${t.value}`}
            aria-selected={on}
            aria-controls={`ov-panel-${t.value}`}
            onClick={() => onChange(t.value)}
            className={`h-8 rounded-md px-3 text-body font-medium ${on ? "bg-raised text-ink" : "text-ink-soft hover:text-ink"}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** The refusal or failure of the server, in its own sentence. */
export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-body text-block">
      {children}
    </p>
  );
}

/** Shows the state of a load, and the content when there is data. */
export function Loading<T>({ load, what, children }: { load: Loaded<T>; what: string; children: (data: T) => ReactNode }) {
  if (load.error) return <ErrorLine>{load.error}</ErrorLine>;
  if (!load.data) {
    return (
      <p role="status" className="flex items-center justify-center gap-2 px-3 py-6 text-body text-ink-faint">
        <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin" />
        {`Loading ${what}.`}
      </p>
    );
  }
  return <>{children(load.data)}</>;
}

/** One of the three labels of the trace, taken from the server so that the words are exactly those of the contract. */
export function LabelTag({ children, title }: { children: ReactNode; title: string }) {
  return (
    <span title={title} className="inline-flex items-center rounded-sm border border-rule-strong px-1.5 text-caption text-ink-soft">
      {children}
    </span>
  );
}

export function StateChip({ tone, children }: { tone: "pass" | "hold" | "block" | "idle"; children: ReactNode }) {
  return (
    <Chip>
      <StatusDot tone={tone} />
      {children}
    </Chip>
  );
}

/** A finding in words: the name of the check, a sentence about the case and, on request, what the record shows. */
export function FindingRow({ f, subject = null, ledgerNote = null, detail = null }: { f: TraceFinding; subject?: string | null; ledgerNote?: string | null; detail?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const proof = isProofNode(f.proof) ? f.proof : null;
  const showNode = !/^(adec|run):/.test(f.node);
  const partner = f.check === "O03" ? conflictPartner(f.proof, f.node) : null;
  const byId = useStore((s) => s.byId);
  const nameOf = (id: string) => byId.get(id)?.label ?? id.replace(/^[a-z]+:/, "").replace(/[-_]+/g, " ");
  const lead = partner ? `${nameOf(f.node)} and ${nameOf(partner)} are in force for the same agent and neither overrides the other where they conflict.` : findingLead(f, subject, ledgerNote);
  return (
    <li className="min-w-0 border-t border-rule py-2 first:border-t-0">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-body text-ink">
            <StatusDot tone={severityTone(f.severity)} />
            <span className="font-medium">{checkTitle(f.check)}</span>
            <span className="text-ink-soft" title={SEVERITY_NOTE[f.severity]}>{severityWord(f.severity)}</span>
          </p>
          <p className="text-body text-ink">{lead ?? plainMessage(f.message)}</p>
          {showNode ? (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-small text-ink-soft">
              <NodeChip id={f.node} />
              {partner ? (
                <>
                  <span>conflicts with</span>
                  <NodeChip id={partner} />
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        {proof || detail ? (
          <Button variant="ghost" className="h-6 shrink-0 px-2 text-small" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide proof" : "Show proof"}
          </Button>
        ) : (
          <span className="shrink-0 text-small text-ink-faint">No proof held</span>
        )}
      </div>
      {open && (proof || detail) ? (
        <div className="mt-2 min-w-0 space-y-3 rounded-md border border-rule bg-sunken p-3">
          {detail}
          {proof ? <ProofText proof={proof} /> : null}
        </div>
      ) : null}
    </li>
  );
}

export function FindingList({ findings, none, subject = null, ledgerNote = null, detailFor }: { findings: TraceFinding[]; none: string; subject?: string | null; ledgerNote?: string | null; detailFor?: (f: TraceFinding) => ReactNode }) {
  if (findings.length === 0) return <p className="text-body text-ink-soft">{none}</p>;
  return (
    <ul className="min-w-0">
      {findings.map((f, i) => (
        <FindingRow key={`${f.check}-${f.node}-${i}`} f={f} subject={subject} ledgerNote={ledgerNote} detail={detailFor ? detailFor(f) : null} />
      ))}
    </ul>
  );
}

export type AgentReport = MonitoringReport["agents"][number];

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-small text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-words text-body text-ink">{children}</dd>
    </div>
  );
}

/** The name of a person, with the identifier of the record in the title for those who need it. */
export function Person({ id }: { id: string | null | undefined }) {
  const people = usePeople();
  return <span title={id ?? undefined}>{personName(people, id)}</span>;
}

/** The name of an agent, with its identifier in the title. */
export function AgentName({ id, label }: { id: string; label?: string }) {
  return <span title={id}>{agentName(label ?? id)}</span>;
}
