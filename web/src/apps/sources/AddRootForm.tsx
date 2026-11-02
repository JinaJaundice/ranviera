// The form that links a root (route 41). The fields are those of AddRoot, and a refusal of the server shows in its own words.
import { useState } from "react";
import type { AddRoot, SourceRoot } from "@shared/learn/sources";
import type { Sensitivity } from "@shared/types";
import { Button } from "../../components/Button";
import { Segmented } from "../../components/Segmented";
import { failureText } from "../../lib/learn/http";
import { KIND_LABELS, KIND_OPTIONS, SENSITIVITY_LABELS, learnSources, parseGlobs } from "../../lib/learn/sources";
import { FIELD } from "./style";

const PATH_HINT: Record<SourceRoot["kind"], string> = {
  notes: "The folder that holds your Markdown or text notes.",
  pdf: "The PDF file itself, not its folder.",
  "claude-memory": "The memory folder of a Claude project.",
  "claude-transcripts": "The folder of Claude Code session transcripts.",
  "claude-instructions": "The folder that holds CLAUDE.md files and rules.",
  "projects-md": "The folder of project documents in Markdown.",
  learnharness: "The data folder of a LearnHarness installation.",
};

export function buildAddRoot(f: { kind: SourceRoot["kind"]; path: string; label: string; sensitivity: Sensitivity; mode: "manual" | "scan"; include: string; exclude: string }): AddRoot {
  const body: AddRoot = { kind: f.kind, path: f.path.trim(), sensitivity: f.sensitivity, mode: f.mode };
  if (f.label.trim()) body.label = f.label.trim();
  const include = parseGlobs(f.include);
  const exclude = parseGlobs(f.exclude);
  if (include.length) body.include = include;
  if (exclude.length) body.exclude = exclude;
  return body;
}

export function AddRootForm({ onAdded, onCancel }: { onAdded: (root: SourceRoot) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<SourceRoot["kind"]>("notes");
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [sensitivity, setSensitivity] = useState<Sensitivity>("internal");
  const [mode, setMode] = useState<"manual" | "scan">("manual");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onAdded(await learnSources.add(buildAddRoot({ kind, path, label, sensitivity, mode, include, exclude })));
    } catch (e) {
      setError(failureText(e, "The source could not be linked."));
      setBusy(false);
    }
  };

  return (
    <form
      className="min-w-0 space-y-3 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-ui font-medium text-ink">Link a source</h3>
      <p className="text-small text-ink-soft">A linked source is read where it is. Nothing is copied, and the files are never changed.</p>
      <label className="block min-w-0">
        <span className="mb-1 block text-small text-ink-soft">Kind</span>
        <select className={FIELD} value={kind} onChange={(e) => setKind(e.target.value as SourceRoot["kind"])}>
          {KIND_OPTIONS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="block min-w-0">
        <span className="mb-1 block text-small text-ink-soft">Path</span>
        <input className={`${FIELD} font-mono`} value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:/Users/you/Notes" autoComplete="off" spellCheck={false} aria-describedby="add-path-hint" />
        <span id="add-path-hint" className="mt-1 block text-caption text-ink-faint">
          {PATH_HINT[kind]}
        </span>
      </label>
      <label className="block min-w-0">
        <span className="mb-1 block text-small text-ink-soft">Label</span>
        <input className={FIELD} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Shown in the tree. The folder name if left empty" />
      </label>
      <label className="block min-w-0">
        <span className="mb-1 block text-small text-ink-soft">Sensitivity</span>
        <select className={FIELD} value={sensitivity} onChange={(e) => setSensitivity(e.target.value as Sensitivity)}>
          {(Object.keys(SENSITIVITY_LABELS) as Sensitivity[]).map((s) => (
            <option key={s} value={s}>
              {SENSITIVITY_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      <div className="min-w-0">
        <p className="mb-1 text-small text-ink-soft">Reading</p>
        <Segmented
          label="Reading"
          value={mode}
          onChange={setMode}
          options={[
            { value: "manual", label: "When I ask" },
            { value: "scan", label: "Scan on a timer" },
          ]}
        />
      </div>
      <label className="block min-w-0">
        <span className="mb-1 block text-small text-ink-soft">Include patterns</span>
        <textarea className={`${FIELD} h-16 py-1.5 font-mono`} value={include} onChange={(e) => setInclude(e.target.value)} placeholder="One pattern per line. Empty means the usual files of this kind" spellCheck={false} />
      </label>
      <label className="block min-w-0">
        <span className="mb-1 block text-small text-ink-soft">Exclude patterns</span>
        <textarea className={`${FIELD} h-16 py-1.5 font-mono`} value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="One pattern per line, for example drafts/**" spellCheck={false} />
      </label>
      {error ? (
        <p role="alert" className="text-body text-block">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || !path.trim()}>
          {busy ? "Linking" : "Link source"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
