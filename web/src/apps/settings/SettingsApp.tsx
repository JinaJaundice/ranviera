import { useEffect, useState } from "react";
import { FolderOpen, RotateCcw } from "lucide-react";
import { Button } from "../../components/Button";
import { Section } from "../../components/Section";
import { StatusDot } from "../../components/StatusDot";
import { api } from "../../lib/api";
import { useStore } from "../../lib/store";
import { toast } from "../../shell/toastStore";
import { ClaudeConnect } from "../setup/ClaudeConnect";
import { MISSIONS_STATEMENT, nonAffiliation, useProductName } from "../setup/copy";
import { HooksPanel } from "../setup/HooksPanel";
import { missionsAllowed } from "../setup/model";
import { ReadPanel } from "../setup/ReadPanel";
import { applySetup, openFirstRun, refreshSetup, useSetupStore } from "../setup/state";

const when = (iso: string | null | undefined) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString("en-GB") : null);

function DataFolder() {
  const dir = useStore((s) => s.status?.data_dir);
  return (
    <Section title="Data folder" note="The graph, the events and your own vocabulary are kept here. Nothing in it leaves this computer.">
      <div className="flex min-w-0 items-center gap-3">
        <code className="min-w-0 flex-1 break-words font-mono text-small text-ink">{dir ?? "Not reported by the server"}</code>
        {dir ? (
          <Button
            icon={<FolderOpen size={14} aria-hidden="true" />}
            onClick={() => api.open(dir).catch((e: unknown) => toast(`The folder could not be opened. ${e instanceof Error ? e.message : ""}`.trim(), "error"))}
          >
            Open
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

function AgentRuns() {
  const setup = useSetupStore((s) => s.setup);
  const claude = useSetupStore((s) => s.claude);
  const [busy, setBusy] = useState(false);
  const state = missionsAllowed(setup, claude);
  const agreed = when(setup?.missions_consent_at);
  const agree = async () => {
    setBusy(true);
    try {
      applySetup(await api.missionsConsent());
    } catch (e) {
      toast(`Your agreement could not be recorded. ${e instanceof Error ? e.message : ""}`.trim(), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Agent runs" note={MISSIONS_STATEMENT}>
      <p className="flex min-w-0 items-center gap-2 text-body text-ink" role="status">
        <StatusDot tone={state.allowed ? "pass" : "hold"} />
        <span className="min-w-0">{state.allowed ? "Agent runs are allowed." : `Agent runs are off. ${state.reason}`}</span>
      </p>
      {agreed ? <p className="mt-1 text-small text-ink-soft">You agreed on {agreed}.</p> : null}
      {!agreed ? (
        <div className="mt-3">
          <Button variant="primary" disabled={busy} onClick={() => void agree()}>
            I agree to agent runs under my own plan
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

export function SettingsApp() {
  const setup = useSetupStore((s) => s.setup);
  const error = useSetupStore((s) => s.setupError);
  const name = useProductName();
  useEffect(() => {
    void refreshSetup();
  }, []);

  return (
    <div className="h-full min-w-0 overflow-y-auto">
      {error ? <p className="px-4 pt-3 text-small text-block">The set-up could not be read. {error}</p> : null}
      <Section
        title="First run"
        note={setup?.accepted_at ? `You agreed to the terms on ${when(setup.accepted_at) ?? setup.accepted_at}.` : "The first run has not been completed."}
        action={
          <Button className="h-6 px-2 text-small" icon={<RotateCcw size={12} aria-hidden="true" />} onClick={() => openFirstRun(setup?.accepted_at ? 1 : 0)}>
            Repeat the steps
          </Button>
        }
      >
        <p className="text-small text-ink-soft">Any step can be repeated here, and nothing is read or installed until you agree to the step that does it.</p>
      </Section>
      <Section title={`About ${name}`}>
        <p className="text-small text-ink-soft">{nonAffiliation(name)}</p>
      </Section>
      <DataFolder />
      <Section title="Projects folder and set-up" note="The product reads your Claude folder and, when you name one, a projects folder. It then builds the graph again.">
        <ReadPanel labelAction="Save and read again" />
      </Section>
      <Section title="Hooks" note="Hooks add steps to the brain view as Claude Code works. Installing merges entries into your settings file and removal deletes only those entries.">
        <HooksPanel />
      </Section>
      <Section title="Claude Code">
        <ClaudeConnect />
      </Section>
      <AgentRuns />
    </div>
  );
}
