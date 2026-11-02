// The detail pane of the Sources window: a root with its actions, a folder with its counts, or a file with its state and text.
import { useState } from "react";
import { AlertTriangle, Eye, EyeOff, Play, RefreshCw, Unlink } from "lucide-react";
import type { RootSummary } from "@shared/learn/sources";
import { Button } from "../../components/Button";
import { Segmented } from "../../components/Segmented";
import { StatusDot } from "../../components/StatusDot";
import { failureText } from "../../lib/learn/http";
import { KIND_LABELS, OUTCOME_WORDS, REASON_WORDS, STATE_WORDS, consentExplanation, dateWord, learnSources, statsLine } from "../../lib/learn/sources";
import { PassageView } from "./PassageView";
import { SensitivityChip } from "./SensitivityChip";
import { Switch } from "./parts";
import type { TreeNode } from "./tree";
import { STATE_TONE, bytesWords, confirmNeeded, confirmWords, countsWords, fileCountWords } from "./words";

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-body">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-faint">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface RootActions {
  scan: () => Promise<void>;
  extract: (paths?: string[], confirm?: boolean) => Promise<void>;
  changed: () => void;
  unlink: () => void;
  notice: (tone: "info" | "error", text: string) => void;
}

export function RootDetail({ node, selectedPaths, actions }: { node: TreeNode; selectedPaths: string[]; actions: RootActions }) {
  const root = node.root as RootSummary;
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ files: number; tokens: number } | null>(null);
  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      actions.notice("error", failureText(e, "The action could not be completed."));
    } finally {
      setBusy(null);
    }
  };
  // A bulk request over one scan pass of files is refused with confirm_required. The window asks inline, then sends confirm true.
  const startExtract = (confirmed: boolean) =>
    run("extract", async () => {
      setConfirm(null);
      try {
        await actions.extract(selectedPaths.length ? selectedPaths : undefined, confirmed || undefined);
      } catch (e) {
        const needed = confirmNeeded(e);
        if (!needed) throw e;
        setConfirm(needed);
      }
    });
  const patch = (name: string, body: Parameters<typeof learnSources.change>[1]) =>
    run(name, async () => {
      await learnSources.change(root.id, body);
      actions.changed();
    });
  const consentOn = !!root.hostedConsentAt;
  const confidential = root.sensitivity === "client-confidential";
  const pending = node.counts.pending;
  return (
    <div className="min-w-0 space-y-4 px-4 py-3">
      <div className="min-w-0">
        <h2 className="break-words font-display text-title text-ink">{root.label}</h2>
        <p className="addr mt-1 text-ink-soft">{root.path}</p>
      </div>
      <Facts
        rows={[
          ["Kind", KIND_LABELS[root.kind]],
          ["Sensitivity", <SensitivityChip key="s" value={root.sensitivity} />],
          ["Files", `${fileCountWords(node.counts.files)}. ${countsWords(node.counts)}.`],
          ["Last scan", root.lastScanAt ? dateWord(root.lastScanAt) : "Not scanned yet"],
          ["Linked", dateWord(root.createdAt)],
        ]}
      />
      <div className="flex flex-wrap gap-2">
        <Button icon={<RefreshCw size={14} aria-hidden="true" />} disabled={!!busy || !root.enabled} onClick={() => void run("scan", actions.scan)}>
          {busy === "scan" ? "Scanning" : "Scan"}
        </Button>
        <Button
          variant="primary"
          icon={<Play size={14} aria-hidden="true" />}
          disabled={!!busy || !root.enabled || (selectedPaths.length === 0 && pending === 0)}
          onClick={() => void startExtract(false)}
        >
          {busy === "extract" ? "Queuing" : selectedPaths.length ? `Extract ${fileCountWords(selectedPaths.length)}` : "Extract unread files"}
        </Button>
        <Button variant="secondary" className="border-block text-block" icon={<Unlink size={14} aria-hidden="true" />} disabled={!!busy} onClick={actions.unlink}>
          Unlink
        </Button>
      </div>
      {confirm ? (
        <div role="alert" className="min-w-0 space-y-2 rounded-md border border-hold bg-hold-soft px-3 py-2">
          <p className="flex min-w-0 items-start gap-2 text-body text-ink">
            <AlertTriangle size={14} className="mt-1 shrink-0 text-hold" aria-hidden="true" />
            <span className="min-w-0 break-words">{confirmWords(confirm)}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={!!busy} onClick={() => void startExtract(true)}>
              Confirm and extract
            </Button>
            <Button variant="secondary" disabled={!!busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <section aria-label="Reading and permission" className="min-w-0 space-y-3 border-t border-rule pt-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-body font-medium text-ink">Reading</p>
            <p className="text-small text-ink-soft">{root.enabled ? "This root is read when you scan it." : "This root is off. It keeps its knowledge but is not scanned or extracted."}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-small text-ink-soft">{root.enabled ? "On" : "Off"}</span>
            <Switch checked={root.enabled} label={`Read ${root.label}`} disabled={!!busy} onChange={(v) => void patch("enabled", { enabled: v })} />
          </div>
        </div>
        <div className="min-w-0">
          <p className="mb-1 text-small text-ink-soft">When it is read</p>
          <Segmented
            label="When it is read"
            value={root.mode}
            onChange={(mode) => void patch("mode", { mode })}
            options={[
              { value: "manual", label: "When I ask" },
              { value: "scan", label: "Scan on a timer" },
            ]}
          />
        </div>
        <div className="min-w-0">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-body font-medium text-ink">Hosted providers</p>
              <p className="text-small text-ink-soft">{!confidential ? "Allowed, because this root is not client confidential." : consentOn ? `Allowed since ${dateWord(root.hostedConsentAt)}.` : "Not allowed."}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-small text-ink-soft">{!confidential || consentOn ? "Allowed" : "Not allowed"}</span>
              <Switch checked={!confidential || consentOn} label={`Allow hosted providers to read ${root.label}`} disabled={!!busy || !confidential} onChange={(v) => void patch("consent", { hostedConsent: v })} />
            </div>
          </div>
          <p className="mt-1 text-small text-ink-soft">{consentExplanation(root)}</p>
        </div>
      </section>
    </div>
  );
}

export function FolderDetail({ node }: { node: TreeNode }) {
  return (
    <div className="min-w-0 space-y-3 px-4 py-3">
      <h2 className="break-words font-display text-title text-ink">{node.label}</h2>
      <Facts rows={[["Files", `${fileCountWords(node.counts.files)}. ${countsWords(node.counts)}.`]]} />
    </div>
  );
}

export function FileDetail({ node, onExtract }: { node: TreeNode; onExtract: () => Promise<void> }) {
  const f = node.file!;
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const readable = f.state === "pending" || f.state === "current";
  return (
    <div className="min-w-0">
      <div className="min-w-0 space-y-3 px-4 py-3">
        <h2 className="break-words font-display text-title text-ink">{node.label}</h2>
        <p className="addr text-ink-soft">{f.path}</p>
        <Facts
          rows={[
            [
              "State",
              <span key="st" className="inline-flex items-center gap-1.5">
                <StatusDot tone={STATE_TONE[f.state]} />
                {STATE_WORDS[f.state]}
              </span>,
            ],
            ["Result", f.outcome ? OUTCOME_WORDS[f.outcome] : "Not read yet"],
            ["Read", f.stats ? statsLine(f.stats) : "Nothing read yet"],
            ["Last read", f.lastExtractedAt ? dateWord(f.lastExtractedAt) : "Not read yet"],
            ["Size", <span key="b" className="num">{bytesWords(f.bytes)}</span>],
            ...(f.pages ? ([["Pages", <span key="p" className="num">{f.pages}</span>]] as [string, React.ReactNode][]) : []),
          ]}
        />
        {f.reason ? (
          <p role="status" className="rounded-md border border-block bg-block-soft px-3 py-2 text-small text-ink">
            {REASON_WORDS[f.reason]}
          </p>
        ) : null}
        {f.notice ? (
          <p role="status" className="rounded-md border border-hold bg-hold-soft px-3 py-2 text-small text-ink">
            {f.notice}
          </p>
        ) : null}
        {f.state === "missing" ? <p className="text-small text-ink-soft">The file is no longer on disk. Its knowledge stays in the graph.</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon={<Play size={14} aria-hidden="true" />}
            disabled={!readable || busy}
            onClick={() => {
              setBusy(true);
              void onExtract().finally(() => setBusy(false));
            }}
          >
            {busy ? "Queuing" : f.outcome ? "Extract again" : "Extract"}
          </Button>
          <Button icon={show ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />} disabled={!readable} onClick={() => setShow((v) => !v)}>
            {show ? "Hide the text" : "Show the text"}
          </Button>
        </div>
      </div>
      {show && readable ? (
        <div className="border-t border-rule">
          <PassageView key={f.sourceId} source={f.sourceId} />
        </div>
      ) : null}
    </div>
  );
}
