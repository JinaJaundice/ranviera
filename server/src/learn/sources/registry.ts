// The registry of linked roots, cortex/sources.json (docs/CONTRACTS.md, "Cortex extension files").
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SourceRegistryFile, SourceRoot } from "../../../../shared/learn/sources.ts";
import { SourceError } from "./errors.ts";
import { isSensitivity, isSourceKind } from "./kinds.ts";
import { isObject, writeJsonAtomic } from "./store.ts";

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

export function isSourceRoot(v: unknown): v is SourceRoot {
  if (!isObject(v)) return false;
  return (
    typeof v.id === "string" &&
    /^root_[0-9a-f]{8}$/.test(v.id) &&
    isSourceKind(v.kind) &&
    typeof v.path === "string" &&
    typeof v.label === "string" &&
    strings(v.include) &&
    strings(v.exclude) &&
    isSensitivity(v.sensitivity) &&
    (v.mode === "manual" || v.mode === "scan") &&
    typeof v.enabled === "boolean" &&
    (v.hostedConsentAt === null || typeof v.hostedConsentAt === "string") &&
    typeof v.createdAt === "string" &&
    (v.lastScanAt === null || typeof v.lastScanAt === "string")
  );
}

export interface Registry {
  list(): SourceRoot[];
  get(id: string): SourceRoot | null;
  add(root: SourceRoot): void;
  update(id: string, patch: Partial<SourceRoot>): SourceRoot | null;
  remove(id: string): SourceRoot | null;
  newId(): string;
}

export function createRegistry(opts: { file: string }): Registry {
  function read(): SourceRegistryFile {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(opts.file, "utf8"));
    } catch {
      return { version: 1, roots: {} };
    }
    if (!isObject(raw)) return { version: 1, roots: {} };
    if (typeof raw.version === "number" && raw.version > 1) {
      throw new SourceError(503, "format_newer", "The registry of linked sources was written by a newer build. Update this app before changing sources.", { found: raw.version, supported: 1 });
    }
    const roots: Record<string, SourceRoot> = {};
    if (isObject(raw.roots)) for (const [id, r] of Object.entries(raw.roots)) if (isSourceRoot(r) && r.id === id) roots[id] = r;
    return { version: 1, roots };
  }
  const write = (f: SourceRegistryFile) => writeJsonAtomic(opts.file, f);

  return {
    list: () => Object.values(read().roots).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    get: (id) => read().roots[id] ?? null,
    add(root) {
      const f = read();
      f.roots[root.id] = root;
      write(f);
    },
    update(id, patch) {
      const f = read();
      const cur = f.roots[id];
      if (!cur) return null;
      const next = { ...cur, ...patch, id };
      f.roots[id] = next;
      write(f);
      return next;
    },
    remove(id) {
      const f = read();
      const cur = f.roots[id];
      if (!cur) return null;
      delete f.roots[id];
      write(f);
      return cur;
    },
    newId() {
      const known = read().roots;
      for (;;) {
        const id = `root_${crypto.randomBytes(4).toString("hex")}`;
        if (!known[id]) return id;
      }
    },
  };
}

export const registryFile = (learnDir: string) => path.join(learnDir, "cortex", "sources.json");
