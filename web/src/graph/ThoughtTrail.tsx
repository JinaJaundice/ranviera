// The thought trail panel (docs/BRAIN.md, "The thought trail"): the numbered steps of the current prompt at the left
// edge of the canvas, with Live, Replay last prompt and Try a prompt. It opens on the first step of a prompt and
// closes only when the person closes it. Each step is played on the canvas through the window event cortex:play-step.
import { useEffect, useRef, useState } from "react";
import { ListOrdered, Play, RotateCcw, X } from "lucide-react";
import { REGIONS, type RegionId } from "@shared/brain";
import { api } from "../lib/api";
import { bus } from "../lib/bus";
import { selectNode, useStore } from "../lib/store";
import { Button } from "../components/Button";
import { IconButton } from "../components/IconButton";
import { Segmented } from "../components/Segmented";
import { REGION_BG, EMPTY_TRAIL, TrailQueue, addEvent, replaySteps, stepRegion, stepsFromPlan, type TrailState } from "./brain/trail";
import type { TrailStep } from "./brain/types";

type Mode = "live" | "replay" | "predicted";
type Speed = "0.5" | "1" | "2";

const REGION_NAME = Object.fromEntries(REGIONS.map((r) => [r.id, r.label])) as Record<RegionId, string>;
const FIELD = "h-8 w-full min-w-0 rounded-md border border-rule-strong bg-sunken px-2 text-body text-ink placeholder:text-ink-faint";

const keyOf = (s: TrailStep) => `${s.mode}-${s.n}`;

function clock(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-GB");
}

