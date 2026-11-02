// The prompt fragments of the agents and their overrides (routes 13 to 15). An override is the full replacement text of one
// fragment. It runs only while its switch is on, and saving a text turns the switch on in the same step, file first.
import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { PromptEntry, PromptList } from "@shared/learn/models";
import { Button } from "../../../components/Button";
import { failureText } from "../../../lib/learn/http";
import { AGENT_WORDS, learnPrompts, removeOverride, saveOverride, sectionedPrompts, setOverrideOn } from "../../../lib/learn/prompts";
import { useStore } from "../../../lib/store";
import { Loading, SettingRow, Switch } from "../models/parts";

const AREA = "w-full min-w-0 rounded-md border border-rule-strong bg-sunken px-3 py-2 font-mono text-small text-ink placeholder:text-ink-faint";

function Row({ entry, open, onToggle, onChanged }: { entry: PromptEntry; open: boolean; onToggle: () => void; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState(entry.override ?? "");
  const [status, setStatus] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = draft !== (entry.override ?? "");
  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await what();
      await onChanged();
      setStatus({ tone: "info", text: done });
    } catch (e) {
      setStatus({ tone: "error", text: failureText(e, "That change could not be saved.") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="border-b border-rule py-2 last:border-b-0">
      <SettingRow label={entry.key} hint={entry.enabled ? "Your version is in use" : entry.override !== null ? "Saved, and switched off" : undefined}>
        <div className="flex items-center justify-between gap-3">
          <Switch checked={entry.enabled} disabled={entry.override === null || busy} label={entry.enabled ? "Your version" : "Built in version"} onChange={(on) => void run(() => setOverrideOn(entry.key, on), on ? "Your version is in use." : "The built in version is in use.")} />
          <Button variant="ghost" className="h-7 text-small" aria-expanded={open} icon={<ChevronRight size={14} aria-hidden="true" className={open ? "rotate-90" : ""} />} onClick={onToggle}>
            {open ? "Hide text" : "Show text"}
          </Button>
        </div>
      </SettingRow>
      {open ? (
        <div className="mt-1 grid min-w-0 grid-cols-1 gap-3">
          <label className="block min-w-0">
            <span className="mb-1 block text-small font-medium text-ink-soft">Built in version</span>
            <textarea readOnly rows={8} value={entry.source} className={`${AREA} opacity-80`} />
          </label>
          <label className="block min-w-0">
            <span className="mb-1 block text-small font-medium text-ink-soft">Your version</span>
            <textarea rows={8} value={draft} placeholder="Write your own instructions for this fragment" className={AREA} onChange={(e) => setDraft(e.target.value)} />
            <span className="mt-1 block text-caption text-ink-soft">An empty version that is switched on removes the fragment from the prompt.</span>
          </label>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button variant="primary" disabled={!dirty || busy} onClick={() => void run(() => saveOverride(entry.key, draft), "Saved, and your version is in use.")}>
              Save
            </Button>
            {entry.override !== null ? (
              <Button disabled={busy} onClick={() => void run(async () => { await removeOverride(entry.key); setDraft(""); }, "Deleted. The built in version is in use.")}>
                Delete
              </Button>
            ) : null}
            {status ? (
              <p role={status.tone === "error" ? "alert" : "status"} className={`min-w-0 break-words text-small ${status.tone === "error" ? "text-block" : "text-ink-soft"}`}>
                {status.text}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function PromptsPanel() {
  const [list, setList] = useState<PromptList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const signal = useStore((s) => s.learnSignals["settings-changed"] ?? 0);

  const [bump, setBump] = useState(0);
  // the last good view stays on show when a read fails
  useEffect(() => {
    let live = true;
    learnPrompts
      .list()
      .then((l) => {
        if (!live) return;
        setList(l);
        setError(null);
      })
      .catch((e: unknown) => live && setError(failureText(e, "The prompt fragments could not be read.")));
    return () => {
      live = false;
    };
  }, [signal, bump]);
  const load = useCallback(async () => setBump((n) => n + 1), []);

  if (!list) return error ? <p role="alert" className="text-small text-block">{error}</p> : <Loading what="the prompt fragments" />;
  const sections = sectionedPrompts(list);
  const groups: { title: string; hint?: string; entries: PromptEntry[] }[] = [
    { title: AGENT_WORDS.teacher, entries: sections.teacher },
    { title: AGENT_WORDS.prober, entries: sections.prober },
    { title: AGENT_WORDS.practice, entries: sections.practice },
    { title: "Shared", hint: "Used by every agent that composes them", entries: sections.shared },
  ].filter((g) => g.entries.length);
  return (
    <div className="space-y-4">
      {error ? <p role="alert" className="text-small text-block">{error}</p> : null}
      {groups.map((g) => (
        <div key={g.title}>
          <h4 className="text-body font-medium text-ink">{g.title}</h4>
          {g.hint ? <p className="text-small text-ink-faint">{g.hint}</p> : null}
          <ul className="mt-1">
            {g.entries.map((e) => (
              <Row key={e.key} entry={e} open={open === e.key} onToggle={() => setOpen(open === e.key ? null : e.key)} onChanged={load} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
