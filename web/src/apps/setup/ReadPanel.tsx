import { useState } from "react";
import { FolderSearch } from "lucide-react";
import { Button } from "../../components/Button";
import { StatusDot } from "../../components/StatusDot";
import { api } from "../../lib/api";
import { applySetup, useSetupStore } from "./state";

/** The folders that are read, the optional projects folder, and the button that builds the graph. */
export function ReadPanel({ labelAction }: { labelAction: string }) {
  const setup = useSetupStore((s) => s.setup);
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = folder ?? setup?.projects_root ?? "";

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      applySetup(await api.readSetup(value.trim() === "" ? null : value.trim()));
      setFolder(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The set-up could not be read.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0">
      <p className="text-small font-medium text-ink-soft">Folders that are read</p>
      <ul className="mt-1 min-w-0 divide-y divide-rule rounded-md border border-rule text-small">
        <li className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5 px-3 py-1.5">
          <span className="min-w-0 break-words font-mono text-ink">{setup?.claude_home ?? "~/.claude"}</span>
          <span className="text-ink-soft">
            CLAUDE.md, the rules, skills, agents and settings files, and the memory folders of your projects
            {setup && !setup.claude_home_found ? ". The folder was not found, so the graph starts from the starting vocabulary only." : "."}
          </span>
        </li>
      </ul>
      <label htmlFor="projects-folder" className="mb-1 mt-3 block text-small font-medium text-ink-soft">
        Projects folder (optional)
      </label>
      <input
        id="projects-folder"
        value={value}
        onChange={(e) => setFolder(e.target.value)}
        placeholder="For example C:/Users/you/Projects"
        spellCheck={false}
        className="h-8 w-full min-w-0 rounded-md border border-rule-strong bg-sunken px-3 font-mono text-small text-ink placeholder:text-ink-faint"
      />
      <p className="mt-1 text-small text-ink-soft">With a folder, the product also reads the project notes in it. Leave it empty to read none.</p>
      <p className="mt-2 text-small text-ink-soft">Nothing leaves this computer.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={<FolderSearch size={14} aria-hidden="true" />} disabled={busy} onClick={() => void run()}>
          {busy ? "Reading" : labelAction}
        </Button>
        {setup?.counts && setup.read_consent_at ? (
          <p className="num flex items-center gap-2 text-body text-ink" role="status">
            <StatusDot tone="pass" />
            {setup.counts.nodes} nodes and {setup.counts.edges} links
          </p>
        ) : null}
      </div>
      {error ? (
        <p className="mt-2 text-small text-block" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