function Row({ step, active, region, onChoose }: { step: TrailStep; active: boolean; region: RegionId | null; onChoose: (step: TrailStep) => void }) {
  const predicted = step.mode === "predicted";
  const dot = region ? REGION_BG[region] : "bg-ink-faint";
  return (
    <li>
      <button
        type="button"
        data-step={keyOf(step)}
        aria-current={active ? "step" : undefined}
        onClick={() => onChoose(step)}
        className={`grid w-full min-w-0 grid-cols-[1.5rem_0.75rem_minmax(0,1fr)_auto] items-start gap-2 rounded-md border-l-2 px-2 py-1.5 text-left hover:bg-raised ${
          active ? "border-signal bg-raised" : "border-transparent"
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
            {region ? REGION_NAME[region] : "No region"}
            {step.activation.length ? ` · ${step.activation.length} ${step.activation.length === 1 ? "node" : "nodes"}` : ""}
          </span>
        </span>
        <span className="num pt-0.5 text-caption text-ink-faint">{predicted ? "Predicted" : clock(step.ts)}</span>
      </button>
    </li>
  );
}

export function ThoughtTrail() {
  const byId = useStore((s) => s.byId);
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState<TrailState>(EMPTY_TRAIL);
  const [predicted, setPredicted] = useState<TrailStep[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("live");
  const [speed, setSpeed] = useState<Speed>("1");
  const [catching, setCatching] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const state = useRef<TrailState>(EMPTY_TRAIL);
  const queue = useRef<TrailQueue | null>(null);
  const list = useRef<HTMLDivElement>(null);
  // The handlers read the latest map and mode through these two refs.
  const byIdRef = useRef(byId);
  const mode0 = useRef<Mode>(mode);

  useEffect(() => {
    const q = new TrailQueue({
      play: (step) => {
        window.dispatchEvent(new CustomEvent("cortex:play-step", { detail: step }));
        bus.emit("step", { step });
        setActive(keyOf(step));
        setAnnounce(`${step.mode === "predicted" ? "Predicted step" : "Step"} ${step.n}. ${step.sentence}`);
      },
      catchingUp: setCatching,
      idle: () => {
        q.setSpeed(1);
        setMode("live");
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
      if (r.step.n === 1) setOpen(true);
      // A live step ends a replay or a prediction that is still playing.
      if (mode0.current !== "live") {
        q.clear();
        q.setSpeed(1);
        setMode("live");
      }
      q.push(r.step);
    });
    return () => {
      off();
      offRegion();
      q.clear();
      queue.current = null;
    };
  }, []);

  useEffect(() => {
    byIdRef.current = byId;
    mode0.current = mode;
  }, [byId, mode]);

  // The panel covers 24rem of the left edge (its offset and its width), so the scene centres in the rest.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("cortex:view-inset", { detail: { px: open ? 384 : 0 } }));
    return () => {
      window.dispatchEvent(new CustomEvent("cortex:view-inset", { detail: { px: 0 } }));
    };
  }, [open]);

  useEffect(() => {
    if (!active) return;
    list.current?.querySelector(`[data-step="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  /** Turn the camera to the region of a step and select its first node. */
  const choose = (step: TrailStep) => {
    const first = step.activation.find((a) => byId.has(a.id))?.id;
    if (first) selectNode(first);
    const region = stepRegion(step, byId);
    if (region) window.dispatchEvent(new CustomEvent("cortex:focus-region", { detail: { id: region } }));
  };

  const goLive = () => {
    queue.current?.clear();
    queue.current?.setSpeed(1);
    setMode("live");
    setNote("");
  };

  const replay = () => {
    const steps = replaySteps(state.current);
    if (!steps.length) {
      setNote("No prompt has been recorded yet.");
      return;
    }
    setNote("");
    const q = queue.current;
    if (!q) return;
    q.clear();
    q.setSpeed(Number(speed));
    setMode("replay");
    steps.forEach((s) => q.push(s));
  };

  const tryPrompt = async () => {
    const text = prompt.trim();
    const q = queue.current;
    if (!text || busy || !q) return;
    setBusy(true);
    setNote("");
    try {
      const plan = await api.plan(text);
      const steps = stepsFromPlan(plan, (id) => byIdRef.current.get(id)?.label ?? id);
      if (!steps.length) {
        setNote("The plan does not fire any node in the graph.");
        return;
      }
      setPredicted(steps);
      q.clear();
      q.setSpeed(1);
      setMode("predicted");
      steps.forEach((s) => q.push(s));
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

  const steps = trail.current;
  return (
    <section
      aria-label="Thought trail"
      data-brain-block
      className="absolute left-16 top-12 z-10 flex max-h-[calc(100%-4rem)] w-80 min-w-0 flex-col rounded-md border border-rule-strong bg-surface text-ink"
    >
      <header className="flex min-w-0 items-center justify-between gap-2 border-b border-rule px-3 py-2">
        <h2 className="min-w-0 truncate text-ui font-medium">Thought trail</h2>
        <IconButton icon={X} label="Close the thought trail" onClick={() => setOpen(false)} />
      </header>

      <div className="min-w-0 space-y-2 border-b border-rule px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button variant={mode === "live" ? "primary" : "secondary"} icon={<Play size={14} aria-hidden="true" />} aria-pressed={mode === "live"} onClick={goLive}>
            Live
          </Button>
          <Button icon={<RotateCcw size={14} aria-hidden="true" />} onClick={replay}>
            Replay last prompt
          </Button>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-small text-ink-soft">Replay speed</span>
          <Segmented
            label="Replay speed"
            value={speed}
            onChange={setSpeed}
            options={[
              { value: "0.5", label: "Half" },
              { value: "1", label: "Normal" },
              { value: "2", label: "Double" },
            ]}
          />
        </div>
        <form
          className="flex min-w-0 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void tryPrompt();
          }}
        >
          <input
            type="text"
            aria-label="A prompt to try"
            placeholder="Type a prompt to try"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className={FIELD}
          />
          <Button type="submit" className="shrink-0 whitespace-nowrap" disabled={busy || !prompt.trim()}>
            Try a prompt
          </Button>
        </form>
        {catching ? <p className="text-small text-ink-soft">Catching up: steps are playing at double speed.</p> : null}
        {note ? <p className="text-small text-hold">{note}</p> : null}
      </div>

      <div ref={list} onKeyDown={onKeys} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-1 py-1">
        {steps.length ? (
          <ol aria-label="Observed steps">
            {steps.map((s) => (
              <Row key={keyOf(s)} step={s} active={active === keyOf(s)} region={stepRegion(s, byId)} onChoose={choose} />
            ))}
          </ol>
        ) : predicted.length ? null : (
          <p className="px-2 py-2 text-small text-ink-soft">Steps appear here as Claude Code works on a prompt.</p>
        )}
        {predicted.length ? (
          <div className={steps.length ? "mt-2 border-t border-rule pt-2" : ""}>
            <div className="flex min-w-0 items-baseline justify-between gap-2 px-2">
              <h3 className="min-w-0 truncate text-small font-medium text-ink">Predicted from your prompt</h3>
              <button type="button" className="text-small text-ink-soft hover:text-ink" onClick={() => setPredicted([])}>
                Clear
              </button>
            </div>
            <p className="px-2 pb-1 text-caption text-ink-faint">Nothing was run, and these steps are not recorded.</p>
            <ol aria-label="Predicted steps">
              {predicted.map((s) => (
                <Row key={keyOf(s)} step={s} active={active === keyOf(s)} region={stepRegion(s, byId)} onChoose={choose} />
              ))}
            </ol>
          </div>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </section>
  );
}
