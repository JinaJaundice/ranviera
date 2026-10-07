import { useEffect, useState } from "react";
import { Check, Copy, Plug, Unplug } from "lucide-react";
import { Button } from "../../components/Button";
import { StatusDot } from "../../components/StatusDot";
import { api } from "../../lib/api";
import { toast } from "../../shell/toastStore";
import { describeHook, hooksJson } from "./model";
import { refreshHooks, refreshSetup, useSetupStore } from "./state";

/** The hook entries in plain words, the exact JSON that is added, and the install and remove buttons. */
export function HooksPanel({ showJson = true }: { showJson?: boolean }) {
  const hooks = useSetupStore((s) => s.hooks);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void refreshHooks();
  }, []);

  const saved = (backup: string | null) => (backup ? ` The previous settings file is saved in ${backup}.` : " There was no earlier settings file to save.");

  const run = async (kind: "install" | "remove") => {
    setBusy(true);
    try {
      if (kind === "install") {
        const r = await api.installHooks();
        setMessage(`The hooks are installed.${saved(r.backup)}`);
      } else {
        const r = await api.uninstallHooks();
        setMessage(`${r.removed} hook ${r.removed === 1 ? "entry was" : "entries were"} removed.${saved(r.backup)}`);
      }
      await Promise.all([refreshHooks(), refreshSetup()]);
    } catch (e) {
      toast(`The hooks could not be changed. ${e instanceof Error ? e.message : ""}`.trim(), "error");
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!hooks) return;
    navigator.clipboard
      .writeText(hooksJson(hooks.entries))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => toast("The text could not be copied.", "error"));
  };

  if (!hooks) return <p className="text-body text-ink-faint">Reading the hook entries.</p>;

  return (
    <div className="min-w-0">
      <p className="flex min-w-0 items-center gap-2 text-body text-ink" role="status">
        <StatusDot tone={hooks.installed ? "pass" : "idle"} />
        <span className="font-medium">{hooks.installed ? "Hooks installed" : "Hooks not installed"}</span>
      </p>
      <p className="mt-1 break-words text-small text-ink-soft">
        The file is <code className="font-mono">{hooks.settings_path}</code>. A dated backup is written to <code className="font-mono">{hooks.backup_dir}</code> before each change, and every other entry in the file stays as it is.
      </p>
      <ul className="mt-3 min-w-0 divide-y divide-rule rounded-md border border-rule" aria-label="Hook entries">
        {hooks.entries.map((e, i) => (
          <li key={`${e.event}-${e.matcher ?? ""}-${i}`} className="grid min-w-0 grid-cols-[150px_minmax(0,1fr)] gap-3 px-3 py-1.5">
            <span className="min-w-0 truncate font-mono text-small text-ink">{e.event}</span>
            <span className="min-w-0 text-small text-ink-soft">{describeHook(e)}</span>
          </li>
        ))}
      </ul>
      {showJson ? (
        <details className="mt-3 min-w-0">
          <summary className="cursor-pointer text-small font-medium text-ink-soft hover:text-ink">The exact JSON that is added</summary>
          <div className="relative mt-2 min-w-0">
            <pre className="max-h-56 overflow-auto rounded-md border border-rule bg-sunken p-3 font-mono text-small text-ink">{hooksJson(hooks.entries)}</pre>
            <Button
              className="absolute right-2 top-2 h-6 px-2 text-small"
              icon={copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
              onClick={copy}
              aria-label="Copy the JSON"
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </details>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {hooks.installed ? (
          <Button icon={<Unplug size={14} aria-hidden="true" />} disabled={busy} onClick={() => void run("remove")}>
            Remove the hooks
          </Button>
        ) : (
          <Button variant="primary" icon={<Plug size={14} aria-hidden="true" />} disabled={busy} onClick={() => void run("install")}>
            Install the hooks
          </Button>
        )}
      </div>
      {message ? (
        <p className="mt-2 break-words text-small text-ink-soft" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
