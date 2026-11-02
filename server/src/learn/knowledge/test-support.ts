// Helpers shared by the tests of the knowledge core. Tests write only to
// temporary folders and never to the real data folder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import type { ChainLine, NodeLine, ProvenancePoint } from "../../../../shared/learn/knowledge.ts";
import { createKnowledge, type Knowledge, type KnowledgeOptions } from "./index.ts";

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../kg/tests/fixtures/knowledge");
export const NOW = new Date("2026-11-01T09:00:00.000Z");

const dirs: string[] = [];

/** Registers the cleanup of the temporary folders. Call once at the top of a test file. */
export function cleanupTempDirs(): void {
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
}

export function tempDir(prefix = "cortex-know-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Copies a fixture case into a temporary learning folder. */
export function fixtureCopy(name: string): string {
  const dir = tempDir();
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

export function fixtureJson<T>(name: string, file: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name, file), "utf8")) as T;
}

export function open(learnDir: string, extra: Partial<KnowledgeOptions> = {}): Knowledge {
  return createKnowledge({ learnDir, now: () => NOW, pid: 4242, host: "test-host", isAlive: () => false, ...extra });
}

export function read(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

export function write(dir: string, rel: string, text: string): void {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

export function lines(items: unknown[]): string {
  return items.map((i) => JSON.stringify(i)).join("\n") + "\n";
}

export const prov = (chatId: string, messageId = ""): ProvenancePoint => ({ chatId, messageId });

export function node(id: string, name: string, statement: string, provenance: ProvenancePoint[] = [], aliases: string[] = [], createdAt = "2026-10-01T10:00:00.000Z"): NodeLine {
  return { id, name, statement, aliases, createdAt, provenance };
}

export function chain(id: string, premises: string[], conclusion: string, provenance: ProvenancePoint[] = [], createdAt = "2026-10-01T10:00:00.000Z"): ChainLine {
  return { id, premises, conclusion, createdAt, provenance };
}

/** A small deterministic generator for property tests. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}
