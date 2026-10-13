// The thought trail panel (docs/BRAIN.md, "The thought trail" and "The traced path"): the numbered steps of the current prompt at the
// left edge of the canvas, with Live, Replay last prompt and Try a prompt. The panel and the line drawn on the brain are one control:
// choosing a step, moving the scrubber, playing, pausing and showing the whole path all move the line through window events, and
// the scene reports the head back. It opens on the first step of a prompt and closes only when the person closes it. Each step is
// played on the canvas through the window event cortex:play-step.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ListOrdered, Play, RotateCcw, TriangleAlert, X } from "lucide-react";
import { REGIONS, type RegionId } from "@shared/brain";
import { api } from "../lib/api";
import { bus } from "../lib/bus";
import { setGraphView, useStore } from "../lib/store";
import { Button } from "../components/Button";
import { IconButton } from "../components/IconButton";
import { Segmented } from "../components/Segmented";
import { PATH_GROUP_AFTER } from "./brain/look";
import { absentSummary, currentStep, hopLine, isMissing, pathAtEnd, progressOf, routeGroups, routeRuns, stepRegions, stepsLabel, type RouteRun } from "./brain/path";
import { REGION_BG, EMPTY_TRAIL, TrailQueue, addEvent, regionOfNode, replaySteps, stepsFromPlan, type TrailState } from "./brain/trail";
import type { PathMarker, TracePath, TrailStep } from "./brain/types";
import { PathControls } from "./PathControls";
import { PathLegend } from "./PathLegend";
import { RouteStrip } from "./RouteStrip";

type Mode = "live" | "replay" | "predicted" | "run";
type Speed = "0.5" | "1" | "2";
type Phase = "idle" | "playing" | "paused";

const REGION_NAME = Object.fromEntries(REGIONS.map((r) => [r.id, r.label])) as Record<RegionId, string>;
const FIELD = "h-8 w-full min-w-0 rounded-md border border-rule-strong bg-sunken px-2 text-body text-ink placeholder:text-ink-faint";
const SEVERITY_TEXT: Record<PathMarker["severity"], string> = { violation: "text-block", warning: "text-hold", info: "text-ink-soft" };

const HOP_TEXT: Record<NonNullable<TrailStep["hops"]>[number]["status"], string> = { ratified: "text-ink-soft", stated: "text-ink-soft", proposed: "text-hold", missing: "text-block" };

const keyOf = (s: TrailStep) => `${s.mode}-${s.n}`;

function clock(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-GB");
}

function dispatch<T>(name: string, detail: T): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

interface RowProps {
  step: TrailStep;
  active: boolean;
  selected: boolean;
  regions: RegionId[];
  lost: number;
  onChoose: (n: number) => void;
}

