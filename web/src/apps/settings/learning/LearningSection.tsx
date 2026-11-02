// The Learning section of Settings: the switches of the learning record, and the prompt fragments with their overrides.
// SettingsApp.tsx mounts <LearningSection /> once. Each change writes the whole record, read just before, so that a stale
// window cannot bring back a value that another window cleared.
import { useCallback, useEffect, useState } from "react";
import type { LearnSettings } from "@shared/learn/models";
import { Section } from "../../../components/Section";
import { failureText } from "../../../lib/learn/http";
import { learnModels } from "../../../lib/learn/models";
import { Loading, Notice, SettingRow, Switch } from "../models/parts";
import { NUMBER_FIELDS, graphOn, parseNumber, readNumber, toolOn, withGraph, withNumber, withTool, type NumberField, type ToolName } from "./fields";
import { PromptsPanel } from "./PromptsPanel";

function NumberRow({ field, value, onCommit }: { field: NumberField; value: number | undefined; onCommit: (v: number | undefined) => Promise<void> }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    // the record changed under us, so the field follows it
    setShown(value);
    setText(value === undefined ? "" : String(value));
  }
  const commit = async () => {
    const r = parseNumber(text, field);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    if (r.value !== value) await onCommit(r.value);
  };
  return (
    <SettingRow label={field.label} hint={`${field.hint} The default is ${field.fallback.toLocaleString("en-GB")}.`}>
      <div className="flex min-w-0 items-center gap-2">
        <input
          inputMode="numeric"
          aria-label={field.label}
          value={text}
          placeholder={field.fallback.toLocaleString("en-GB")}
          className="num h-8 w-32 min-w-0 rounded-md border border-rule-strong bg-sunken px-2 text-right font-mono text-body text-ink placeholder:text-ink-faint"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
          }}
        />
        <span className="text-small text-ink-soft">{field.unit}</span>
      </div>
      {error ? <Notice text={error} tone="error" /> : null}
    </SettingRow>
  );
}

const TOOLS: { name: ToolName; label: string; hint: string }[] = [
  { name: "research", label: "Research agent", hint: "Lets the teacher ask a helper to search the web and write a brief." },
  { name: "pdf", label: "PDF reader", hint: "Lets the teacher ask a helper to read a PDF that you name." },
  { name: "explain", label: "Free recall questions", hint: "Questions are answered in your own words, in place of multiple choice." },
];

export function LearningSection() {
  const [settings, setSettings] = useState<LearnSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    learnModels
      .settings()
      .then((s) => live && setSettings(s))
      .catch((e: unknown) => live && setError(failureText(e, "The learning settings could not be read.")));
    return () => {
      live = false;
    };
  }, []);

  const change = useCallback(async (edit: (s: LearnSettings) => LearnSettings) => {
    try {
      const fresh = await learnModels.settings();
      setSettings(await learnModels.saveSettings(edit(fresh)));
      setError(null);
    } catch (e) {
      setError(failureText(e, "The change could not be saved."));
    }
  }, []);

  return (
    <>
      <Section title="Learning" note="These choices apply to every lesson and to the reading of linked sources. A change is saved as soon as you make it.">
        {settings ? (
          <div className="divide-y divide-rule">
            <SettingRow label="Claims from lessons and sources" hint="Reads sessions and files for claims and builds the knowledge layer.">
              <Switch checked={graphOn(settings)} label={graphOn(settings) ? "On" : "Off"} onChange={(on) => void change((s) => withGraph(s, on))} />
            </SettingRow>
            {TOOLS.map((t) => (
              <SettingRow key={t.name} label={t.label} hint={t.hint}>
                <Switch checked={toolOn(settings, t.name)} label={toolOn(settings, t.name) ? "On" : "Off"} onChange={(on) => void change((s) => withTool(s, t.name, on))} />
              </SettingRow>
            ))}
            {NUMBER_FIELDS.map((f) => (
              <NumberRow key={f.key} field={f} value={readNumber(settings, f.key)} onCommit={(v) => change((s) => withNumber(s, f.key, v))} />
            ))}
          </div>
        ) : error ? null : (
          <Loading what="the learning settings" />
        )}
        <Notice text={error} tone="error" />
      </Section>
      <Section title="Prompt fragments" note="Each agent is briefed by numbered fragments. You can replace one with your own text. Your version runs from the next turn, and the built in version stays here for comparison.">
        <PromptsPanel />
      </Section>
    </>
  );
}
