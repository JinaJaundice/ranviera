// The delta settings record <learn_dir>/settings.json. The source of truth is
// docs/CONTRACTS.md, section "Learning and knowledge (1 November 2026)"
// ("Settings and prompt overrides").
//
// Only explicit choices are stored. The sanitiser clamps numbers, drops invalid
// fields, never throws and keeps keys that it does not know, so that a newer file
// survives an older build.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BackgroundRole, CustomProviderSettings, LearnSettings, ModelRef, ModelSlot, ModelSlotName } from "../../../../shared/learn/models.ts";
import type { ThinkingLevel } from "../../../../shared/learn/sessions.ts";
import { normaliseBaseUrl } from "./endpoint.ts";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const CACHE_RETENTIONS = ["none", "short", "long"] as const;
export const SLOT_NAMES: readonly ModelSlotName[] = ["strong", "cheap", "vision"];
export const BACKGROUND_ROLES: readonly BackgroundRole[] = ["researcher", "extractor", "auditor", "pdfReader"];
export const COMPACTION_DEFAULT = 150_000;
export const COMPACTION_FLOOR = 32_000;
export const CHUNK_DEFAULT = 4096;
export const CHUNK_FLOOR = 500;
export const SCAN_INTERVAL_DEFAULT = 300;
export const SCAN_FILES_DEFAULT = 50;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 512): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const isoText = (v: unknown): string | undefined => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : undefined);

/** A finite number rounded to a whole number and held between the limits. Anything else is dropped. */
function whole(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function level(v: unknown): ThinkingLevel | undefined {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v) ? (v as ThinkingLevel) : undefined;
}

/** The keys of raw that are not in known, copied as they stand. */
function extras(raw: Obj, known: readonly string[]): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(raw)) if (!known.includes(k) && k !== "__proto__") out[k] = v;
  return out;
}

const nonEmpty = <T extends Obj>(o: T): T | undefined => (Object.keys(o).length > 0 ? o : undefined);

export function sanitiseModelRef(v: unknown): ModelRef | undefined {
  if (!isObj(v)) return undefined;
  const provider = text(v.provider, 128);
  const id = text(v.id, 512);
  return provider && id ? { provider, id } : undefined;
}

function sanitiseSlot(v: unknown): ModelSlot | undefined {
  if (!isObj(v)) return undefined;
  const out: Obj = extras(v, ["model", "thinkingLevel", "cacheRetention"]);
  const model = sanitiseModelRef(v.model);
  if (model) out.model = model;
  const lv = level(v.thinkingLevel);
  if (lv) out.thinkingLevel = lv;
  if (typeof v.cacheRetention === "string" && (CACHE_RETENTIONS as readonly string[]).includes(v.cacheRetention)) out.cacheRetention = v.cacheRetention;
  return nonEmpty(out) as ModelSlot | undefined;
}

function sanitiseModels(v: unknown): LearnSettings["models"] {
  if (!isObj(v)) return undefined;
  const out: Obj = extras(v, SLOT_NAMES);
  for (const name of SLOT_NAMES) {
    const slot = sanitiseSlot(v[name]);
    if (slot) out[name] = slot;
  }
  return nonEmpty(out) as LearnSettings["models"];
}

function sanitiseAgent(v: unknown): LearnSettings["agent"] {
  if (!isObj(v)) return undefined;
  const out: Obj = extras(v, ["models", "tools", "prompts"]);
  if (isObj(v.models)) {
    const roles: Obj = {};
    for (const role of BACKGROUND_ROLES) {
      const r = v.models[role];
      if (!isObj(r)) continue;
      const entry: Obj = {};
      const model = sanitiseModelRef(r.model);
      if (model) entry.model = model;
      const lv = level(r.thinkingLevel);
      if (lv) entry.thinkingLevel = lv;
      if (nonEmpty(entry)) roles[role] = entry;
    }
    if (nonEmpty(roles)) out.models = roles;
  }
  if (isObj(v.tools)) {
    const tools: Obj = {};
    for (const name of ["research", "pdf", "explain"]) {
      const b = bool(v.tools[name]);
      if (b !== undefined) tools[name] = b;
    }
    if (nonEmpty(tools)) out.tools = tools;
  }
  if (isObj(v.prompts)) {
    const prompts: Obj = {};
    for (const [k, b] of Object.entries(v.prompts)) if (k !== "__proto__" && k.length <= 200 && typeof b === "boolean") prompts[k] = b;
    if (nonEmpty(prompts)) out.prompts = prompts;
  }
  return nonEmpty(out) as LearnSettings["agent"];
}

