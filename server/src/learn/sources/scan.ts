// The scan of a linked root (docs/CONTRACTS.md, "Cortex extension files"). A scan is a read. It walks the root, applies the globs and
// the rules of the kind, follows no symlink, ignores hidden system files, hashes each eligible file and appends one line to
// cortex/files.jsonl for each file whose state changed. A scan makes no model call and never changes a file under the root.
import fs from "node:fs";
import path from "node:path";
import type { SourceRecord } from "../../../../shared/learn/knowledge.ts";
import type { FileRecord, ScanResult, SkipReason, SourceRoot } from "../../../../shared/learn/sources.ts";
import { badRequest, tooLarge } from "./errors.ts";
import type { CoverageReader, FileStore } from "./files.ts";
import { compileGlobs, couldMatchBelow } from "./glob.ts";
import { effectiveGlobs } from "./kinds.ts";
import type { AppendLedger } from "./ledger.ts";
import { isSystemJunk, validRelativePath, type DenyList } from "./paths.ts";
import type { TranscriptMessage } from "./readers/claude-transcripts.ts";
import { inspectFile, type Limits } from "./readers/index.ts";
import { deriveSourceId } from "./readers/learnharness.ts";

export interface Entry {
  rel: string;
  abs: string;
  symlink: boolean;
}