function Row({ step, active, selected, regions, lost, onChoose }: RowProps) {
  const predicted = step.mode === "predicted";
  const dot = regions[0] ? REGION_BG[regions[0]] : "bg-ink-faint";
  const nodes = step.activation.filter((a) => !isMissing(a.id)).length;
  return (
    <li style={{ contentVisibility: "auto", containIntrinsicSize: "auto 3.5rem" }}>
      <button
        type="button"
        data-step={keyOf(step)}
        aria-current={active ? "step" : undefined}
        aria-pressed={selected}
        onClick={() => onChoose(step.n)}
        className={`grid w-full min-w-0 grid-cols-[1.5rem_0.75rem_minmax(0,1fr)_auto] items-start gap-2 rounded-md border-l-2 px-2 py-1.5 text-left hover:bg-raised ${
          selected ? "border-signal bg-raised" : active ? "border-rule-strong bg-raised" : "border-transparent"
        }`}
      >
        <span className="num text-small text-ink-soft">{step.n}</span>
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2.5 w-2.5 rounded-full ${dot} ${predicted ? "opacity-60 outline outline-1 outline-offset-1 outline-dashed outline-ink-soft" : ""}`}
        />
        <span className="min-w-0">
          <span className="block break-words text-body text-ink">{step.sentence}</span>
          <span className="block truncate text-caption text-ink-faint">
            {regions.length ? regions.map((r) => REGION_NAME[r]).join(", then ") : "No region"}
            {nodes ? ` · ${nodes} ${nodes === 1 ? "node" : "nodes"}` : ""}
          </span>
          {step.label ? <span className="block text-caption text-ink-faint">{step.label}</span> : null}
          {(step.hops ?? []).map((h) => (
            <span key={h.letter} data-hop={`${step.n}${h.letter}`} className={`block break-words text-caption ${HOP_TEXT[h.status]}`}>
              {hopLine(step.n, h)}
            </span>
          ))}
          {lost ? <span className="block text-caption text-hold">{lost >= nodes ? "Not in this graph" : `${lost} of ${nodes} nodes are not in this graph`}</span> : null}
          {(step.markers ?? []).map((m, i) => (
            <span key={`${m.title}-${i}`} className={`flex min-w-0 items-center gap-1 text-caption ${SEVERITY_TEXT[m.severity]}`}>
              <TriangleAlert size={12} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0">{m.title}</span>
            </span>
          ))}
        </span>
        <span className="num pt-0.5 text-caption text-ink-faint">{predicted ? "Predicted" : clock(step.ts)}</span>
      </button>
    </li>
  );
}

export function ThoughtTrail() {
  const byId = useStore((s) => s.byId);
  const follow = useStore((s) => s.graphView.pathFollow);
  const previousOn = useStore((s) => s.graphView.pathPrevious);
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState<TrailState>(EMPTY_TRAIL);
  const [shown, setShown] = useState<TracePath | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("live");
  const [speed, setSpeed] = useState<Speed>("1");
  const [phase, setPhase] = useState<Phase>("idle");
  const [held, setHeld] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [catching, setCatching] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [openGroups, setOpenGroups] = useState<ReadonlySet<number>>(new Set());
  const state = useRef<TrailState>(EMPTY_TRAIL);
  const queue = useRef<TrailQueue | null>(null);
  const list = useRef<HTMLDivElement>(null);
  // The handlers read the latest values through these refs.
  const byIdRef = useRef(byId);
  const mode0 = useRef<Mode>(mode);
  const shownRef = useRef<TracePath | null>(null);
  const speedRef = useRef<Speed>(speed);
  const chooseRef = useRef<(n: number) => void>(() => undefined);
  const scrubbed = useRef(false);
  const promptNo = useRef(0);
  const replayNo = useRef(0);

  /** The region of a node by the same rule as the scene. */
  const regionOfId = (id: string): RegionId | undefined => {
    const n = byIdRef.current.get(id);
    return n ? regionOfNode(n) : undefined;
  };

  const show = (path: TracePath | null, o: { previous?: TracePath | null; progress?: number; frame?: boolean } = {}) => {
    shownRef.current = path;
    setShown(path);
    setSelected(null);
    dispatch("cortex:path-set", { path, ...o });
  };

  const livePath = (s: TrailState): TracePath => ({ id: `live-${promptNo.current}`, source: "live", run: null, steps: s.current });
  const previousPath = (s: TrailState): TracePath | null => (s.previous.length ? { id: `live-${promptNo.current - 1}`, source: "live", run: null, steps: s.previous } : null);

  /** The group of a step when the path has more than 40 steps, so that the group of the step that plays opens. */
  const openGroupOf = (n: number) => {
    const steps = shownRef.current?.steps ?? [];
    if (steps.length <= PATH_GROUP_AFTER) return;
    const groups = routeGroups(steps, regionOfId);
    const at = groups.findIndex((g) => g.steps.includes(n));
    if (at >= 0) setOpenGroups((cur) => (cur.has(at) ? cur : new Set([...cur, at])));
  };

  useEffect(() => {
    const q = new TrailQueue({
      play: (step) => {
        dispatch("cortex:play-step", step);
        bus.emit("step", { step });
        setActive(keyOf(step));
        setSelected(null);
        setPhase("playing");
        setAnnounce(`${step.mode === "predicted" ? "Predicted step" : "Step"} ${step.n}. ${step.sentence}`);
        openGroupOf(step.n);
      },
      catchingUp: (on) => {
        setCatching(on);
        dispatch("cortex:path-play", { playing: true, speed: on ? 2 : mode0.current === "live" ? 1 : Number(speedRef.current) });
      },
      idle: () => {
        q.setSpeed(1);
        q.setCatchUp(true);
        setPhase("idle");
        setMode((m) => (m === "run" ? m : "live"));
      },
    });
    queue.current = q;
    // The smoke test sends events through this handle, which exists only in a development build.
    if (import.meta.env.DEV && new URLSearchParams(location.search).has("smoke")) (window as unknown as { __cortexBus?: typeof bus }).__cortexBus = bus;
    // A click on a region caption opens the Graph window at that region, with its hottest nodes.
    const offRegion = bus.on("region", ({ id }) => bus.emit("open", { app: "graph", params: { region: id } }));
    const off = bus.on("fire", ({ event, activation }) => {
      const r = addEvent(state.current, event, activation);
      state.current = r.state;
      setTrail(r.state);
      if (r.step.n === 1) {
        promptNo.current += 1;
        setOpen(true);
      }
      // a recorded run on show is not replaced by a live prompt, which waits in the trail for Return to Live
      if (mode0.current === "run") return;
      // A live step ends a replay or a prediction that is still playing.
      if (mode0.current !== "live") {
        q.clear();
        q.setSpeed(1);
        q.setCatchUp(true);
        mode0.current = "live";
        setMode("live");
      }
      show(livePath(r.state), { previous: previousPath(r.state), progress: scrubbed.current ? undefined : r.step.n === 1 ? 0 : r.step.n });
      q.push(r.step);
    });
    // a window shows a path, eg the Graph window with a recorded agent run
    const offOpen = bus.on("path-open", ({ path }) => {
      q.clear();
      q.setSpeed(Number(speedRef.current));
      q.setCatchUp(false);
      mode0.current = "run";
      setMode("run");
      setOpen(true);
      scrubbed.current = false;
      setHeld(null);
      setNote("");
      setOpenGroups(new Set());
      // the whole route is framed first, so the camera stays still while the head travels
      setGraphView({ pathFollow: false });
      show(path, { progress: 0, frame: true });
      dispatch("cortex:path-play", { playing: true, speed: Number(speedRef.current) });
      path.steps.forEach((s) => q.push(s));
    });
    const offProgress = bus.on("path-progress", ({ id, n, fraction }) => {
      if (id === shownRef.current?.id) setProgress(n + fraction);
    });
    // a click on a badge on the canvas selects its first step
    const onPick = (ev: Event) => chooseRef.current((ev as CustomEvent<{ n: number }>).detail.n);
    window.addEventListener("cortex:path-pick", onPick);
    return () => {
      off();
      offOpen();
      offProgress();
      offRegion();
      window.removeEventListener("cortex:path-pick", onPick);
      q.clear();
      queue.current = null;
    };
    // the handlers read the current values through refs, so the queue and the listeners are made once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    byIdRef.current = byId;
    mode0.current = mode;
    speedRef.current = speed;
  }, [byId, mode, speed]);

  // The panel covers 24rem of the left edge (its offset and its width), so the scene centres in the rest.
  useEffect(() => {
    dispatch("cortex:view-inset", { px: open ? 384 : 0 });
    return () => {
      dispatch("cortex:view-inset", { px: 0 });
    };
  }, [open]);

  useEffect(() => {
    if (!active) return;
    const box = list.current;
    const row = box?.querySelector<HTMLElement>(`[data-step="${active}"]`);
    // only the list of steps scrolls, never the panel round it
    if (box && row) {
      const top = row.offsetTop - box.offsetTop;
      if (top < box.scrollTop) box.scrollTop = top;
      else if (top + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + row.offsetHeight - box.clientHeight;
    }
  }, [active]);

  const steps = useMemo(() => shown?.steps ?? trail.current, [shown, trail]);
  const count = steps.length;
  const grouped = count > PATH_GROUP_AFTER;

  // the regions of every step, in the order of the route, for the rows, the strip and the track
  const rowRegions = useMemo(() => {
    const out: RegionId[][] = [];
    let before: RegionId | null = null;
    const regionOf = (id: string): RegionId | undefined => {
      const n = byId.get(id);
      return n ? regionOfNode(n) : undefined;
    };
    for (const s of steps) {
      const r = stepRegions(s, regionOf, before);
      out.push(r);
      before = r[r.length - 1] ?? before;
    }
    return out;
  }, [steps, byId]);
  const runs: RouteRun[] = useMemo(() => routeRuns(steps, (id) => (byId.get(id) ? regionOfNode(byId.get(id)!) : undefined)), [steps, byId]);
  const groups: RouteRun[] = useMemo(() => routeGroups(steps, (id) => (byId.get(id) ? regionOfNode(byId.get(id)!) : undefined)), [steps, byId]);
  const findings = useMemo(() => steps.reduce((n, s) => n + (s.markers?.length ?? 0), 0), [steps]);
  const lostBy = useMemo(() => steps.map((s) => s.activation.filter((a) => !isMissing(a.id) && !byId.has(a.id)).length), [steps, byId]);
  const missing = useMemo(() => (shown?.source === "run" ? absentSummary(shown, (id) => byId.has(id)) : null), [shown, byId]);

  /** Choose a step: the line highlights its segment and waypoint, the camera eases to it, and live steps wait (docs/BRAIN.md). */
  const choose = (n: number) => {
    if (n < 1 || n > count) return;
    queue.current?.pause();
    scrubbed.current = true;
    setPhase("paused");
    setHeld(n);
    setSelected(n);
    setProgress(progressOf(n, 1));
    dispatch("cortex:path-play", { playing: false });
    dispatch("cortex:path-seek", { n, fraction: 1, select: true });
    openGroupOf(n);
  };
  useEffect(() => {
    chooseRef.current = choose;
  });

  const seek = (p: number) => {
    queue.current?.pause();
    scrubbed.current = true;
    setPhase("paused");
    const at = Math.min(count + 1, Math.max(1, p));
    const n = Math.min(count, Math.floor(at));
    const fraction = at >= count + 1 ? 1 : at - n;
    setHeld(n);
    setSelected(null);
    setProgress(at);
    dispatch("cortex:path-play", { playing: false });
    dispatch("cortex:path-seek", { n, fraction });
    openGroupOf(n);
  };

  /** Play from a step: the steps from there on are queued again and the head starts at the beginning of the first. */
  const playFrom = (n: number) => {
    const q = queue.current;
    const path = shownRef.current;
    if (!q || !path) return;
    q.clear();
    q.setSpeed(mode0.current === "live" ? 1 : Number(speedRef.current));
    scrubbed.current = false;
    setHeld(null);
    setSelected(null);
    dispatch("cortex:path-play", { playing: true, speed: mode0.current === "live" ? 1 : Number(speedRef.current) });
    dispatch("cortex:path-seek", { n, fraction: 0 });
    path.steps.slice(n - 1).forEach((s) => q.push(s));
  };

  const toggle = () => {
    const q = queue.current;
    if (!q) return;
    if (phase === "playing") {
      q.pause();
      setPhase("paused");
      setHeld(Math.max(1, currentStep(progress, count)));
      dispatch("cortex:path-play", { playing: false });
      return;
    }
    if (q.isPaused && !scrubbed.current) {
      q.resume();
      setPhase("playing");
      setHeld(null);
      dispatch("cortex:path-play", { playing: true, speed: mode0.current === "live" ? 1 : Number(speedRef.current) });
      return;
    }
    // after a scrub, a chosen step or the end of the path, play starts from the step that the head is on, or the first
    playFrom(pathAtEnd(progress, count) || progress < 1 ? 1 : currentStep(progress, count));
  };

  const whole = () => {
    queue.current?.clear();
    scrubbed.current = false;
    setPhase("idle");
    setHeld(null);
    setSelected(null);
    setGraphView({ pathFollow: false });
    dispatch("cortex:path-play", { playing: true, speed: 1 });
    dispatch("cortex:path-frame", {});
  };

  const goLive = () => {
    queue.current?.clear();
    queue.current?.setSpeed(1);
    queue.current?.setCatchUp(true);
    scrubbed.current = false;
    mode0.current = "live";
    setMode("live");
    setPhase("idle");
    setHeld(null);
    setNote("");
    dispatch("cortex:path-play", { playing: true, speed: 1 });
    const live = livePath(state.current);
    if (state.current.current.length) show(live, { previous: previousPath(state.current), progress: live.steps.length + 1 });
    else show(null);
  };

  const replay = () => {
    const found = replaySteps(state.current);
    if (!found.length) {
      setNote("No prompt has been recorded yet.");
      return;
    }
    setNote("");
    const q = queue.current;
    if (!q) return;
    q.clear();
    q.setSpeed(Number(speed));
    q.setCatchUp(false);
    scrubbed.current = false;
    mode0.current = "replay";
    setMode("replay");
    setHeld(null);
    setOpenGroups(new Set());
    replayNo.current += 1;
    show({ id: `replay-${replayNo.current}`, source: "replay", run: null, steps: found }, { previous: found === state.current.current ? previousPath(state.current) : null, progress: 0 });
    dispatch("cortex:path-play", { playing: true, speed: Number(speed) });
    found.forEach((s) => q.push(s));
  };

  const tryPrompt = async () => {
    const text = prompt.trim();
    const q = queue.current;
    if (!text || busy || !q) return;
    setBusy(true);
    setNote("");
    try {
      const plan = await api.plan(text);
      const planned = stepsFromPlan(plan, (id) => byIdRef.current.get(id)?.label ?? id);
      if (!planned.length) {
        setNote("The plan does not fire any node in the graph.");
        return;
      }
      q.clear();
      q.setSpeed(1);
      q.setCatchUp(false);
      scrubbed.current = false;
      mode0.current = "predicted";
      setMode("predicted");
      setHeld(null);
      setOpenGroups(new Set());
      show({ id: `plan-${text.length}-${planned.length}-${Date.now()}`, source: "plan", run: null, steps: planned }, { previous: null, progress: 0 });
      dispatch("cortex:path-play", { playing: true, speed: 1 });
      planned.forEach((s) => q.push(s));
    } catch (err) {
      setNote(`The plan could not be made. ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setBusy(false);
    }
  };

  const onKeys = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button[data-step]") ?? []);
    const at = rows.findIndex((r) => r === document.activeElement);
    const next = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.click();
  };

  if (!open) {
    return (
      <div data-brain-block className="absolute left-16 top-12 z-10">
        <IconButton icon={ListOrdered} label="Open the thought trail" className="border-rule-strong bg-surface" onClick={() => setOpen(true)} />
      </div>
    );
  }

  const source = shown?.source ?? "live";
  const isRun = source === "run";
  const isPlan = source === "plan";
  const canPrevious = (source === "live" || source === "replay") && trail.previous.length > 0;
  const rowOf = (s: TrailStep) => (
    <Row key={keyOf(s)} step={s} active={active === keyOf(s)} selected={selected === s.n} regions={rowRegions[s.n - 1] ?? []} lost={lostBy[s.n - 1] ?? 0} onChoose={choose} />
  );

  return (
    <section
      aria-label="Thought trail"
      data-brain-block
      className="absolute left-16 top-12 z-10 flex max-h-[calc(100%-4rem)] w-80 min-w-0 flex-col overflow-hidden rounded-md border border-rule-strong bg-surface text-ink"
    >
      <header className="flex min-w-0 items-center justify-between gap-2 border-b border-rule px-3 py-2">
        <h2 className="min-w-0 truncate text-ui font-medium">{isRun ? `Recorded run ${shown?.run?.replace(/^run:/, "") ?? ""}` : "Thought trail"}</h2>
        <IconButton icon={X} label="Close the thought trail" onClick={() => setOpen(false)} />
      </header>

      <div className="min-w-0 shrink-0 space-y-2 border-b border-rule px-3 py-2">
        {isRun ? (
          <div className="flex min-w-0 items-start justify-between gap-2">
            <PathLegend />
            <Button className="shrink-0 whitespace-nowrap" onClick={goLive}>
              Close the path
            </Button>
          </div>
        ) : (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Button variant={mode === "live" ? "primary" : "secondary"} icon={<Play size={14} aria-hidden="true" />} aria-pressed={mode === "live"} onClick={goLive}>
                Live
              </Button>
              <Button icon={<RotateCcw size={14} aria-hidden="true" />} onClick={replay}>
                Replay last prompt
              </Button>
            </div>
            <form
              className="flex min-w-0 gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void tryPrompt();
              }}
            >
              <input type="text" aria-label="A prompt to try" placeholder="Type a prompt to try" value={prompt} onChange={(e) => setPrompt(e.target.value)} className={FIELD} />
              <Button type="submit" className="shrink-0 whitespace-nowrap" disabled={busy || !prompt.trim()}>
                Try a prompt
              </Button>
            </form>
          </>
        )}
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-small text-ink-soft">Replay speed</span>
          <Segmented
            label="Replay speed"
            value={speed}
            onChange={(v) => {
              setSpeed(v);
              queue.current?.setSpeed(Number(v));
              if (mode0.current !== "live") dispatch("cortex:path-play", { playing: phase !== "paused", speed: Number(v) });
            }}
            options={[
              { value: "0.5", label: "Half" },
              { value: "1", label: "Normal" },
              { value: "2", label: "Double" },
            ]}
          />
        </div>
        {catching ? <p className="text-small text-ink-soft">Catching up: steps are playing at double speed.</p> : null}
        {note ? <p className="text-small text-hold">{note}</p> : null}
        {missing && missing.absent ? (
          <p className="text-small text-hold">
            {missing.absent} of {missing.total} nodes are not in this graph, in {missing.steps.length === 1 ? "step" : "steps"} {stepsLabel(missing.steps)}.
          </p>
        ) : null}
        <PathControls
          count={count}
          track={groups}
          position={progress}
          playing={phase === "playing"}
          held={held !== null && mode === "live" ? held : null}
          follow={follow}
          previous={previousOn && canPrevious}
          canPrevious={canPrevious}
          onToggle={toggle}
          onSeek={seek}
          onWhole={whole}
          onFollow={(on) => setGraphView({ pathFollow: on })}
          onPrevious={(on) => setGraphView({ pathPrevious: on })}
          onLive={goLive}
        />
      </div>

      <div data-route-area className="min-w-0 shrink-0 space-y-2 border-b border-rule px-3 py-2">
        {/* more than 12 runs show by step, each in the region where it starts, so that every chip shows without a scroll (13 October 2026) */}
        <RouteStrip runs={runs.length > 12 ? groups : runs} findings={findings} onPick={choose} />
      </div>

      <div ref={list} onKeyDown={onKeys} className="min-h-40 min-w-0 flex-1 overflow-y-auto px-1 py-1">
        {!count ? (
          <p className="px-2 py-2 text-small text-ink-soft">Steps appear here as Claude Code works on a prompt.</p>
        ) : (
          <>
            {isPlan ? (
              <div className="min-w-0 px-2 pb-1">
                <div className="flex min-w-0 items-baseline justify-between gap-2">
                  <h3 className="min-w-0 truncate text-small font-medium text-ink">Predicted from your prompt</h3>
                  <button type="button" className="text-small text-ink-soft hover:text-ink" onClick={goLive}>
                    Clear
                  </button>
                </div>
                <p className="text-caption text-ink-faint">Nothing was run, and these steps are not recorded.</p>
              </div>
            ) : null}
            {grouped ? (
              <div>
                {groups.map((g, i) => {
                  const isOpen = openGroups.has(i);
                  const Icon = isOpen ? ChevronDown : ChevronRight;
                  return (
                    <section key={`${g.region}-${i}`} aria-label={`${REGION_NAME[g.region]}, steps ${stepsLabel(g.steps)}`}>
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() =>
                          setOpenGroups((cur) => {
                            const next = new Set(cur);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          })
                        }
                        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-small text-ink hover:bg-raised"
                      >
                        <Icon size={14} aria-hidden="true" className="shrink-0" />
                        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${REGION_BG[g.region]}`} />
                        <span className="min-w-0 truncate">
                          {REGION_NAME[g.region]}, {g.steps.length === 1 ? "step" : "steps"} {stepsLabel(g.steps)}
                        </span>
                        <span className="num ml-auto shrink-0 text-caption text-ink-faint">{g.steps.length}</span>
                      </button>
                      {isOpen ? <ol aria-label={`Steps ${stepsLabel(g.steps)}`}>{g.steps.map((n) => rowOf(steps[n - 1]))}</ol> : null}
                    </section>
                  );
                })}
              </div>
            ) : (
              <ol aria-label={isPlan ? "Predicted steps" : isRun ? "Recorded steps" : "Observed steps"}>{steps.map((s) => rowOf(s))}</ol>
            )}
          </>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </section>
  );
}
