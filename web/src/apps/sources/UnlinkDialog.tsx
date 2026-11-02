// Unlinking a root. The dialog names the deletion mode and its impact before anything changes, and the route needs an
// explicit mode, so neither choice is ticked when it opens. A failure keeps the dialog open with the server's sentence.
import { useState } from "react";
import type { DeletionMode } from "@shared/learn/knowledge";
import type { RootSummary } from "@shared/learn/sources";
import { Button } from "../../components/Button";
import { failureText } from "../../lib/learn/http";
import { learnSources } from "../../lib/learn/sources";
import { Dialog } from "./parts";

export function impactLines(root: Pick<RootSummary, "counts" | "label">, mode: DeletionMode): string[] {
  const files = root.counts.files;
  const read = root.counts.current;
  const fileWord = `${files} ${files === 1 ? "file" : "files"}`;
  const first = `${root.label} is unlinked and its ${fileWord} stop being tracked. The files on disk never change.`;
  if (mode === "preserve-graph") {
    return [first, `The propositions and arguments already read from it stay in the graph, so ${read} ${read === 1 ? "file keeps" : "files keep"} its knowledge but no later scan will update it.`];
  }
  return [
    first,
    `The propositions and arguments that rest only on these files are deleted from the graph, along with the record of what was read. Anything that other sources also support stays. This cannot be undone.`,
  ];
}

const MODES: { value: DeletionMode; name: string; hint: string }[] = [
  { value: "preserve-graph", name: "Keep the knowledge", hint: "Unlink the root and leave every proposition and argument in the graph." },
  { value: "delete-nodes", name: "Delete the knowledge", hint: "Unlink the root and delete what only these files support." },
];

export function UnlinkDialog({ root, onClose, onDone }: { root: RootSummary; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<DeletionMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    if (!mode) return;
    setBusy(true);
    setError(null);
    try {
      await learnSources.remove(root.id, mode);
      onDone();
    } catch (e) {
      setError(failureText(e, "The root could not be unlinked."));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Unlink ${root.label}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="secondary" className="border-block text-block" disabled={!mode || busy} onClick={() => void confirm()}>
            {busy ? "Unlinking" : "Unlink"}
          </Button>
        </>
      }
    >
      <fieldset className="min-w-0 space-y-2" disabled={busy}>
        <legend className="mb-2 text-body text-ink-soft">Choose what happens to the knowledge read from this root.</legend>
        {MODES.map((m) => (
          <label key={m.value} className={`flex min-w-0 cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${mode === m.value ? "border-signal bg-signal-soft" : "border-rule-strong"}`}>
            <input type="radio" name="unlink-mode" className="mt-1 accent-signal" checked={mode === m.value} onChange={() => setMode(m.value)} />
            <span className="min-w-0">
              <span className="block text-body font-medium text-ink">{m.name}</span>
              <span className="block text-small text-ink-soft">{m.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="mt-3 min-w-0 space-y-1" aria-live="polite">
        {mode ? impactLines(root, mode).map((l) => <p key={l} className="text-small text-ink-soft">{l}</p>) : <p className="text-small text-ink-faint">The effect of each choice appears here.</p>}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-body text-block">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
