import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Plan } from "@shared/types";
import type { AppProps } from "../registry";
import { Button } from "../../components/Button";
import { Empty } from "../../components/Empty";
import { StatusDot } from "../../components/StatusDot";
import { api } from "../../lib/api";
import { bus } from "../../lib/bus";
import { setState, useStore } from "../../lib/store";
import { toast } from "../../shell/toastStore";
import { firstLine, formatCost, shortTime, stateTone, totalCost } from "./format";
import { missionsAllowed } from "../setup/model";
import { refreshClaude, refreshSetup, useSetupStore } from "../setup/state";
import { MissionDetail } from "./MissionDetail";
import { RunsNotice } from "./RunsNotice";
import { PlanView } from "./PlanView";

const PLACEHOLDER =
  "Describe the task, for example: review the tests in this project and list the ones that do not check behaviour";

function Composer({ prompt, setPrompt, onStarted }: { prompt: string; setPrompt: (p: string) => void; onStarted: (id: string) => void }) {
  const loggedIn = useStore((s) => s.status?.claude.logged_in);
  const setup = useSetupStore((s) => s.setup);
  const claude = useSetupStore((s) => s.claude);
  useEffect(() => {
    void refreshSetup();
    void refreshClaude();
  }, []);
  // The consent and the sign-in decide when the server reports them. An older server falls back to the status route.
  const gate = setup ? missionsAllowed(setup, claude) : null;
  const blocked = gate ? !gate.allowed : loggedIn === false;
  const reason = gate ? gate.reason : "Claude Code is not signed in.";
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<"plan" | "start" | null>(null);

  const clearPreview = () => bus.emit("preview", { activation: [], label: "" });

  // Editing the task makes the old plan stale.
  const [planFor, setPlanFor] = useState(prompt);
  if (planFor !== prompt) {
    setPlanFor(prompt);
    setPlan(null);
  }

  useEffect(() => () => clearPreview(), []);

  const makePlan = async () => {
    if (!prompt.trim()) return;
    setBusy("plan");
    try {
      const p = await api.plan(prompt);
      setPlan(p);
      bus.emit("preview", { activation: p.fire.map((f) => ({ id: f.id, a: f.a, hop: 0, via: null })), label: "Mission plan" });
    } catch (e) {
      toast(`The plan could not be made. ${e instanceof Error ? e.message : ""}`.trim(), "error");
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    setBusy("start");
    try {
      const { id } = await api.startMission(prompt, plan ?? undefined);
      const list = await api.missions().catch(() => null);
      if (list) setState({ missions: list.missions });
      clearPreview();
      onStarted(id);
    } catch (e) {
      toast(`The mission could not be started. ${e instanceof Error ? e.message : ""}`.trim(), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="h-full min-w-0 overflow-y-auto">
      <div className="p-4">
        {blocked ? <RunsNotice reason={reason} /> : null}
        <label htmlFor="mission-prompt" className="mb-1.5 block text-small font-medium text-ink-soft">
          Task
        </label>
        <textarea
          id="mission-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={PLACEHOLDER}
          rows={5}
          className="w-full resize-y rounded-md border border-rule-strong bg-sunken px-3 py-2 text-body text-ink placeholder:text-ink-faint"
        />
        <div className="mt-2 flex gap-2">
          <Button variant={plan ? "secondary" : "primary"} disabled={!prompt.trim() || busy !== null} onClick={makePlan}>
            {busy === "plan" ? "Planning" : "Plan"}
          </Button>
          {plan ? (
            <>
              <Button variant="primary" disabled={busy !== null || blocked} onClick={start}>
                {busy === "start" ? "Starting" : "Start mission"}
              </Button>
              <Button
                onClick={() => {
                  setPlan(null);
                  clearPreview();
                }}
              >
                Clear
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {plan ? <PlanView plan={plan} /> : null}
    </div>
  );
}

export function MissionsApp({ params }: AppProps) {
  const missions = useStore((s) => s.missions);
  const [selected, setSelected] = useState<string>("new");
  const [prompt, setPrompt] = useState(params?.prompt ?? "");

  // A new params object means the window was opened again, for example from the palette.
  const [seenParams, setSeenParams] = useState(params);
  if (params !== seenParams) {
    setSeenParams(params);
    if (params?.prompt !== undefined) {
      setPrompt(params.prompt);
      setSelected("new");
    }
  }

  const sorted = [...missions].sort((a, b) => b.created.localeCompare(a.created));
  const current = selected === "new" ? null : (missions.find((m) => m.id === selected) ?? null);

  return (
    <div className="grid h-full min-h-0 grid-cols-[260px_minmax(0,1fr)]">
      <aside className="flex min-h-0 min-w-0 flex-col border-r border-rule bg-sunken">
        <div className="border-b border-rule p-3">
          <Button className="w-full" icon={<Plus size={14} aria-hidden="true" />} onClick={() => setSelected("new")}>
            New mission
          </Button>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-1" aria-label="Missions">
          {sorted.length === 0 ? <Empty>No missions yet.</Empty> : null}
          {sorted.map((m) => {
            const cost = formatCost(totalCost(m));
            const on = m.id === selected;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  aria-current={on}
                  onClick={() => setSelected(m.id)}
                  className={`flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${on ? "bg-raised" : "hover:bg-raised"}`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <StatusDot tone={stateTone(m.state)} label={m.state} />
                    <span className="min-w-0 truncate text-body text-ink">{firstLine(m.prompt)}</span>
                  </span>
                  <span className="num pl-4 text-caption text-ink-faint">
                    {shortTime(m.created)}
                    {cost ? `, ${cost}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
      <main className="min-h-0 min-w-0">
        {current ? (
          <MissionDetail key={current.id} initial={current} />
        ) : (
          <Composer prompt={prompt} setPrompt={setPrompt} onStarted={setSelected} />
        )}
      </main>
    </div>
  );
}
