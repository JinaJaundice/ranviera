// The controls of the traced path in the thought trail panel (docs/BRAIN.md, "The thought trail panel and the line"): play and pause,
// the scrubber with a track coloured by the runs of the route, Show the whole path, Watch close up and the previous path.
import { Pause, Play, Route } from "lucide-react";
import { Button } from "../components/Button";
import { REGION_BG } from "./brain/trail";
import { currentStep, neighbourStep, stepCaption, type RouteRun } from "./brain/path";

export interface PathControlsProps {
  count: number;
  /** the runs that colour the track, each step in one run */
  track: RouteRun[];
  /** the progress value: the step number plus the fraction of the step */
  position: number;
  playing: boolean;
  /** the person has moved the head or chosen a step, so that live steps wait */
  held: number | null;
  follow: boolean;
  previous: boolean;
  canPrevious: boolean;
  onToggle: () => void;
  onSeek: (progress: number) => void;
  onWhole: () => void;
  onFollow: (on: boolean) => void;
  onPrevious: (on: boolean) => void;
  onLive: () => void;
}

export function PathControls(p: PathControlsProps) {
  if (p.count < 1) return null;
  const value = Math.min(p.count + 1, Math.max(1, p.position));
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          icon={p.playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          aria-label={p.playing ? "Pause the path" : "Play the path"}
          onClick={p.onToggle}
        >
          {p.playing ? "Pause" : "Play"}
        </Button>
        <Button icon={<Route size={14} aria-hidden="true" />} onClick={p.onWhole}>
          Show the whole path
        </Button>
      </div>
      <div className="min-w-0">
        <div aria-hidden="true" className="mb-1 flex h-1.5 min-w-0 overflow-hidden rounded-sm bg-sunken">
          {p.track.map((run, i) => (
            <span key={`${run.region}-${i}`} style={{ flex: `${run.steps.length} 1 0` }} className={`min-w-0 ${REGION_BG[run.region]}`} />
          ))}
        </div>
        <input
          type="range"
          aria-label="Position in the path"
          aria-valuetext={stepCaption(p.position, p.count)}
          min={1}
          max={p.count + 1}
          step={0.01}
          value={value}
          onChange={(e) => p.onSeek(Number(e.target.value))}
          onKeyDown={(e) => {
            // the arrow keys move to the previous or the next whole step, and Home, End, PageUp and PageDown keep the browser's moves
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            p.onSeek(neighbourStep(value, p.count, e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : -1));
          }}
          className="block h-4 w-full min-w-0 accent-signal"
        />
        <p className="num mt-0.5 text-caption text-ink-faint">{stepCaption(p.position, p.count)}</p>
      </div>
      {p.held !== null ? (
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-small text-ink-soft">
          <span>Paused at step {Math.max(1, currentStep(p.position, p.count))}.</span>
          <button type="button" className="text-signal underline" onClick={p.onLive}>
            Return to Live
          </button>
        </p>
      ) : null}
      <label className="flex min-w-0 cursor-pointer items-center gap-2 text-body text-ink">
        <input type="checkbox" className="accent-signal" checked={p.follow} onChange={(e) => p.onFollow(e.target.checked)} />
        Watch close up
      </label>
      <label className={`flex min-w-0 items-center gap-2 text-body ${p.canPrevious ? "cursor-pointer text-ink" : "text-ink-faint"}`}>
        <input type="checkbox" className="accent-signal" checked={p.previous} disabled={!p.canPrevious} onChange={(e) => p.onPrevious(e.target.checked)} />
        Show the previous path
      </label>
    </div>
  );
}
