// The learning switches of the settings record. The record is delta shaped: only an explicit choice is stored, and a number
// that is outside its range is refused in the window with a sentence that names the range, so that the server never has to clamp it.
import type { LearnSettings } from "@shared/learn/models";

export interface NumberField {
  key: "chunk" | "compaction" | "interval" | "files";
  label: string;
  hint: string;
  min: number;
  max: number;
  fallback: number;
  unit: string;
}

export const NUMBER_FIELDS: NumberField[] = [
  { key: "chunk", label: "Reading chunk", hint: "How much text is read at a time when claims are extracted.", min: 500, max: 1_000_000, fallback: 4096, unit: "tokens" },
  { key: "compaction", label: "Compaction threshold", hint: "A session is summarised when its context grows past this size.", min: 32_000, max: 10_000_000, fallback: 150_000, unit: "tokens" },
  { key: "interval", label: "Scan interval", hint: "How often a linked folder in scan mode is read again.", min: 30, max: 86_400, fallback: 300, unit: "seconds" },
  { key: "files", label: "Files for each pass", hint: "How many changed files a scan queues at most.", min: 1, max: 1000, fallback: 50, unit: "files" },
];

export function readNumber(s: LearnSettings, key: NumberField["key"]): number | undefined {
  switch (key) {
    case "chunk":
      return s.graph?.extractionChunkTokens;
    case "compaction":
      return s.compaction?.thresholdTokens;
    case "interval":
      return s.scan?.intervalSeconds;
    case "files":
      return s.scan?.maxFilesPerPass;
  }
}

/** Reads what was typed. An empty value clears the choice, so the default applies again. */
export function parseNumber(raw: string, f: NumberField): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const t = raw.trim().replace(/[,\s]/g, "");
  if (t === "") return { ok: true, value: undefined };
  const n = Number(t);
  if (!Number.isInteger(n)) return { ok: false, error: `${f.label} must be a whole number.` };
  if (n < f.min || n > f.max) return { ok: false, error: `${f.label} must be between ${f.min.toLocaleString("en-GB")} and ${f.max.toLocaleString("en-GB")} ${f.unit}.` };
  return { ok: true, value: n };
}

function prune<T extends object>(o: T): T | undefined {
  const entries = Object.entries(o).filter(([, v]) => v !== undefined);
  return entries.length ? (Object.fromEntries(entries) as T) : undefined;
}

export function withNumber(s: LearnSettings, key: NumberField["key"], value: number | undefined): LearnSettings {
  const next: LearnSettings = { ...s };
  switch (key) {
    case "chunk":
      next.graph = prune({ ...s.graph, extractionChunkTokens: value });
      break;
    case "compaction":
      next.compaction = prune({ ...s.compaction, thresholdTokens: value });
      break;
    case "interval":
      next.scan = prune({ ...s.scan, intervalSeconds: value });
      break;
    case "files":
      next.scan = prune({ ...s.scan, maxFilesPerPass: value });
      break;
  }
  for (const k of ["graph", "compaction", "scan"] as const) if (next[k] === undefined) delete next[k];
  return next;
}

export type ToolName = "research" | "pdf" | "explain";

/** The PDF tool is on unless it was switched off. Research and free recall are off unless they were switched on. */
export function toolOn(s: LearnSettings, name: ToolName): boolean {
  const v = s.agent?.tools?.[name];
  return name === "explain" || name === "research" ? v === true : v !== false;
}

export function withTool(s: LearnSettings, name: ToolName, on: boolean): LearnSettings {
  return { ...s, agent: { ...s.agent, tools: { ...s.agent?.tools, [name]: on } } };
}

export const graphOn = (s: LearnSettings): boolean => s.graph?.enabled !== false;

export function withGraph(s: LearnSettings, on: boolean): LearnSettings {
  return { ...s, graph: { ...s.graph, enabled: on } };
}
