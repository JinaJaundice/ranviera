import { useEffect, useMemo, useState } from "react";
import Fuse from "fuse.js";
import { Search } from "lucide-react";
import type { Family, GraphNode, Sensitivity } from "@shared/types";
import type { RegionId } from "@shared/brain";
import type { AppProps } from "../registry";
import { setGraphView, useStore } from "../../lib/store";
import { countByFamily } from "../../graph/layout";
import { focusNode } from "../../graph/nav";
import { FAMILIES, FAMILY_WORDS } from "../../graph/palette";
import { FAMILY_DOT } from "../../components/family";
import { Empty } from "../../components/Empty";
import { NodeChip } from "../../components/NodeChip";
import { Section } from "../../components/Section";
import { Segmented } from "../../components/Segmented";
import { Inspector } from "./Inspector";
import { RegionHot, RegionLegend } from "./RegionLegend";
import { Replay } from "./Replay";

const FIELD = "h-8 w-full min-w-0 rounded-md border border-rule-strong bg-sunken px-2 text-body text-ink placeholder:text-ink-faint";

const CAPS: { value: Sensitivity; label: string }[] = [
  { value: "client-confidential", label: "All material" },
  { value: "internal", label: "Internal and public" },
  { value: "public", label: "Public only" },
];

function Search_() {
  const graph = useStore((s) => s.graph);
  const [q, setQ] = useState("");
  const fuse = useMemo(
    () => new Fuse<GraphNode>(graph?.nodes ?? [], { keys: ["label", "id"], threshold: 0.35, ignoreLocation: true }),
    [graph],
  );
  const hits = useMemo(() => (q.trim() ? fuse.search(q.trim(), { limit: 8 }).map((r) => r.item) : []), [fuse, q]);

  return (
    <div className="min-w-0">
      <div className="relative">
        <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2 top-2.5 text-ink-faint" />
        <input
          type="search"
          aria-label="Search the graph by label or id"
          placeholder="Search labels and ids"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) focusNode(hits[0].id);
          }}
          className={`${FIELD} pl-7`}
        />
      </div>
      {q.trim() ? (
        hits.length ? (
          <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
            {hits.map((h) => (
              <NodeChip key={h.id} id={h.id} />
            ))}
          </div>
        ) : (
          <p className="mt-2 text-small text-ink-faint">No node matches that text.</p>
        )
      ) : null}
    </div>
  );
}

function Legend() {
  const graph = useStore((s) => s.graph);
  const view = useStore((s) => s.graphView);
  const counts = useMemo(() => countByFamily(graph?.nodes ?? []), [graph]);
  return (
    <ul className="space-y-1">
      {FAMILIES.map((f: Family) => (
        <li key={f}>
          <label className="flex min-w-0 cursor-pointer items-center gap-2 py-0.5">
            <input
              type="checkbox"
              className="accent-signal"
              checked={view.families[f]}
              onChange={(e) => setGraphView({ families: { ...view.families, [f]: e.target.checked } })}
            />
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${FAMILY_DOT[f]}`} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-body text-ink" title={FAMILY_WORDS[f].hint}>
              {FAMILY_WORDS[f].name}
              <span className="text-ink-faint"> {FAMILY_WORDS[f].hint}</span>
            </span>
            <span className="num text-small text-ink-soft">{counts[f]}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

export function GraphApp({ params }: AppProps) {
  const selected = useStore((s) => s.selected);
  const view = useStore((s) => s.graphView);
  const graph = useStore((s) => s.graph);
  const error = useStore((s) => s.graphError);
  const node = params?.node;
  // A region chosen on a canvas caption arrives as params.region, and the legend can choose one as well.
  const [seen, setSeen] = useState(params?.region);
  const [region, setRegion] = useState<RegionId | null>((params?.region as RegionId | undefined) ?? null);
  if (params?.region !== seen) {
    setSeen(params?.region);
    if (params?.region) setRegion(params.region as RegionId);
  }
  const pick = (id: RegionId) => {
    setRegion(id);
    window.dispatchEvent(new CustomEvent("cortex:focus-region", { detail: { id } }));
  };

  useEffect(() => {
    if (node) focusNode(node);
  }, [node]);

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,300px)_minmax(0,1fr)] bg-surface text-ink">
      <div className="min-h-0 min-w-0 overflow-y-auto border-r border-rule">
        <Section title="Find a node">
          <Search_ />
        </Section>
        {view.layout === "brain" ? (
          <Section title="Regions" note="Each region holds one category of information, and Rules and decisions holds several classes of node. Clear a box to hide a region, or select a name to turn the view to it.">
            {region ? (
              <div className="mb-3 border-b border-rule pb-3">
                <RegionHot region={region} onClose={() => setRegion(null)} />
              </div>
            ) : null}
            <RegionLegend onPick={pick} picked={region} />
          </Section>
        ) : null}
        <Section title="Legend" note="Each colour is a family of nodes. Clear a box to hide that family.">
          <Legend />
        </Section>
        <Section title="View">
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-small text-ink-soft">Layout</p>
              <Segmented
                label="Layout"
                value={view.layout}
                onChange={(layout) => setGraphView({ layout })}
                options={[
                  { value: "brain", label: "Brain" },
                  { value: "network", label: "Network" },
                ]}
              />
            </div>
            <div>
              <p className="mb-1 text-small text-ink-soft">Size by</p>
              <Segmented
                label="Size by"
                value={view.sizeBy}
                onChange={(sizeBy) => setGraphView({ sizeBy })}
                options={[
                  { value: "heat", label: "Use" },
                  { value: "degree", label: "Links" },
                ]}
              />
            </div>
            <label className="block">
              <span className="mb-1 block text-small text-ink-soft">Show</span>
              <select className={FIELD} value={view.cap} onChange={(e) => setGraphView({ cap: e.target.value as Sensitivity })}>
                {CAPS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-body text-ink">
              <input type="checkbox" className="accent-signal" checked={view.ambient} onChange={(e) => setGraphView({ ambient: e.target.checked })} />
              Slow orbit
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-body text-ink">
              <input type="checkbox" className="accent-signal" checked={view.labels} onChange={(e) => setGraphView({ labels: e.target.checked })} />
              Label files, skills and projects
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-body text-ink">
              <input type="checkbox" className="accent-signal" checked={view.showProposed} onChange={(e) => setGraphView({ showProposed: e.target.checked })} />
              Show links not yet reviewed
            </label>
            {view.showProposed ? <p className="text-caption text-ink-faint">Links not yet reviewed are drawn dashed and fainter.</p> : null}
          </div>
        </Section>
        <Section title="Replay" note="Plays past use through the graph, one day in about 4 seconds.">
          <Replay />
        </Section>
      </div>

      <div className="min-h-0 min-w-0 overflow-y-auto">
        {selected ? (
          <Inspector key={selected} id={selected} />
        ) : (
          <Empty>
            {error
              ? `The graph could not load. ${error}`
              : graph
                ? "Select a node in the graph or search for one to see its properties, relations and use."
                : "Loading the graph."}
          </Empty>
        )}
      </div>
    </div>
  );
}
