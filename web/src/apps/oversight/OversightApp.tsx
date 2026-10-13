import { useState } from "react";
import type { OversightStatus } from "@shared/types";
import type { AppProps } from "../registry";
import { Chip } from "../../components/Chip";
import { Empty } from "../../components/Empty";
import { api, setActingAs } from "../../lib/api";
import { CoverageTab } from "./CoverageTab";
import { DecisionsTab } from "./DecisionsTab";
import { InstructionsTab } from "./InstructionsTab";
import { useLoad } from "./load";
import { MonitoringTab } from "./MonitoringTab";
import { UNAVAILABLE_NOTE, type ScopeKind } from "./model";
import { PackTab } from "./PackTab";
import { PeopleContext } from "./people";
import { ErrorLine, INPUT, Loading, Tabs } from "./parts";
import { QueueTab } from "./QueueTab";

type Tab = "decisions" | "coverage" | "queue" | "instructions" | "monitoring" | "pack";

const TABS: { value: Tab; label: string }[] = [
  { value: "decisions", label: "Decisions" },
  { value: "coverage", label: "Coverage" },
  { value: "queue", label: "Review queue" },
  { value: "instructions", label: "Instructions" },
  { value: "monitoring", label: "Monitoring" },
  { value: "pack", label: "Evidence pack" },
];

function Actor({ status, onChange }: { status: OversightStatus; onChange: (id: string) => void }) {
  if (status.demo) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <label htmlFor="ov-acting" className="text-small text-ink-soft">Acting as</label>
        <select id="ov-acting" className={INPUT} value={status.actor ?? ""} onChange={(e) => onChange(e.target.value)}>
          {status.actor === null ? <option value="">No person</option> : null}
          {status.people.map((p) => (
            <option key={p.id} value={p.id}>{`${p.name} (${p.roles.join(", ")})`}</option>
          ))}
        </select>
        <Chip title="This installation is a demonstration, so any person on the list of people may be chosen.">Demonstration identity</Chip>
      </div>
    );
  }
  const who = status.people.find((p) => p.id === status.actor);
  return (
    <p className="min-w-0 truncate text-small text-ink-soft">
      {status.actor ? `Acting as ${who?.name ?? status.actor}${who ? ` (${who.roles.join(", ")})` : ""}` : "No person is set to act, so changes are refused."}
    </p>
  );
}

export function OversightApp(props: AppProps) {
  void props;
  const status = useLoad(() => api.oversightStatus(), "status");
  const [tab, setTab] = useState<Tab>("decisions");
  const [seen, setSeen] = useState<Tab[]>(["decisions"]);
  const [preset, setPreset] = useState<{ kind: ScopeKind; value: string; n: number } | null>(null);
  const choose = (t: Tab) => {
    setTab(t);
    setSeen((s) => (s.includes(t) ? s : [...s, t]));
  };
  const exportRun = (run: string) => {
    setPreset((p) => ({ kind: "run", value: run, n: (p?.n ?? 0) + 1 }));
    choose("pack");
  };
  const switchActor = (id: string) => {
    setActingAs(id);
    status.reload();
  };
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface text-ink">
      <Loading load={status} what="the oversight status">
        {(s) =>
          !s.available ? (
            <Empty>{UNAVAILABLE_NOTE}</Empty>
          ) : (
            <PeopleContext.Provider value={s.people}>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-2">
                <Tabs tabs={TABS} value={tab} onChange={choose} />
                <Actor status={s} onChange={switchActor} />
              </div>
              {status.error ? <ErrorLine>{status.error}</ErrorLine> : null}
              <div className="min-h-0 min-w-0 flex-1">
                {TABS.map((t) =>
                  seen.includes(t.value) ? (
                    <div key={t.value} role="tabpanel" id={`ov-panel-${t.value}`} aria-labelledby={`ov-tab-${t.value}`} hidden={tab !== t.value} className="h-full min-h-0 min-w-0">
                      {t.value === "decisions" ? <DecisionsTab onExport={exportRun} /> : null}
                      {t.value === "coverage" ? <CoverageTab /> : null}
                      {t.value === "queue" ? <QueueTab people={s.people} acting={{ actor: s.actor, demo: s.demo }} /> : null}
                      {t.value === "instructions" ? <InstructionsTab /> : null}
                      {t.value === "monitoring" ? <MonitoringTab /> : null}
                      {t.value === "pack" ? <PackTab key={preset?.n ?? 0} preset={preset} /> : null}
                    </div>
                  ) : null,
                )}
              </div>
            </PeopleContext.Provider>
          )
        }
      </Loading>
    </div>
  );
}
