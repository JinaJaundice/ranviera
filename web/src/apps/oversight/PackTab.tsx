import { useState } from "react";
import { FileDown } from "lucide-react";
import type { PackResult } from "@shared/types";
import { Button } from "../../components/Button";
import { api } from "../../lib/api";
import { toast } from "../../shell/toastStore";
import { useLoad } from "./load";
import { agentName, longDate, plural, scopeOf, type ScopeKind } from "./model";
import { PACK_CONTENTS, packPreviewText, packRuns, previewSplit, sizeText } from "./packWords";
import { ErrorLine, INPUT } from "./parts";

const KINDS: { value: ScopeKind; label: string; choose: string }[] = [
  { value: "run", label: "Run", choose: "Choose a run" },
  { value: "alert", label: "Alert", choose: "Choose an alert" },
  { value: "agent", label: "Agent", choose: "Choose an agent" },
  { value: "period", label: "Period", choose: "" },
];

const FILE_WORD: Record<string, string> = { "pack.html": "Readable pack", "pack.json": "Data file for audit tools", "manifest.json": "List of files with fingerprints" };

/** A temporary address for a file of the written pack, which the server reads from its packs folder. */
async function fileUrl(folder: string, file: "pack.html" | "pack.json"): Promise<string> {
  const r = await api.packFile(folder, file);
  const url = URL.createObjectURL(new Blob([r.text], { type: file === "pack.html" ? "text/html" : "application/json" }));
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return url;
}

