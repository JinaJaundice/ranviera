// Session records in <learn_dir>/chats/<id>.json, as CONTRACTS "Session record"
// states. A corrupt or unreadable file reads as absent, a list skips it, a
// record stamped newer than this build is refused and never rewritten, and
// every write goes through a temporary file and a rename.
import fs from "node:fs";
import path from "node:path";
import type { ExtractionRunUsage, NativeMessage, PlanTree, SessionRecord, TurnUsage } from "../../../../shared/learn/index.ts";
import { RuntimeError, badRequest } from "./errors.ts";
import { isSafeId, newSessionId } from "./ids.ts";

export const DEFAULT_TITLE = "Untitled session";
export const FORMAT_VERSION = 1;

export interface SessionStore {
  create(init: { title?: string; kind?: "teach" | "practice"; settings?: SessionRecord["settings"]; messages?: NativeMessage[] }): SessionRecord;
  get(id: string): SessionRecord | null;
  list(): SessionRecord[];
  /** Adds messages and bumps updatedAt. */
  appendMessages(id: string, messages: NativeMessage[]): SessionRecord;
  /** Renames without bumping updatedAt. */
  rename(id: string, title: string): SessionRecord;
  setTree(id: string, tree: PlanTree): SessionRecord;
  /** Replaces the settings as a whole, without bumping updatedAt. */
  setSettings(id: string, settings: SessionRecord["settings"]): SessionRecord;
  /** Idempotent for each turn id. */
  appendTurnUsage(id: string, usage: TurnUsage): SessionRecord;
  /** Idempotent for each startedAt. */
  appendExtractionUsage(id: string, run: ExtractionRunUsage): SessionRecord;
  /** Moves the file to archive/<date>/chats/ and returns the new place. Nothing is deleted. */
  archive(id: string): string | null;
}

export interface StoreOptions {
  learnDir: string;
  now?: () => number;
}

function titleOrDefault(title: unknown): string {
  return typeof title === "string" && title.trim() ? title.trim() : DEFAULT_TITLE;
}

/** A title from the first words of a prompt: whitespace collapsed and cut at a word boundary under the cap. */
export function titleFromPrompt(text: string, cap = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return DEFAULT_TITLE;
  if (flat.length <= cap) return flat;
  const cut = flat.slice(0, cap);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd();
}

export function createSessionStore(options: StoreOptions): SessionStore {
  const now = options.now ?? Date.now;
  const dir = path.join(options.learnDir, "chats");
  const fileOf = (id: string) => path.join(dir, `${id}.json`);

  function parse(id: string, raw: string): SessionRecord | null {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!value || typeof value !== "object") return null;
    const r = value as Partial<SessionRecord>;
    if (r.id !== id || typeof r.createdAt !== "string" || !Array.isArray(r.messages)) return null;
    if (typeof r.version === "number" && r.version > FORMAT_VERSION) {
      throw new RuntimeError(503, "This session was saved by a newer version of the application. Update the application to open it.", "format_newer", {
        found: r.version,
        supported: FORMAT_VERSION,
      });
    }
    return { ...r, title: titleOrDefault(r.title), updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : r.createdAt } as SessionRecord;
  }

  function read(id: string): SessionRecord | null {
    if (!isSafeId(id)) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(fileOf(id), "utf8");
    } catch {
      return null;
    }
    return parse(id, raw);
  }

  function write(record: SessionRecord): void {
    fs.mkdirSync(dir, { recursive: true });
    const stamped: SessionRecord = { ...record, version: 1 };
    const file = fileOf(record.id);
    const tmp = `${file}.${process.pid}.${now().toString(36)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stamped, null, "\t"), "utf8");
    fs.renameSync(tmp, file);
  }

  function mutate(id: string, change: (r: SessionRecord) => SessionRecord): SessionRecord {
    const current = read(id);
    if (!current) throw new RuntimeError(404, "That session does not exist.", "not_found");
    const next = change(current);
    write(next);
    return next;
  }

  return {
    create(init) {
      const at = new Date(now()).toISOString();
      const record: SessionRecord = {
        id: newSessionId(now()),
        title: titleOrDefault(init.title),
        createdAt: at,
        updatedAt: at,
        version: 1,
        messages: init.messages ?? [],
        ...(init.kind === "practice" ? { kind: "practice" as const } : {}),
        ...(init.settings && (init.settings.model || init.settings.thinkingLevel) ? { settings: init.settings } : {}),
      };
      write(record);
      return record;
    },
    get: read,
    list() {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return [];
      }
      const out: SessionRecord[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          const record = read(name.slice(0, -5));
          if (record) out.push(record);
        } catch {
          // a record from a newer build is skipped and never rewritten
        }
      }
      return out;
    },
    appendMessages(id, messages) {
      return mutate(id, (r) => ({ ...r, messages: [...r.messages, ...messages], updatedAt: new Date(now()).toISOString() }));
    },
    rename(id, title) {
      return mutate(id, (r) => ({ ...r, title: titleOrDefault(title) }));
    },
    setTree(id, tree) {
      return mutate(id, (r) => ({ ...r, tree }));
    },
    setSettings(id, settings) {
      return mutate(id, (r) => {
        const next: SessionRecord = { ...r };
        delete next.settings;
        return settings && (settings.model || settings.thinkingLevel) ? { ...next, settings } : next;
      });
    },
    appendTurnUsage(id, usage) {
      return mutate(id, (r) => {
        const turns = r.turns ?? [];
        if (turns.some((t) => t.id === usage.id)) return r;
        return { ...r, turns: [...turns, usage] };
      });
    },
    appendExtractionUsage(id, run) {
      return mutate(id, (r) => {
        const extractions = r.extractions ?? [];
        if (extractions.some((e) => e.startedAt === run.startedAt)) return r;
        return { ...r, extractions: [...extractions, run] };
      });
    },
    archive(id) {
      if (!isSafeId(id)) throw badRequest("The session identifier is not valid.");
      const from = fileOf(id);
      if (!fs.existsSync(from)) return null;
      const day = new Date(now()).toISOString().slice(0, 10);
      const to = path.join(options.learnDir, "archive", day, "chats", `${id}.json`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      const target = fs.existsSync(to) ? `${to}.${now().toString(36)}` : to;
      fs.renameSync(from, target);
      return target;
    },
  };
}
