// cortex/writer.lock of CONTRACTS "Writer lock": one writer for a learning folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WriterLock } from "../../../../shared/learn/index.ts";

export interface LockResult {
  acquired: boolean;
  /** true when the lock of a process that no longer exists was replaced */
  replaced: boolean;
  holder?: WriterLock;
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function lockFile(learnDir: string): string {
  return path.join(learnDir, "cortex", "writer.lock");
}

/** Takes the lock unless a live process of another owner holds it. A stale lock is replaced. */
export function acquireWriterLock(learnDir: string, log: (line: string) => void = () => {}, now: () => Date = () => new Date()): LockResult {
  const file = lockFile(learnDir);
  let replaced = false;
  try {
    const held = JSON.parse(fs.readFileSync(file, "utf8")) as WriterLock;
    if (held.pid !== process.pid && alive(held.pid)) return { acquired: false, replaced: false, holder: held };
    replaced = held.pid !== process.pid;
    if (replaced) log(`Replaced the writer lock of process ${held.pid}, which no longer exists.`);
  } catch {
    // no lock, or an unreadable one
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock: WriterLock = { pid: process.pid, host: os.hostname(), since: now().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, "\t"), "utf8");
  fs.renameSync(tmp, file);
  return { acquired: true, replaced };
}

/** Removes the lock when this process holds it. */
export function releaseWriterLock(learnDir: string): void {
  const file = lockFile(learnDir);
  try {
    const held = JSON.parse(fs.readFileSync(file, "utf8")) as WriterLock;
    if (held.pid === process.pid) fs.rmSync(file, { force: true });
  } catch {
    // nothing to release
  }
}
