// Small file store of the learning folder: strict ledger reads, appends,
// rewrites through a temporary file and a rename, archiving of removed lines,
// and the writer lock. docs/CONTRACTS.md, "Folder layout" and "Writer lock".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeError } from "./errors.ts";
import { checkFormat, stampFormat } from "./format.ts";

export interface StoreOptions {
  learnDir: string;
  now?: () => Date;
  pid?: number;
  host?: string;
  /** Tells whether a process exists. Tests replace it. */
  isAlive?: (pid: number) => boolean;
  log?: (message: string) => void;
}

export interface WriterLock {
  pid: number;
  host: string;
  since: string;
}

/** The graph files whose newest modification time is the graph revision. */
const REVISION_FILES = ["nodes.jsonl", "chains.jsonl", "sessions.jsonl", "coverage.jsonl", "positions.json"];

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const BUSY_TEXT = "Another application is writing the learning folder. Close it and then try again.";

export class KnowledgeStore {
  readonly learnDir: string;
  readonly graphDir: string;
  readonly cortexDir: string;
  readonly archiveRoot: string;
  readonly now: () => Date;
  private readonly pid: number;
  private readonly host: string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly log: (message: string) => void;
  /** The guard of the latest strict read of each ledger, so that a rewrite can tell the lines the caller never saw. */
  private readonly guards = new Map<string, (v: unknown) => boolean>();

  constructor(o: StoreOptions) {
    this.learnDir = o.learnDir;
    this.graphDir = path.join(o.learnDir, "graph");
    this.cortexDir = path.join(o.learnDir, "cortex");
    this.archiveRoot = path.join(o.learnDir, "archive");
    this.now = o.now ?? (() => new Date());
    this.pid = o.pid ?? process.pid;
    this.host = o.host ?? os.hostname();
    this.isAlive = o.isAlive ?? processAlive;
    this.log = o.log ?? (() => undefined);
  }

  graphFile(name: string): string {
    return path.join(this.graphDir, name);
  }

  cortexFile(name: string): string {
    return path.join(this.cortexDir, name);
  }

  /** Refuses every graph read when the stamp is newer than the build. */
  assertReadable(): void {
    checkFormat(this.graphDir);
  }

  /** The checks of a write: the stamp, and no live writer other than this process. */
  assertWritable(): void {
    this.assertReadable();
    const lock = this.readLock();
    if (lock && lock.pid !== this.pid && this.isAlive(lock.pid)) {
      throw new KnowledgeError(409, "busy", BUSY_TEXT);
    }
  }

  private lockFile(): string {
    return this.cortexFile("writer.lock");
  }

  readLock(): WriterLock | null {
    try {
      const v: unknown = JSON.parse(fs.readFileSync(this.lockFile(), "utf8"));
      if (v && typeof v === "object") {
        const l = v as Partial<WriterLock>;
        if (typeof l.pid === "number" && typeof l.host === "string" && typeof l.since === "string") {
          return { pid: l.pid, host: l.host, since: l.since };
        }
      }
    } catch {
      // absent or broken, which reads as no lock
    }
    return null;
  }

  /** Takes the lock. A lock of a live process refuses, and a lock of a dead one is replaced and logged. */
  acquireLock(): void {
    const existing = this.readLock();
    if (existing && existing.pid !== this.pid) {
      if (this.isAlive(existing.pid)) throw new KnowledgeError(409, "busy", BUSY_TEXT);
      this.log(`Replaced the stale writer lock of process ${existing.pid} on ${existing.host}.`);
    }
    const lock: WriterLock = { pid: this.pid, host: this.host, since: this.now().toISOString() };
    this.writeJson(this.lockFile(), lock);
  }

  releaseLock(): void {
    const existing = this.readLock();
    if (existing && existing.pid === this.pid) fs.rmSync(this.lockFile(), { force: true });
  }

  /** Atomic JSON write with tab indentation. */
  writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${this.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`);
    fs.renameSync(tmp, file);
  }

  /** Writes a JSON file of the graph folder. The first write of any graph file creates the format stamp. */
  writeGraphJson(name: string, value: unknown): void {
    this.assertWritable();
    stampFormat(this.graphDir);
    this.writeJson(this.graphFile(name), value);
  }

  readJson<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  }

  /** Strict read: a line with bad JSON or the wrong shape is skipped and never repaired. */
  readLedger<T>(file: string, guard: (v: unknown) => v is T): T[] {
    this.guards.set(file, guard);
    return this.readRaw(file).items.filter(guard);
  }

  /** Lines that parse, with their raw text, and the raw text of the lines that do not. */
  private readRaw(file: string): { items: unknown[]; raws: string[]; invalid: string[] } {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return { items: [], raws: [], invalid: [] };
    }
    const items: unknown[] = [];
    const raws: string[] = [];
    const invalid: string[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line.trim()) continue;
      try {
        items.push(JSON.parse(line));
        raws.push(line);
      } catch {
        invalid.push(line);
      }
    }
    return { items, raws, invalid };
  }

  /** Appends one object per line. A torn last line is closed first, so that the new line stays whole. */
  appendLines(file: string, lines: unknown[]): void {
    if (lines.length === 0) return;
    this.assertWritable();
    stampFormat(this.graphDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let prefix = "";
    try {
      const fd = fs.openSync(file, "r");
      try {
        const size = fs.fstatSync(fd).size;
        if (size > 0) {
          const last = Buffer.alloc(1);
          fs.readSync(fd, last, 0, 1, size - 1);
          if (last[0] !== 0x0a) prefix = "\n";
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // the file does not exist yet
    }
    fs.appendFileSync(file, prefix + lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  /**
   * Rewrites a ledger through a temporary file and a rename. Lines that never parsed stay, at the end, and so do
   * lines that parse but fail the guard of the latest strict read, because the caller never held them and so cannot
   * have meant to remove them. A caller that wants the rule for another guard passes it.
   */
  rewriteLedger(file: string, lines: unknown[], guard?: (v: unknown) => boolean): void {
    this.assertWritable();
    stampFormat(this.graphDir);
    const { items, raws, invalid } = this.readRaw(file);
    const g = guard ?? this.guards.get(file);
    const odd = g ? raws.filter((_r, i) => !g(items[i])) : [];
    const body = [...lines.map((l) => JSON.stringify(l)), ...odd, ...invalid];
    const tmp = `${file}.${this.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, body.length ? `${body.join("\n")}\n` : "");
    fs.renameSync(tmp, file);
  }

  /** Archives lines to archive/<date>/<name>.jsonl before they leave a ledger. */
  archive(name: string, lines: unknown[]): void {
    if (lines.length === 0) return;
    const dir = path.join(this.archiveRoot, this.now().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  /** The newest modification time, in milliseconds, of the graph files. Zero when none exists. */
  revision(): number {
    let newest = 0;
    for (const name of REVISION_FILES) {
      try {
        newest = Math.max(newest, Math.floor(fs.statSync(this.graphFile(name)).mtimeMs));
      } catch {
        // an absent file adds nothing
      }
    }
    return newest;
  }
}