export function PackTab({ preset }: { preset: { kind: ScopeKind; value: string } | null }) {
  const [kind, setKind] = useState<ScopeKind>(preset?.kind ?? "run");
  const [value, setValue] = useState(preset?.value ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pack, setPack] = useState<PackResult | null>(null);
  const runs = useLoad(() => api.oversightRuns(), "pack-runs");
  const scope = scopeOf(kind, value, from, to);
  const choose = KINDS.find((k) => k.value === kind)?.choose ?? "";
  const list = runs.data ?? [];
  const options: { value: string; label: string }[] =
    kind === "run"
      ? list.map((r) => ({ value: r.run, label: `${r.case_ref ?? "No case reference"}, ${longDate(r.ts)}` }))
      : kind === "alert"
        ? list.flatMap((r) => (r.case_ref ? [{ value: r.case_ref, label: `${r.case_ref}, ${longDate(r.ts)}` }] : []))
        : kind === "agent"
          ? [...new Set(list.map((r) => r.agent))].map((a) => ({ value: a, label: agentName(a) }))
          : [];
  const covered = packRuns(list, kind, value, from, to);
  const split = previewSplit(covered);
  const runLine = (r: (typeof list)[number]) =>
    `${r.case_ref ?? "No case reference"}, ${longDate(r.ts)}, ${plural(r.findings, "finding")}${r.override ? ", overridden by the reviewer" : r.reviewed ? ", reviewed" : ", not reviewed"}`;
  const folder = pack ? (pack.path.split(/[\\/]/).pop() ?? "") : "";
  const why = scope
    ? null
    : kind === "period"
      ? from && to && from > to
        ? "The start of the period must not be after its end."
        : "Enter the first and the last day of the period to export."
      : `${choose} to export.`;

  const exportPack = async () => {
    if (!scope) return;
    setBusy(true);
    setRefusal(null);
    try {
      setPack(await api.exportPack(scope));
      toast("The evidence pack was exported.");
    } catch (e) {
      setPack(null);
      setRefusal(e instanceof Error ? e.message : "The server could not complete the request.");
    } finally {
      setBusy(false);
    }
  };
  const open = async () => {
    try {
      window.open(await fileUrl(folder, "pack.html"), "_blank", "noopener");
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : "The server could not complete the request.");
    }
  };
  const save = async () => {
    try {
      const a = document.createElement("a");
      a.href = await fileUrl(folder, "pack.json");
      a.download = `${folder}.json`;
      a.click();
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : "The server could not complete the request.");
    }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4">
      <p className="mb-3 max-w-prose text-body text-ink-soft">
        An evidence pack is a dated folder for one run, alert, agent or period. It holds the decision traces, the instruction versions with their approvals, the mapping chain, the findings with proofs, the monitoring results and a list of files with their fingerprints.
      </p>
      <form
        className="flex min-w-0 flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void exportPack();
        }}
      >
        <label className="text-small text-ink-soft">
          Scope
          <select className={`${INPUT} mt-0.5 block`} value={kind} onChange={(e) => { setKind(e.target.value as ScopeKind); setValue(""); setPack(null); }}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </label>
        {kind === "period" ? (
          <>
            <label className="text-small text-ink-soft">
              From
              <input type="date" className={`${INPUT} mt-0.5 block`} value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="text-small text-ink-soft">
              To
              <input type="date" className={`${INPUT} mt-0.5 block`} value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        ) : (
          <label className="min-w-0 flex-1 text-small text-ink-soft">
            {KINDS.find((k) => k.value === kind)?.label}
            <select className={`${INPUT} mt-0.5 block w-full`} value={value} onChange={(e) => { setValue(e.target.value); setPack(null); }}>
              <option value="">{choose}</option>
              {value && !options.some((o) => o.value === value) ? <option value={value}>{value}</option> : null}
              {options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
        <Button type="submit" variant="primary" icon={<FileDown size={14} aria-hidden="true" />} disabled={busy || !scope}>Export the evidence pack</Button>
      </form>
      {why ? <p className="mt-2 text-small text-hold">{why}</p> : null}
      <section aria-label="Preview of the pack" className="mt-4 min-w-0 max-w-prose rounded-md border border-rule p-3">
        <h3 className="text-ui font-medium text-ink">What the pack would hold</h3>
        <p className="mt-1 text-body text-ink">{scope ? packPreviewText(covered) : "Choose a scope to see which runs the pack would cover."}</p>
        {scope && kind === "period" && covered.length ? (
          <p className="mt-1 text-small text-ink-soft">The period covers {covered.length} of the {list.length} runs recorded. The monitoring figures on the Monitoring tab cover all {list.length}.</p>
        ) : null}
        {scope && covered.length ? (
          <>
            {split.notable.length ? (
              <>
                <p className="mt-2 text-small text-ink-soft">Runs with a finding or an override</p>
                <ul className="mt-1 space-y-0.5 text-small text-ink">
                  {split.notable.map((r) => (
                    <li key={r.run}>{runLine(r)}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {split.others.length ? (
              <details className="mt-2 text-small text-ink-soft">
                <summary className="cursor-pointer">{split.notable.length ? `The other ${plural(split.others.length, "run")}` : `The ${plural(split.others.length, "run")}`}</summary>
                <ul className="mt-1 space-y-0.5">
                  {split.others.map((r) => (
                    <li key={r.run}>{runLine(r)}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : null}
        <h4 className="mt-3 text-body font-medium text-ink">Files that the export writes</h4>
        <ul className="mt-1 space-y-1">
          {PACK_CONTENTS.map((c) => (
            <li key={c.file} className="text-small text-ink-soft"><span className="text-ink">{c.file}.</span> {c.text}</li>
          ))}
        </ul>
      </section>
      {refusal ? <div className="mt-3"><ErrorLine>{refusal}</ErrorLine></div> : null}
      {pack ? (
        <section aria-label="Exported pack" className="mt-4 min-w-0 rounded-md border border-rule-strong p-3">
          <h3 className="text-ui font-medium text-ink">Pack written on {longDate(pack.manifest.created)}</h3>
          <p className="mt-1 text-body text-ink-soft">
            The pack holds {pack.manifest.files.length === 1 ? "1 file" : `${pack.manifest.files.length} files`}. Open the readable pack to read it, or save the data file for an audit tool.
          </p>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => void open()}>Open the readable pack</Button>
            <Button onClick={() => void save()}>Save the data file</Button>
          </div>
          <table className="mt-3 w-full min-w-0 table-fixed border-collapse text-small">
            <thead>
              <tr className="border-b border-rule text-left text-ink-faint">
                <th scope="col" className="w-1/2 px-2 py-1.5 font-medium">File</th>
                <th scope="col" className="px-2 py-1.5 font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {pack.manifest.files.map((f) => (
                <tr key={f.path} className="border-b border-rule">
                  <td className="px-2 py-1.5 text-ink" title={`${f.path}, fingerprint ${f.sha256}`}>{FILE_WORD[f.path] ?? f.path}</td>
                  <td className="num px-2 py-1.5">{sizeText(f.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <details className="mt-2 text-small text-ink-soft">
            <summary className="cursor-pointer">Where the pack is kept, and its fingerprints</summary>
            <p className="mt-1">Saved on the server in the folder</p>
            <p className="addr select-all break-all">{pack.path}</p>
            <ul className="mt-1 space-y-0.5">
              {pack.manifest.files.map((f) => (
                <li key={f.path} className="min-w-0 break-all">{f.path} <span className="addr">{f.sha256}</span></li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}
    </div>
  );
}