/** Walks a root and returns the files that the globs select, in path order. Throws too_large beyond maxFiles. */
export function walkRoot(root: SourceRoot, deny: DenyList, maxFiles: number): Entry[] {
  const st = fs.lstatSync(root.path);
  if (st.isFile()) return [{ rel: path.posix.basename(root.path), abs: root.path, symlink: false }];
  const globs = effectiveGlobs(root);
  const included = compileGlobs(globs.include, { ignoreCase: true });
  const excluded = compileGlobs(globs.exclude, { ignoreCase: true });
  const out: Entry[] = [];
  const stack = [""];
  while (stack.length) {
    const dirRel = stack.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dirRel ? path.posix.join(root.path, dirRel) : root.path, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const d of dirents) {
      if (isSystemJunk(d.name)) continue;
      const rel = dirRel ? `${dirRel}/${d.name}` : d.name;
      const abs = path.posix.join(root.path, rel);
      if (d.isSymbolicLink()) {
        if (included(rel) && !excluded(rel)) out.push({ rel, abs, symlink: true });
      } else if (d.isDirectory()) {
        if (deny.isDenied(abs) || excluded(`${rel}/_`)) continue;
        if (!globs.include.some((p) => couldMatchBelow(p, rel))) continue;
        stack.push(rel);
      } else if (d.isFile()) {
        if (!included(rel) || excluded(rel)) continue;
        out.push({ rel, abs, symlink: false });
        if (out.length > maxFiles) throw tooLarge(`The root holds more than ${maxFiles} files, so the scan stopped. Narrow the include globs or link a smaller folder.`);
      }
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

interface Observed {
  entry: Entry;
  /** true when size and modification time match the last record, so the file was not read again */
  reused: boolean;
  refusal: SkipReason | null;
  sha256: string;
  bytes: number;
  mtimeMs: number;
  pages?: number;
  uncoveredTokens?: number;
  messages?: TranscriptMessage[];
}

export interface ScanDeps {
  files: FileStore;
  deny: DenyList;
  limits: Limits;
  appendLedger: AppendLedger;
  coverage: CoverageReader;
  now: () => Date;
}

export interface ScanOutcome {
  result: ScanResult;
  /** paths of the files that wait for extraction, at most maxQueue of them */
  queue: string[];
}

export function createScanner(deps: ScanDeps) {
  async function observe(root: SourceRoot, entry: Entry, prev: FileRecord | undefined): Promise<Observed | null> {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(entry.abs);
    } catch {
      return null;
    }
    const base = { entry, reused: false, sha256: "", bytes: st.size, mtimeMs: st.mtimeMs };
    if (!validRelativePath(entry.rel)) return { ...base, refusal: "unsupported" };
    if (deps.deny.isDenied(entry.abs)) return { ...base, refusal: "forbidden_path" };
    if (entry.symlink || st.isSymbolicLink()) return { ...base, refusal: "symlink" };
    if (prev && prev.state !== "missing" && prev.bytes === st.size && prev.mtimeMs === st.mtimeMs) {
      return { ...base, reused: true, refusal: prev.state === "refused" ? (prev.reason ?? "unreadable") : null, sha256: prev.sha256, pages: prev.pages, uncoveredTokens: prev.uncoveredTokens };
    }
    const insp = await inspectFile(root.kind, entry.abs, st.size, deps.limits);
    if (!insp.ok) return { ...base, bytes: insp.bytes, refusal: insp.reason };
    // The coverage of a transcript is read once its source id is known, so the messages travel with the observation.
    return { ...base, bytes: insp.bytes, refusal: null, sha256: insp.sha256, pages: insp.pages, messages: insp.messages };
  }

  /** Scans a root and appends the changed lines. Pass the files per pass of the settings as maxQueue. */
  async function scanRoot(root: SourceRoot, opts: { maxQueue?: number } = {}): Promise<ScanOutcome> {
    const started = deps.now().toISOString();
    if (!root.enabled) throw badRequest("This root is switched off. Switch it on before a scan.");
    let rootStat: fs.Stats;
    try {
      rootStat = fs.lstatSync(root.path);
    } catch {
      throw badRequest("The folder of this root cannot be found. Check that the drive is connected.");
    }
    if (rootStat.isSymbolicLink() || deps.deny.isDeniedReal(root.path)) throw badRequest("The folder of this root is no longer available.");

    const entries = walkRoot(root, deps.deny, deps.limits.maxFiles);
    const known = deps.files.forRoot(root.id);
    const byPath = new Map(known.map((r) => [r.path, r]));
    const everyId = new Set(deps.files.all().keys());

    const observed: Observed[] = [];
    for (const e of entries) {
      const o = await observe(root, e, byPath.get(e.rel));
      if (o) observed.push(o);
    }
    const present = new Set(observed.map((o) => o.entry.rel));
    const claimed = new Set<string>();
    const gone = known.filter((r) => !present.has(r.path) && r.state !== "missing");
    const lines: FileRecord[] = [];
    const sources: SourceRecord[] = [];
    const files: ScanResult["files"] = [];
    const counts = { new: 0, changed: 0, unchanged: 0, moved: 0, missing: 0, refused: 0 };

    const stateOf = (r: Pick<FileRecord, "sha256" | "lastExtractedSha256" | "uncoveredTokens">, transcript: boolean): "pending" | "current" =>
      transcript ? ((r.uncoveredTokens ?? 0) > 0 ? "pending" : "current") : r.lastExtractedSha256 === r.sha256 ? "current" : "pending";
    const newId = (rel: string): string => {
      let id = deriveSourceId(root.id, rel);
      for (let n = 1; everyId.has(id); n++) id = deriveSourceId(root.id, rel, `#${n}`);
      everyId.add(id);
      return id;
    };
    // In a learnharness root only the sessions are sources. The ledger files are read by the import.
    const addSource = (id: string, rel: string, at: string) => {
      if (root.kind === "learnharness" && !rel.startsWith("chats/")) return;
      sources.push({ id, filePath: `${root.label}/${rel}`, importedAt: at } satisfies SourceRecord);
    };
    const transcript = root.kind === "claude-transcripts";

    for (const o of observed) {
      const rel = o.entry.rel;
      const prev = byPath.get(rel);
      const refused = o.refusal !== null;
      if (refused) counts.refused++;
      const fill = (sourceId: string, from: FileRecord | undefined, extra: Partial<FileRecord>): FileRecord => {
        const uncovered = !refused && transcript ? deps.coverage(sourceId, o.messages ?? []) : o.uncoveredTokens;
        const rec: FileRecord = {
          sourceId,
          rootId: root.id,
          path: rel,
          sha256: o.sha256,
          bytes: o.bytes,
          mtimeMs: o.mtimeMs,
          state: "pending",
          firstSeenAt: from?.firstSeenAt ?? started,
          lastSeenAt: started,
          lastExtractedAt: from?.lastExtractedAt ?? null,
          lastExtractedSha256: from?.lastExtractedSha256 ?? null,
          outcome: from?.outcome ?? null,
          ...(from?.stats ? { stats: from.stats } : {}),
          ...(from?.chunks !== undefined ? { chunks: from.chunks } : {}),
          ...(from?.notice ? { notice: from.notice } : {}),
          ...(o.pages !== undefined ? { pages: o.pages } : from?.pages !== undefined ? { pages: from.pages } : {}),
          ...(from?.imagePages !== undefined ? { imagePages: from.imagePages } : {}),
          ...(uncovered !== undefined ? { uncoveredTokens: uncovered } : {}),
          ...extra,
        };
        if (refused) {
          rec.state = "refused";
          rec.reason = o.refusal!;
        } else {
          rec.state = stateOf(rec, transcript);
        }
        return rec;
      };

      if (prev) {
        if (o.reused) {
          counts.unchanged++;
          files.push({ path: rel, sourceId: prev.sourceId, change: "unchanged", state: prev.state, ...(prev.reason ? { reason: prev.reason } : {}) });
          continue;
        }
        const next = fill(prev.sourceId, prev, {});
        const same = prev.state !== "missing" && prev.sha256 === next.sha256 && prev.state === next.state && prev.reason === next.reason && prev.uncoveredTokens === next.uncoveredTokens && prev.bytes === next.bytes;
        if (same) {
          counts.unchanged++;
          files.push({ path: rel, sourceId: prev.sourceId, change: "unchanged", state: prev.state, ...(prev.reason ? { reason: prev.reason } : {}) });
          continue;
        }
        counts.changed++;
        lines.push(next);
        if (!refused) addSource(prev.sourceId, rel, prev.firstSeenAt);
        files.push({ path: rel, sourceId: prev.sourceId, change: "changed", state: next.state, ...(next.reason ? { reason: next.reason } : {}) });
        continue;
      }

      // A path that no record names. A hash that equals the hash of a vanished file means the file moved.
      const from = refused ? undefined : gone.find((g) => !claimed.has(g.sourceId) && g.state !== "refused" && g.sha256 === o.sha256);
      if (from) {
        claimed.add(from.sourceId);
        const next = fill(from.sourceId, from, { previousPath: from.path });
        counts.moved++;
        lines.push(next);
        addSource(from.sourceId, rel, from.firstSeenAt);
        files.push({ path: rel, sourceId: from.sourceId, change: "moved", state: next.state });
        continue;
      }
      const id = newId(rel);
      const next = fill(id, undefined, {});
      counts.new++;
      lines.push(next);
      if (!refused) addSource(id, rel, started);
      files.push({ path: rel, sourceId: id, change: "new", state: next.state, ...(next.reason ? { reason: next.reason } : {}) });
    }

    for (const g of gone) {
      if (claimed.has(g.sourceId)) continue;
      counts.missing++;
      lines.push({ ...g, state: "missing", lastSeenAt: g.lastSeenAt });
      files.push({ path: g.path, sourceId: g.sourceId, change: "missing", state: "missing" });
    }

    await deps.appendLedger("sources", sources);
    deps.files.append(lines);

    const waiting = deps.files
      .forRoot(root.id)
      .filter((r) => r.state === "pending" && (r.outcome === null || r.outcome === "busy" || r.outcome === "completed"))
      .map((r) => r.path);
    return { result: { rootId: root.id, startedAt: started, files, counts }, queue: waiting.slice(0, opts.maxQueue ?? waiting.length) };
  }

  return { scanRoot };
}
