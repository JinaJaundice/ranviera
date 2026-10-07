import type { Mission, MissionState } from "@shared/types";
import type { Tone } from "../../components/StatusDot";

export const STATE_LABEL: Record<MissionState, string> = {
  planned: "Planned",
  running: "Running",
  checking: "Checking",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export function stateTone(s: MissionState): Tone {
  switch (s) {
    case "running":
    case "checking":
    case "done":
      return "pass";
    case "failed":
      return "block";
    case "stopped":
      return "hold";
    default:
      return "idle";
  }
}

export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.trim() || "Untitled mission";
}

export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return today ? time : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

export function totalCost(m: Mission): number | null {
  const costs = m.steps.map((s) => s.cost_usd).filter((c): c is number => typeof c === "number");
  return costs.length ? costs.reduce((a, b) => a + b, 0) : null;
}

export function formatCost(c: number | null): string {
  return c === null ? "" : `$${c.toFixed(2)}`;
}

export function elapsed(m: Mission, now: number): string {
  const start = Date.parse(m.created);
  if (Number.isNaN(start)) return "";
  const running = m.state === "running" || m.state === "checking";
  const ends = m.steps.map((s) => (s.ended ? Date.parse(s.ended) : NaN)).filter((n) => !Number.isNaN(n));
  const end = running ? now : ends.length ? Math.max(...ends) : start;
  const secs = Math.max(0, Math.round((end - start) / 1000));
  const mins = Math.floor(secs / 60);
  return mins > 0 ? `${mins} min ${secs % 60} s` : `${secs} s`;
}
