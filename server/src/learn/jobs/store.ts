// The job store: <learn_dir>/jobs/<id>.json, one file for each job. A write merges a patch and bumps updatedAt unless
// the patch supplies it. Every write and every removal announces jobs-changed with the session identifier, and a
// read announces nothing. A corrupt or unreadable file reads as absent.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JobKind, JobRecord } from "../../../../shared/learn/index.ts";
import type { Emit } from "../runtime/deps.ts";
import { isSafeId } from "../runtime/ids.ts";

export interface JobStore {
  create(init: { chatId: string; kind: JobKind; toolCallId: string; input: Record<string, unknown> }): JobRecord;
  get(id: string): JobRecord | null;
  /** Merges a patch. Returns null when the job does not exist. */
  update(id: string, patch: Partial<Omit<JobRecord, "id" | "chatId">>): JobRecord | null;
  list(chatId?: string): JobRecord[];
  findByCall(chatId: string, toolCallId: string): JobRecord | null;
  /** Moves the job files of a session to the archive folder and returns how many moved. */
  removeForChat(chatId: string): number;
}

const eight = () => randomUUID().replace(/-/g, "").slice(0, 8);

/** A job identifier is job_ then the time in base 36 then 8 characters of a UUID. */
export const newJobId = (now = Date.now()): string => `job_${now.toString(36)}${eight()}`;

export function createJobStore(options: { learnDir: string; emit: Emit; now?: () => number }): JobStore {
  const now = options.now ?? Date.now;
  const dir = path.join(options.learnDir, "jobs");
  const fileOf = (id: string) => path.join(dir, `${id}.json`);

  function read(id: string): JobRecord | null {
    if (!isSafeId(id)) return null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(fileOf(id), "utf8"));
      if (parsed && typeof parsed === "object" && (parsed as JobRecord).id === id) return parsed as JobRecord;
    } catch {
      // an absent or corrupt file reads as no job
    }
    return null;
  }

  function write(record: JobRecord): void {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${fileOf(record.id)}.${process.pid}.${eight()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(tmp, fileOf(record.id));
  }

  const announce = (chatId: string) => options.emit({ type: "learn", event: "jobs-changed", session: chatId });

  function all(): JobRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: JobRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = read(name.slice(0, -5));
      if (record) out.push(record);
    }
    return out;
  }

  return {
    create(init) {
      const at = new Date(now()).toISOString();
      const record: JobRecord = {
        id: newJobId(now()),
        kind: init.kind,
        chatId: init.chatId,
        toolCallId: init.toolCallId,
        input: init.input,
        status: "running",
        activity: "starting",
        createdAt: at,
        updatedAt: at,
      };
      write(record);
      announce(record.chatId);
      return record;
    },
    get: read,
    update(id, patch) {
      const current = read(id);
      if (!current) return null;
      const next: JobRecord = { ...current, ...patch, id: current.id, chatId: current.chatId };
      if (patch.updatedAt === undefined) next.updatedAt = new Date(now()).toISOString();
      write(next);
      announce(next.chatId);
      return next;
    },
    list: (chatId) =>
      all()
        .filter((j) => chatId === undefined || j.chatId === chatId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    findByCall(chatId, toolCallId) {
      const hits = all().filter((j) => j.chatId === chatId && j.toolCallId === toolCallId);
      hits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return hits[0] ?? null;
    },
    removeForChat(chatId) {
      const mine = all().filter((j) => j.chatId === chatId);
      if (!mine.length) return 0;
      const day = new Date(now()).toISOString().slice(0, 10);
      const archive = path.join(options.learnDir, "archive", day, "jobs");
      fs.mkdirSync(archive, { recursive: true });
      for (const j of mine) fs.renameSync(fileOf(j.id), path.join(archive, `${j.id}.json`));
      announce(chatId);
      return mine.length;
    },
  };
}
