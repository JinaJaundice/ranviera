// The legend of the line styles of a recorded run (docs/BRAIN.md, "Records and claims on the line"): a solid segment enters a step that is
// recorded, a dashed segment a step stated by the agent with its cause unverified, and a dotted segment a step that is loaded.
import type { SegmentStyle } from "./brain/path";

export const LEGEND: { style: SegmentStyle; label: string }[] = [
  { style: "solid", label: "recorded" },
  { style: "dashed", label: "stated by the agent, cause unverified" },
  { style: "dotted", label: "loaded" },
];

const WORD: Record<SegmentStyle, string> = { solid: "Solid", dashed: "Dashed", dotted: "Dotted" };
const DASH: Record<SegmentStyle, string | undefined> = { solid: undefined, dashed: "6 4", dotted: "1.5 4" };

export function PathLegend() {
  return (
    <ul aria-label="Line styles" className="min-w-0 space-y-0.5">
      {LEGEND.map((row) => (
        <li key={row.style} data-line={row.style} className="flex min-w-0 items-center gap-2 text-caption text-ink-soft">
          <svg width="28" height="8" viewBox="0 0 28 8" aria-hidden="true" className="shrink-0 text-ink">
            <line x1="1" y1="4" x2="27" y2="4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="butt" strokeDasharray={DASH[row.style]} />
          </svg>
          <span className="min-w-0">
            {WORD[row.style]} line for {row.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
