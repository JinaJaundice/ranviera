import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Square } from "lucide-react";
import type { Mission, MissionLine } from "@shared/types";
import { Button } from "../../components/Button";
import { Section } from "../../components/Section";
import { StatusDot } from "../../components/StatusDot";
import { api } from "../../lib/api";
import { bus } from "../../lib/bus";
import { toast } from "../../shell/toastStore";
import { elapsed, formatCost, STATE_LABEL, stateTone, totalCost } from "./format";
import { openPath } from "./openPath";

const THROTTLE_MS = 250; // at most 4 refreshes a second

function lineClass(l: MissionLine): string {
  switch (l.kind) {
    case "tool":
      return "font-mono text-small text-ink-soft";
    case "result":
      return "text-body text-ink";
    case "error":
      return "text-body text-block";
    case "system":
      return "text-small italic text-ink-faint";
    default:
      return "text-body text-ink";
  }
}

export function MissionDetail({ initial }: { initial: Mission }) {
  const id = initial.id;
  const [mission, setMission] = useState<Mission>(initial);
  const [now, setNow] = useState(() => Date.now());
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    last.current = Date.now();
    api
      .mission(id)
      .then(setMission)
      .catch(() => undefined);
  }, [id]);

  useEffect(() => {
    refresh();
    const off = bus.on("mission", (m) => {
      if (m.id !== id) return;
      const wait = THROTTLE_MS - (Date.now() - last.current);
      if (wait <= 0) refresh();
      else if (!timer.current) {
        timer.current = setTimeout(() => {
          timer.current = null;
          refresh();
        }, wait);
      }
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [id, refresh]);

  const running = mission.state === "running" || mission.state === "checking";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [mission.lines.length, follow]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  const cost = formatCost(totalCost(mission));
  const files = Array.from(new Set(mission.steps.flatMap((s) => s.files)));
  const lastTool = [...mission.lines].reverse().find((l) => l.kind === "tool")?.tool ?? null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex min-w-0 items-start gap-3 border-b border-rule px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-ui text-ink" title={mission.prompt}>
            {mission.prompt}
          </p>
          <p className="mt-1 flex items-center gap-2 text-small text-ink-soft">
            <StatusDot tone={stateTone(mission.state)} />
            <span>{STATE_LABEL[mission.state]}</span>
            <span className="num">{elapsed(mission, now)}</span>
            {cost ? <span className="num">{cost}</span> : null}
          </p>
        </div>
        {running ? (
          <Button
            icon={<Square size={14} aria-hidden="true" />}
            onClick={() => api.stopMission(id).then(refresh).catch((e: unknown) => toast(`The mission could not be stopped. ${e instanceof Error ? e.message : ""}`.trim(), "error"))}
          >
            Stop
          </Button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap gap-2 border-b border-rule px-4 py-2">
          {mission.steps.map((s, i) => (
            <div key={`${s.agent}-${i}`} className="flex min-w-0 items-center gap-2 rounded-md border border-rule bg-raised px-2 py-1 text-small">
              <StatusDot tone={stateTone(s.state)} label={STATE_LABEL[s.state]} />
              <span className="font-mono text-ink">{s.agent}</span>
              <span className="text-ink-faint">{STATE_LABEL[s.state]}</span>
              {running && i === mission.step && lastTool ? <span className="font-mono text-ink-soft">{lastTool}</span> : null}
            </div>
          ))}
        </div>

        <div className="relative min-h-0 flex-1">
          <div ref={scroller} onScroll={onScroll} role="log" aria-label="Mission output" className="h-full space-y-1 overflow-y-auto px-4 py-3">
            {mission.lines.length === 0 ? <p className="text-body text-ink-faint">The mission has produced no output yet.</p> : null}
            {mission.lines.map((l, i) => (
              <p key={i} className={`min-w-0 whitespace-pre-wrap break-words ${lineClass(l)}`}>
                {l.kind === "tool" && l.tool ? <span className="mr-2 text-ink">{l.tool}</span> : null}
                {l.text}
              </p>
            ))}
          </div>
          {follow ? null : (
            <div className="absolute bottom-3 right-4">
              <Button
                icon={<ArrowDown size={14} aria-hidden="true" />}
                onClick={() => {
                  setFollow(true);
                }}
              >
                Follow
              </Button>
            </div>
          )}
        </div>

        {files.length > 0 ? (
          <div className="max-h-40 shrink-0 overflow-y-auto border-t border-rule">
            <Section title="Files written">
              <ul className="divide-y divide-rule">
                {files.map((f) => (
                  <li key={f} className="flex min-w-0 items-center gap-3 py-1">
                    <span className="min-w-0 flex-1 truncate font-mono text-small text-ink" title={f}>
                      {f}
                    </span>
                    <Button onClick={() => openPath(f)}>Open</Button>
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