function sanitiseCustomModels(v: unknown): NonNullable<CustomProviderSettings["models"]> {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: NonNullable<CustomProviderSettings["models"]> = [];
  for (const row of v) {
    if (!isObj(row)) continue;
    const id = text(row.id, 256);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const m: NonNullable<CustomProviderSettings["models"]>[number] = { id };
    if (row.image === true) m.image = true;
    const reasoning = bool(row.reasoning);
    if (reasoning !== undefined) m.reasoning = reasoning;
    const context = whole(row.context, 1, 100_000_000);
    if (context) m.context = context;
    const maxTokens = whole(row.maxTokens, 1, 100_000_000);
    if (maxTokens) m.maxTokens = maxTokens;
    out.push(m);
  }
  return out;
}

/** A pin accepts whole token counts of 1 or more and a three state reasoning flag. Pins for ids that the endpoint no longer lists are dropped. */
export function sanitiseOverrides(v: unknown, ids: ReadonlySet<string>): NonNullable<CustomProviderSettings["overrides"]> {
  const out: NonNullable<CustomProviderSettings["overrides"]> = {};
  if (!isObj(v)) return out;
  for (const [id, pin] of Object.entries(v)) {
    if (!ids.has(id) || !isObj(pin) || id === "__proto__") continue;
    const entry: NonNullable<CustomProviderSettings["overrides"]>[string] = {};
    if (typeof pin.context === "number" && Number.isInteger(pin.context) && pin.context >= 1) entry.context = pin.context;
    if (typeof pin.maxTokens === "number" && Number.isInteger(pin.maxTokens) && pin.maxTokens >= 1) entry.maxTokens = pin.maxTokens;
    const reasoning = bool(pin.reasoning);
    if (reasoning !== undefined) entry.reasoning = reasoning;
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return out;
}

function sanitiseCustom(v: unknown): CustomProviderSettings | undefined {
  if (!isObj(v)) return undefined;
  const out: Obj = extras(v, ["credentialBindingId", "authMode", "baseUrl", "models", "overrides", "manualModels", "localConfirmedAt"]);
  if (typeof v.credentialBindingId === "string" && /^[0-9a-f]{32}$/.test(v.credentialBindingId)) out.credentialBindingId = v.credentialBindingId;
  if (v.authMode === "keyless" || v.authMode === "apiKey") out.authMode = v.authMode;
  const baseUrl = normaliseBaseUrl(v.baseUrl);
  if (baseUrl) out.baseUrl = baseUrl;
  const models = sanitiseCustomModels(v.models);
  if (models.length > 0) out.models = models;
  const manual: string[] = [];
  if (Array.isArray(v.manualModels)) for (const m of v.manualModels) {
    const id = text(m, 256);
    if (id && !manual.includes(id)) manual.push(id);
  }
  if (manual.length > 0) out.manualModels = manual;
  const ids = new Set<string>([...models.map((m) => m.id), ...manual]);
  const overrides = sanitiseOverrides(v.overrides, ids);
  if (Object.keys(overrides).length > 0) out.overrides = overrides;
  if (v.localConfirmedAt === null) out.localConfirmedAt = null;
  else {
    const when = isoText(v.localConfirmedAt);
    if (when) out.localConfirmedAt = when;
  }
  return nonEmpty(out) as CustomProviderSettings | undefined;
}

/** Clamps, drops and keeps unknown keys. Never throws. */
export function sanitiseSettings(raw: unknown): LearnSettings {
  try {
    if (!isObj(raw)) return { version: 1 };
    const out: Obj = { ...extras(raw, ["version", "claudeCode", "models", "agent", "customProvider", "compaction", "graph", "scan"]), version: 1 };
    if (isObj(raw.claudeCode)) {
      const c = raw.claudeCode;
      const cc: Obj = extras(c, ["enabled", "enabledAt", "allowBackground", "allowBackgroundAt"]);
      const enabled = bool(c.enabled);
      if (enabled !== undefined) cc.enabled = enabled;
      const enabledAt = isoText(c.enabledAt);
      if (enabledAt) cc.enabledAt = enabledAt;
      const allow = bool(c.allowBackground);
      if (allow !== undefined) cc.allowBackground = allow;
      const allowAt = isoText(c.allowBackgroundAt);
      if (allowAt) cc.allowBackgroundAt = allowAt;
      if (nonEmpty(cc)) out.claudeCode = cc;
    }
    const models = sanitiseModels(raw.models);
    if (models) out.models = models;
    const agent = sanitiseAgent(raw.agent);
    if (agent) out.agent = agent;
    const custom = sanitiseCustom(raw.customProvider);
    if (custom) out.customProvider = custom;
    if (isObj(raw.compaction)) {
      const c: Obj = extras(raw.compaction, ["thresholdTokens"]);
      const t = whole(raw.compaction.thresholdTokens, COMPACTION_FLOOR, 100_000_000);
      if (t !== undefined) c.thresholdTokens = t;
      if (nonEmpty(c)) out.compaction = c;
    }
    if (isObj(raw.graph)) {
      const g: Obj = extras(raw.graph, ["enabled", "extractionChunkTokens"]);
      const enabled = bool(raw.graph.enabled);
      if (enabled !== undefined) g.enabled = enabled;
      const chunk = whole(raw.graph.extractionChunkTokens, CHUNK_FLOOR, 1_000_000);
      if (chunk !== undefined) g.extractionChunkTokens = chunk;
      if (nonEmpty(g)) out.graph = g;
    }
    if (isObj(raw.scan)) {
      const s: Obj = extras(raw.scan, ["intervalSeconds", "maxFilesPerPass"]);
      const interval = whole(raw.scan.intervalSeconds, 30, 86_400);
      if (interval !== undefined) s.intervalSeconds = interval;
      const files = whole(raw.scan.maxFilesPerPass, 1, 1000);
      if (files !== undefined) s.maxFilesPerPass = files;
      if (nonEmpty(s)) out.scan = s;
    }
    return out as unknown as LearnSettings;
  } catch {
    return { version: 1 };
  }
}

/** Records the time of each Claude Code switch when it turns on, and drops the time when it turns off. */
export function stampClaudeCode(previous: LearnSettings, next: LearnSettings, now: string): LearnSettings {
  const prev = previous.claudeCode ?? {};
  const cc = { ...(next.claudeCode ?? {}) };
  if (cc.enabled === true) cc.enabledAt = prev.enabled === true && prev.enabledAt ? prev.enabledAt : now;
  else delete cc.enabledAt;
  if (cc.allowBackground === true) cc.allowBackgroundAt = prev.allowBackground === true && prev.allowBackgroundAt ? prev.allowBackgroundAt : now;
  else delete cc.allowBackgroundAt;
  const out = { ...next };
  if (Object.keys(cc).length > 0) out.claudeCode = cc;
  else delete out.claudeCode;
  return out;
}

export interface SettingsStore {
  readonly file: string;
  /** The record after the sanitiser. A missing or corrupt file reads as the empty record. */
  read(): LearnSettings;
  /** Sanitises and writes the whole record, then returns what was written. */
  write(next: LearnSettings): LearnSettings;
  /** Reads, applies the change, then writes. */
  update(change: (current: LearnSettings) => LearnSettings): LearnSettings;
}

export function createSettingsStore(options: { file: string }): SettingsStore {
  const file = options.file;
  const read = (): LearnSettings => {
    try {
      return sanitiseSettings(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return { version: 1 };
    }
  };
  const write = (next: LearnSettings): LearnSettings => {
    const clean = sanitiseSettings(next);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(clean, null, "\t")}\n`);
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // already gone
      }
      throw e;
    }
    return clean;
  };
  return { file, read, write, update: (change) => write(change(read())) };
}
