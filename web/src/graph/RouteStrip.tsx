// The route strip of the thought trail (docs/BRAIN.md, "Regions, colours and the route strip"): the regions in the order in which the
// path visited them, with the steps in each. Each run is a chip in the colour of its region, and a click selects its first step. The strip
// has an area of its own above the list of steps, wraps to show every chip and never scrolls with the steps.
import { TriangleAlert } from "lucide-react";
import { REGIONS, type RegionId } from "@shared/brain";
import { stepsLabel, type RouteRun } from "./brain/path";
import { REGION_BG } from "./brain/trail";

const NAME = Object.fromEntries(REGIONS.map((r) => [r.id, r.label])) as Record<RegionId, string>;

export function RouteStrip({ runs, findings, onPick }: { runs: RouteRun[]; findings: number; onPick: (step: number) => void }) {
  if (!runs.length) return null;
  return (
    <div className="min-w-0">
      <p className="mb-1 text-small text-ink-soft">
        Route through the regions
        {findings ? (
          <span className="ml-2 inline-flex items-center gap-1 text-block">
            <TriangleAlert size={12} aria-hidden="true" />
            {findings} {findings === 1 ? "finding" : "findings"}
          </span>
        ) : null}
      </p>
      <ol aria-label="Route through the regions" className="flex min-w-0 flex-wrap gap-1">
        {runs.map((run, i) => (
          <li key={`${run.region}-${i}`} className="min-w-0">
            <button
              type="button"
              data-run={i}
              onClick={() => onPick(run.steps[0])}
              title={`${NAME[run.region]}, ${run.steps.length === 1 ? "step" : "steps"} ${stepsLabel(run.steps)}`}
              className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-rule bg-raised px-1 py-px text-caption text-ink hover:border-rule-strong"
            >
              <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${REGION_BG[run.region]}`} />
              <span className="min-w-0 truncate">{NAME[run.region]}</span>
              <span className="num shrink-0 text-ink-soft">{stepsLabel(run.steps)}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
