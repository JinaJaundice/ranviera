import { useState } from "react";
import type { ClaudeCodeStatus } from "@shared/learn/models";
import { Button } from "../../../components/Button";
import { StatusDot } from "../../../components/StatusDot";
import { learnModels, noticeFor } from "../../../lib/learn/models";
import { Notice, Switch } from "./parts";
import { applyClaude, applySettings, reloadCatalogue, useModelsStore } from "./state";

const when = (iso: string | undefined) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString("en-GB") : null);

function statusLine(s: ClaudeCodeStatus): { tone: "pass" | "hold" | "idle"; text: string } {
  if (!s.enabled) return { tone: "idle", text: "Off. This app does not look for the command line tool while this switch is off." };
  if (s.state === "meets-minimum") return { tone: "pass", text: `Found, version ${s.version ?? "not reported"}. The minimum is ${s.minimumVersion}.` };
  if (s.state === "update-required") return { tone: "hold", text: `Found, version ${s.version ?? "not reported"}, which is below the minimum of ${s.minimumVersion}. Update Claude Code.` };
  if (s.state === "not-found") return { tone: "hold", text: "Not found. Install Claude Code and sign in to it outside this app, then check again." };
  return { tone: "hold", text: "Found, but the version could not be checked." };
}

/** The status of the command line tool and its two opt-in switches. */
export function ClaudeCodePanel() {
  const claude = useModelsStore((s) => s.claude);
  const settings = useModelsStore((s) => s.settings);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  if (!claude || !settings) return null;
  const cc = settings.claudeCode ?? {};

  const change = async (patch: { enabled?: boolean; allowBackground?: boolean }) => {
    setBusy(true);
    try {
      const saved = await learnModels.saveSettings({ ...settings, claudeCode: { ...cc, ...patch } });
      applySettings(saved);
      applyClaude(await learnModels.claudeCode());
      await reloadCatalogue();
      setNotice(null);
    } catch (e) {
      setNotice(noticeFor(e));
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setBusy(true);
    try {
      applyClaude(await learnModels.claudeCode());
      await reloadCatalogue();
      setNotice(null);
    } catch (e) {
      setNotice(noticeFor(e));
    } finally {
      setBusy(false);
    }
  };
  const line = statusLine(claude);
  const enabledAt = when(cc.enabledAt);
  const backgroundAt = when(cc.allowBackgroundAt);

  return (
    <div className="min-w-0">
      <p role="status" className="flex min-w-0 items-center gap-2 text-body text-ink">
        <StatusDot tone={line.tone} />
        <span className="min-w-0">{line.text}</span>
      </p>
      <div className="mt-2 flex min-w-0 flex-col gap-2">
        <Switch checked={cc.enabled === true} disabled={busy} onChange={(enabled) => void change({ enabled })} label="Use Claude Code as a model" />
        {enabledAt ? <p className="pl-6 text-small text-ink-faint">Switched on {enabledAt}.</p> : null}
        <Switch
          checked={cc.allowBackground === true}
          disabled={busy || cc.enabled !== true}
          onChange={(allowBackground) => void change({ allowBackground })}
          label="Allow background use, such as reading sources and research"
        />
        {backgroundAt ? <p className="pl-6 text-small text-ink-faint">Background use switched on {backgroundAt}.</p> : null}
      </div>
      <p className="mt-2 text-small text-ink-faint">Claude Code is billed by the command line tool under your own account and is shown as unpriced. This app never signs in for you and stores no Claude credential.</p>
      {cc.enabled === true ? (
        <div className="mt-2">
          <Button onClick={() => void check()} disabled={busy}>
            Check again
          </Button>
        </div>
      ) : null}
      <Notice text={notice?.text ?? null} tone={notice?.tone ?? "info"} />
    </div>
  );
}
