import { useStore } from "../../lib/store";
import type { Plan } from "@shared/types";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { NodeChip } from "../../components/NodeChip";
import { Section } from "../../components/Section";
import { openPath } from "./openPath";

/** The plan for a mission: what the graph chose, what to read, who does the work and which gates apply. */
export function PlanView({ plan }: { plan: Plan }) {
  const top = Math.max(1, ...plan.fire.map((f) => f.a));
  return (
    <div className="min-w-0">
      <Section title="Task type">
        {plan.task_types.length === 0 && plan.entities.length === 0 ? (
          <p className="text-body text-ink-faint">No task type or named thing was recognised.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {plan.task_types.map((t) => (
              <Chip key={t.id} title={t.matched.length ? `Matched: ${t.matched.join(", ")}` : undefined}>
                {t.label}
              </Chip>
            ))}
            {plan.entities.map((e) => (
              <NodeChip key={e.id} id={e.id} label={e.label} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Nodes this mission will fire">
        {plan.fire.length === 0 ? (
          <p className="text-body text-ink-faint">The plan fires no nodes.</p>
        ) : (
          <ul className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2">
            {plan.fire.map((f) => (
              <li key={f.id} className="min-w-0">
                <NodeChip id={f.id} />
                <div className="mt-1 h-1 w-full rounded-sm bg-sunken">
                  <div className="h-1 rounded-sm bg-signal" style={{ width: `${Math.max(2, Math.round((f.a / top) * 100))}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Read first">
        {plan.load.length === 0 ? (
          <p className="text-body text-ink-faint">No files are listed to read first.</p>
        ) : (
          <ul className="divide-y divide-rule">
            {plan.load.map((l) => (
              <li key={l.path} className="flex min-w-0 items-center gap-3 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-small text-ink" title={l.path}>
                    {l.path}
                  </p>
                  <p className="truncate text-small text-ink-soft">{l.reason}</p>
                </div>
                <Button onClick={() => openPath(l.path)}>Open</Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Steps">
        {plan.steps.length === 0 ? (
          <p className="text-body text-ink-faint">The plan has no steps.</p>
        ) : (
          <ol className="space-y-1.5">
            {plan.steps.map((s, i) => (
              <li key={`${s.agent}-${i}`} className="flex min-w-0 items-baseline gap-3 rounded-md border border-rule bg-raised px-3 py-1.5">
                <span className="shrink-0 font-mono text-small text-ink">{s.agent}</span>
                <span className="min-w-0 text-body text-ink-soft">{s.purpose}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Gates">
        {plan.gates.length === 0 ? (
          <p className="text-body text-ink-faint">No gates apply to this task.</p>
        ) : (
          <ul className="divide-y divide-rule">
            {plan.gates.map((g) => (
              <li key={g.node} className="flex min-w-0 items-center gap-3 py-1.5">
                <NodeChip id={g.node} />
                <GateHow gate={g} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {plan.cautions.length > 0 ? (
        <Section title="Cautions">
          <ul className="space-y-1">
            {plan.cautions.map((c, i) => (
              <li key={i} className="text-body text-hold">
                {c}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

const GATE_KIND: Record<string, string> = {
  manual: "A check done by hand",
  agent: "A review by the checker agent",
  approval: "Needs your explicit yes",
  automatic: "Runs on its own at the end of each reply",
};

/** The command of a gate, or the kind of check in words when the gate has no command. */
function GateHow({ gate }: { gate: { node: string; command: string } }) {
  const node = useStore((s) => s.byId.get(gate.node));
  const kind = typeof node?.props?.kind === "string" ? node.props.kind : "";
  const hasCommand = gate.command && gate.command !== node?.label && kind !== "manual" && kind !== "agent" && kind !== "approval";
  if (hasCommand) {
    return (
      <code className="min-w-0 truncate font-mono text-small text-ink-soft" title={gate.command}>
        {gate.command}
      </code>
    );
  }
  return <span className="min-w-0 truncate text-small text-ink-faint">{GATE_KIND[kind] ?? "A check before the work goes to you"}</span>;
}
