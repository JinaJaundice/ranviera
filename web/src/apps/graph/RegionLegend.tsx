// The legend of the 10 brain regions and the list of the hottest nodes of one region (docs/BRAIN.md, "Interaction").
import { useMemo } from "react";
import { REGIONS, type RegionId } from "@shared/brain";
import { NodeChip } from "../../components/NodeChip";
import { setGraphView, useStore } from "../../lib/store";
import { REGION_BG } from "../../graph/brain/trail";
import { REGION_CONTENTS, countByRegion, hottest } from "./regions";

export function RegionLegend({ onPick, picked }: { onPick: (id: RegionId) => void; picked: RegionId | null }) {
  const graph = useStore((s) => s.graph);
  const hidden = useStore((s) => s.graphView.hiddenRegions);
  const counts = useMemo(() => countByRegion(graph?.nodes ?? []), [graph]);
  return (
    <ul className="space-y-1.5">
      {REGIONS.map((r) => {
        const shown = !hidden.includes(r.id);
        return (
          <li key={r.id} className={`min-w-0 rounded-md px-1 py-0.5 ${picked === r.id ? "bg-raised" : ""}`}>
            <div className="flex min-w-0 items-center gap-2">
              <input
                type="checkbox"
                className="accent-signal"
                aria-label={`Show ${r.label}`}
                checked={shown}
                onChange={(e) => setGraphView({ hiddenRegions: e.target.checked ? hidden.filter((h) => h !== r.id) : [...hidden, r.id] })}
              />
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${REGION_BG[r.id]}`} aria-hidden="true" />
              <button type="button" className="min-w-0 flex-1 truncate text-left text-body text-ink hover:underline" onClick={() => onPick(r.id)}>
                {r.label}
              </button>
              <span className="num text-small text-ink-soft">{counts[r.id]}</span>
            </div>
            <p className="pl-7 text-caption text-ink-faint">{REGION_CONTENTS[r.id]}.</p>
            <p className="pl-7 text-caption text-ink-faint">Brain region: {r.name}. {r.func}.</p>
          </li>
        );
      })}
    </ul>
  );
}

export function RegionHot({ region, onClose }: { region: RegionId; onClose: () => void }) {
  const graph = useStore((s) => s.graph);
  const def = REGIONS.find((r) => r.id === region);
  const top = useMemo(() => hottest(graph?.nodes ?? [], region), [graph, region]);
  return (
    <div className="min-w-0">
      <div className="mb-1 flex min-w-0 items-center gap-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${REGION_BG[region]}`} aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-body font-medium text-ink">{def?.label}</p>
        <button type="button" className="text-small text-ink-soft hover:text-ink" onClick={onClose}>
          Clear
        </button>
      </div>
      <p className="mb-1 text-caption text-ink-faint">The {top.length} hottest nodes of this region, by heat, which weights recent use. The dot on each name shows the type of the node, not the region.</p>
      {top.length ? (
        <ol className="space-y-1">
          {top.map((n, i) => (
            <li key={n.id} className="flex min-w-0 items-center gap-2">
              <span className="num w-5 shrink-0 text-right text-small text-ink-soft">{i + 1}</span>
              <NodeChip id={n.id} className="min-w-0 flex-1" />
              <span className="num shrink-0 text-caption text-ink-faint">
                heat {(n.metrics.heat ?? 0).toFixed(2)}, {n.metrics.uses} {n.metrics.uses === 1 ? "use" : "uses"}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-small text-ink-faint">This region holds no nodes.</p>
      )}
    </div>
  );
}
