import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { HealthFinding } from "@shared/types";
import type { AppProps } from "../registry";
import { Button } from "../../components/Button";
import { Empty } from "../../components/Empty";
import { NodeChip } from "../../components/NodeChip";
import { Section } from "../../components/Section";
import { Segmented } from "../../components/Segmented";
import { api } from "../../lib/api";
import { loadGraph, setState, useStore } from "../../lib/store";
import { toast } from "../../shell/toastStore";
import { openPath } from "../missions/openPath";
import { checkHeading } from "./checks";

type Tab = "violation" | "warning" | "info";

const TABS: { value: Tab; label: string }[] = [
  { value: "violation", label: "Violations" },
  { value: "warning", label: "Warnings" },
  { value: "info", label: "Notes" },
];

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} at ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** Evidence is often a path. Only a string that looks like one gets an Open button. */
function looksLikePath(s: string): boolean {
  return /^(~|[A-Za-z]:[\\/]|\/)|[\\/][^\s]+\.[A-Za-z0-9]+(:\d+)?$/.test(s.trim());
}

function Row({ f }: { f: HealthFinding }) {
  const ev = f.evidence;
  const path = ev && looksLikePath(ev) ? ev.trim().replace(/:\d+$/, "") : null;
  return (
    <li className="flex min-w-0 items-start gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-body text-ink">{f.message}</p>
        {f.node ? (
          <div className="mt-1">
            <NodeChip id={f.node} />
          </div>
        ) : null}
        {ev ? (
          <p className="mt-1 break-all font-mono text-small text-ink-soft" title={ev}>
            {ev}
          </p>
        ) : null}
      </div>
      {path ? <Button onClick={() => openPath(path)}>Open</Button> : null}
    </li>
  );
}

function Drift() {
  const drift = useStore((s) => s.health?.drift ?? null);
  const health = useStore((s) => s.health);
  if (!health) return null;
  if (!drift) {
    return (
      <Section title="Drift">
        <p className="text-body text-ink-soft">The drift check has not run.</p>
      </Section>
    );
  }
  const groups: { title: string; files: string[] }[] = [
    { title: "Changed since the mirror was written", files: drift.changed },
    { title: "In the home folder but not in the mirror", files: drift.missing_in_mirror },
    { title: "In the mirror but not in the home folder", files: drift.missing_in_home },
  ];
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  return (
    <Section title="Drift" note={`Files that differ between ~/.claude and the harness mirror, checked ${when(drift.checked)}.`}>
      {total === 0 ? (
        <p className="text-body text-ink-soft">No files differ.</p>
      ) : (
        groups
          .filter((g) => g.files.length > 0)
          .map((g) => (
            <div key={g.title} className="mb-2">
              <p className="num text-small font-medium text-ink-soft">
                {g.title} ({g.files.length})
              </p>
              <ul className="mt-1 space-y-0.5">
                {g.files.map((f) => (
                  <li key={f} className="break-all font-mono text-small text-ink">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ))
      )}
    </Section>
  );
}

export function HealthApp(props: AppProps) {
  void props;
  const health = useStore((s) => s.health);
  const [tab, setTab] = useState<Tab>("violation");
  const [secs, setSecs] = useState<number | null>(null);

  useEffect(() => {
    if (secs === null) return;
    const t = setInterval(() => setSecs((s) => (s === null ? s : s + 1)), 1000);
    return () => clearInterval(t);
  }, [secs === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const by = new Map<string, HealthFinding[]>();
    for (const f of health?.findings ?? []) {
      if (f.severity !== tab) continue;
      by.set(f.check, [...(by.get(f.check) ?? []), f]);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [health, tab]);

  const rebuild = async () => {
    setSecs(0);
    try {
      await api.compile();
      const h = await api.health();
      setState({ health: h });
      void loadGraph();
      toast("The graph was rebuilt and checked.");
    } catch (e) {
      toast(`The rebuild failed. ${e instanceof Error ? e.message : ""}`.trim(), "error");
    } finally {
      setSecs(null);
    }
  };

  const c = health?.counts;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex min-w-0 flex-wrap items-center gap-3 border-b border-rule px-4 py-3">
        <p className="num min-w-0 flex-1 text-body text-ink">
          {health && c
            ? `${c.violation} violations, ${c.warning} warnings and ${c.info} notes, checked ${when(health.checked)}.`
            : "The health check has not been loaded."}
        </p>
        <Button icon={<RefreshCw size={14} aria-hidden="true" />} disabled={secs !== null} onClick={rebuild}>
          {secs !== null ? `Rebuilding, ${secs} s` : "Rebuild and check"}
        </Button>
      </div>
      {health?.stale ? (
        <p role="status" className="border-b border-rule px-4 py-2 text-body text-hold">
          This report describes an older build of the graph than the one now shown. Choose Rebuild and check to bring it up to date.
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-rule px-4 py-3">
          <Segmented label="Severity" options={TABS} value={tab} onChange={setTab} />
        </div>
        {groups.length === 0 ? (
          <Empty>{health ? `There are no ${TABS.find((t) => t.value === tab)?.label.toLowerCase()}.` : "Nothing to show yet."}</Empty>
        ) : (
          groups.map(([id, items]) => (
            <Section key={id} title={checkHeading(id)} action={<span className="num font-mono text-small text-ink-faint">{id}</span>}>
              <ul className="divide-y divide-rule">
                {items.map((f, i) => (
                  <Row key={`${f.node ?? ""}-${i}`} f={f} />
                ))}
              </ul>
            </Section>
          ))
        )}
        <Drift />
      </div>
    </div>
  );
}
