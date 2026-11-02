import { useState } from "react";
import type { AuthKeyStatus } from "@shared/learn/models";
import { Button } from "../../../components/Button";
import { StatusDot } from "../../../components/StatusDot";
import { keyLine, keyStateWord, learnModels, noticeFor } from "../../../lib/learn/models";
import { FIELD, SELECT } from "./fields";
import { Notice } from "./parts";
import { reloadCatalogue, useModelsStore } from "./state";

/** Names that a person may add, with the label of each. Search keys come after the providers. */
function addable(keys: AuthKeyStatus[], providers: { id: string; envVar: string; label: string }[]): { id: string; label: string }[] {
  const present = new Set(keys.map((k) => k.id));
  const byVar = new Map<string, string[]>();
  for (const p of providers) byVar.set(p.envVar, [...(byVar.get(p.envVar) ?? []), p.label]);
  const out = [...byVar.entries()].filter(([v]) => !present.has(v)).map(([id, labels]) => ({ id, label: labels.join(" and ") }));
  for (const [id, label] of [["TAVILY_API_KEY", "Tavily web search"], ["BRAVE_API_KEY", "Brave web search"]] as const) if (!present.has(id)) out.push({ id, label });
  return out.sort((a, b) => a.label.localeCompare(b.label, "en-GB"));
}

function PasteRow({ name, label, onDone }: { name: string; label: string; onDone: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const save = async () => {
    setBusy(true);
    try {
      await learnModels.saveKey(name, value);
      setValue("");
      await reloadCatalogue();
      onDone();
    } catch (e) {
      setNotice(noticeFor(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="min-w-0 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={`Key for ${label}`}
          placeholder="Paste key"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={`${FIELD} w-72 max-w-full font-mono`}
        />
        <Button type="submit" variant="primary" disabled={busy || !value.trim()}>
          {busy ? "Saving" : "Save"}
        </Button>
        <Button onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
      <Notice text={notice?.text ?? null} tone={notice?.tone ?? "info"} />
    </form>
  );
}

function KeyRow({ status }: { status: AuthKeyStatus }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const label = status.info?.label ?? status.id;
  const envOnly = status.source === "env" && !status.shadowedByEnv;
  const remove = async () => {
    setBusy(true);
    try {
      await learnModels.removeKey(status.id);
      await reloadCatalogue();
    } catch (e) {
      setNotice(noticeFor(e));
      setBusy(false);
    }
  };
  return (
    <li className={`min-w-0 border-b border-rule py-1.5 last:border-b-0 ${envOnly ? "opacity-70" : ""}`}>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2 text-body text-ink">
            <StatusDot tone="pass" />
            <span className="min-w-0 truncate">{label}</span>
            <span className="shrink-0 text-small text-ink-soft">{keyStateWord(status)}</span>
          </div>
          <div className="mt-0.5 min-w-0 font-mono text-small text-ink-faint">
            {status.id} <span className="text-ink-soft">{keyLine(status)}</span>
          </div>
          {status.shadowedByEnv ? <p className="mt-0.5 text-small text-hold">An environment variable of the same name wins over the saved key, so the saved key is not used.</p> : null}
          {status.info?.docsUrl ? (
            <a className="text-small text-signal underline" href={status.info.docsUrl} target="_blank" rel="noreferrer">
              Where to create a key
            </a>
          ) : null}
        </div>
        {!editing && !envOnly ? (
          <div className="flex shrink-0 gap-2">
            <Button onClick={() => setEditing(true)} disabled={busy}>
              Replace
            </Button>
            <Button onClick={() => void remove()} disabled={busy}>
              Remove
            </Button>
          </div>
        ) : null}
      </div>
      {editing ? <PasteRow name={status.id} label={label} onDone={() => setEditing(false)} /> : null}
      <Notice text={notice?.text ?? null} tone={notice?.tone ?? "info"} />
    </li>
  );
}

/** The keys that are present, masked, with Save and Remove, and a menu to add a provider. */
export function KeysPanel() {
  const keys = useModelsStore((s) => s.keys);
  const [adding, setAdding] = useState<string>("");
  if (!keys) return null;
  const choices = addable(keys.keys, keys.providers);
  const chosen = choices.find((c) => c.id === adding);
  return (
    <div className="min-w-0">
      {keys.keys.length === 0 ? <p className="text-small text-ink-faint">No keys are saved. Add the key of a provider to list its models.</p> : null}
      <ul className="min-w-0">
        {keys.keys.map((k) => (
          <KeyRow key={k.id} status={k} />
        ))}
      </ul>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        <select aria-label="Add a provider" className={`${SELECT} w-64 max-w-full`} value={adding} onChange={(e) => setAdding(e.target.value)}>
          <option value="">Add a provider</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      {chosen ? <PasteRow key={chosen.id} name={chosen.id} label={chosen.label} onDone={() => setAdding("")} /> : null}
    </div>
  );
}
