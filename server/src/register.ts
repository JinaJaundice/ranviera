// The register log, summarised by day.
import fs from "node:fs";
import path from "node:path";
import type { RegisterDay } from "../../shared/types.ts";
import type { Config } from "./config.ts";
import { dayKey, monthsBetween } from "./util.ts";

export interface RegisterRecord {
  t?: string | number;
  kind?: string;
  session?: string;
  path?: string;
  faults?: unknown;
  metrics?: unknown;
}

export function registerTime(t: string | number | undefined): Date | null {
  if (t === undefined || t === null || t === "") return null;
  const d = typeof t === "number" ? new Date(t < 1e12 ? t * 1000 : t) : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function faultKeys(r: RegisterRecord): string[] {
  return Array.isArray(r.faults) ? r.faults.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

export function parseRegisterLine(line: string): RegisterRecord | null {
  if (!line.trim()) return null;
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === "object" ? (v as RegisterRecord) : null;
  } catch {
    return null;
  }
}

export function registerDays(cfg: Config, days: number, now: Date = new Date()): { days: RegisterDay[] } {
  const span = Math.max(1, Math.min(365, Math.floor(days) || 30));
  const start = new Date(now.getTime() - (span - 1) * 86400000);
  const table = new Map<string, RegisterDay>();
  for (let i = 0; i < span; i++) {
    const day = dayKey(new Date(start.getTime() + i * 86400000));
    table.set(day, { day, replies: 0, clean: 0, faults: 0 });
  }
  for (const month of monthsBetween(start, now)) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(cfg.claude_home, "register-log", `${month}.jsonl`), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const r = parseRegisterLine(line);
      if (!r) continue;
      const d = registerTime(r.t);
      const row = d ? table.get(dayKey(d)) : undefined;
      if (!row) continue;
      const n = faultKeys(r).length;
      row.faults += n;
      // hook.py writes a scored reply as kind "reply" (seen in the October 2026 log); "stop" is kept for older records
      if (r.kind === "reply" || r.kind === "stop") {
        row.replies += 1;
        if (n === 0) row.clean += 1;
      }
    }
  }
  return { days: [...table.values()] };
}
