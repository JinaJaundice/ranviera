import { useEffect, useRef, useState } from "react";
import { Pause, Play, Square } from "lucide-react";
import type { Activation, CortexEvent } from "@shared/types";
import { api } from "../../lib/api";
import { bus } from "../../lib/bus";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { advance, dayLabel, virtualAt } from "./inspect";

type Phase = "idle" | "loading" | "playing" | "paused";
type Item = { event: CortexEvent; activation: Activation[] };

/** Plays past events through the bus, one day in about 4 seconds, so the graph lights as it did. */
export function Replay() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const run = useRef({ items: [] as Item[], index: 0, start: 0, end: 0, elapsed: 0, last: 0 });
  const timer = useRef(0);

  const halt = () => {
    window.clearInterval(timer.current);
    timer.current = 0;
  };

  useEffect(() => () => halt(), []);

  const tick = () => {
    const r = run.current;
    const now = performance.now();
    r.elapsed += Math.min(250, now - r.last);
    r.last = now;
    const vt = virtualAt(r.start, r.elapsed);
    const next = advance(r.items, r.index, vt);
    for (let i = r.index; i < next; i += 1) {
      const it = r.items[i];
      if (it.activation.length) bus.emit("preview", { activation: it.activation, label: it.event.label });
    }
    r.index = next;
    setLabel(dayLabel(Math.min(vt, r.end)));
    if (vt >= r.end) {
      halt();
      setPhase("idle");
      setNote("The replay has finished.");
    }
  };

  const begin = async (days: number) => {
    halt();
    setNote("");
    setPhase("loading");
    const end = Date.now();
    const start = end - days * 86_400_000;
    try {
      const res = await api.replay(new Date(start).toISOString(), new Date(end).toISOString());
      const items = [...res.items].sort((a, b) => Date.parse(a.event.ts) - Date.parse(b.event.ts));
      if (!items.length) {
        setPhase("idle");
        setNote("The server holds no events for that period.");
        return;
      }
      run.current = { items, index: 0, start, end, elapsed: 0, last: performance.now() };
      setLabel(dayLabel(start));
      setNote(`${items.length} events. The server returns at most 2,000.`);
      setPhase("playing");
      timer.current = window.setInterval(tick, 80);
    } catch (err) {
      setPhase("idle");
      setNote(err instanceof Error ? err.message : "The replay could not load.");
    }
  };

  const pause = () => {
    halt();
    setPhase("paused");
  };
  const resume = () => {
    run.current.last = performance.now();
    timer.current = window.setInterval(tick, 80);
    setPhase("playing");
  };
  const stop = () => {
    halt();
    bus.emit("highlight", { ids: [] });
    setPhase("idle");
    setLabel("");
    setNote("");
  };

  const active = phase === "playing" || phase === "paused";

  return (
    <div className="min-w-0">
      {!active ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={phase === "loading"} icon={<Play size={14} aria-hidden="true" />} onClick={() => void begin(7)}>
            Replay the last 7 days
          </Button>
          <Button disabled={phase === "loading"} icon={<Play size={14} aria-hidden="true" />} onClick={() => void begin(30)}>
            Replay the last 30 days
          </Button>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          {phase === "playing" ? (
            <IconButton icon={Pause} label="Pause the replay" onClick={pause} />
          ) : (
            <IconButton icon={Play} label="Resume the replay" onClick={resume} />
          )}
          <IconButton icon={Square} label="Stop the replay" onClick={stop} />
          <span className="num min-w-0 truncate text-body text-ink" aria-live="off">
            {label}
          </span>
        </div>
      )}
      {phase === "loading" ? <p className="mt-2 text-small text-ink-soft">Loading events.</p> : null}
      {note ? <p className="mt-2 text-small text-ink-soft">{note}</p> : null}
    </div>
  );
}
