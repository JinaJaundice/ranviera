// The file tools read, ls, find and grep of CONTRACTS "File tools". They are
// read only by construction: no process is started and no write call is used.
// A model of the class claude-code or local reaches the home folder, a hosted
// model reaches only the linked roots that the gate allows, and the deny list
// always applies. A tool never throws into the loop and returns an error string.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { Type } from "typebox";
import { defineTool, type AnyTool } from "./define.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ProviderClass } from "../../../../../shared/learn/index.ts";
import type { PathPolicy } from "../deps.ts";
import { FILE_LABEL, wrapUntrusted } from "../../untrusted.ts";
import { MAX_IMAGE_FILE_BYTES, processImage, SNIFF_BYTES, sniffImageType, type ResizeOptions } from "../../images/index.ts";

export const OUTPUT_LIMIT_BYTES = 50 * 1024;
export const READ_LINE_LIMIT = 2000;
export const LS_LIMIT = 500;
export const FIND_LIMIT = 1000;
export const GREP_LIMIT = 100;
/** A text file over this size is refused by read, so that one call cannot fill the memory of the server. */
export const READ_FILE_LIMIT_BYTES = 10 * 1024 * 1024;
export const GREP_FILE_LIMIT_BYTES = 2 * 1024 * 1024;
export const GREP_LINE_LIMIT = 500;
export const WALK_DEADLINE_MS = 10_000;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "Library", ".Trash"]);
const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export interface FileToolDeps {
  providerClass: ProviderClass;
  policy: PathPolicy;
  /** defaults to the home folder of the operating system */
  homeDir?: string;
  /** whether the session model takes images */
  imageInput?: boolean;
  /** the resize limits of the session model. Absent fields take the defaults of the image pipeline. */
  imageLimits?: ResizeOptions;
  now?: () => number;
  walkDeadlineMs?: number;
}

type Resolved = { ok: true; abs: string } | { ok: false; message: string };

const SHORT_NAME = /~\d+(?:\.[^.]*)?$/;
const NOT_AVAILABLE = "That path is not available.";
const fwd = (p: string) => p.replace(/\\/g, "/");

function lexicallyUnder(file: string, root: string): boolean {
  const f = fwd(path.resolve(file));
  const r = fwd(path.resolve(root)).replace(/\/+$/, "");
  const fl = process.platform === "win32" ? f.toLowerCase() : f;
  const rl = process.platform === "win32" ? r.toLowerCase() : r;
  return fl === rl || fl.startsWith(rl + "/");
}

// The native call expands Windows 8.3 short names, which the JavaScript call leaves as they are.
function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Resolves a path argument by the scope of the model. The deny list is applied last. */
export function resolveToolPath(raw: string | undefined, deps: FileToolDeps): Resolved {
  const home = deps.homeDir ?? os.homedir();
  const text = (raw ?? "").trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(text)) return { ok: false, message: "The path holds a control character." };
  const expanded = text === "~" ? home : text.startsWith("~/") || text.startsWith("~\\") ? path.join(home, text.slice(2)) : text;
  const isAbs = path.isAbsolute(expanded) && text !== "";
  // A short name such as SSH~1 is refused outright, because it can name a protected folder that the text of a deny rule misses.
  if (expanded.split(/[\\/]/).some((s) => SHORT_NAME.test(s))) return { ok: false, message: NOT_AVAILABLE };
  let abs: string;
  if (deps.providerClass !== "hosted") {
    abs = text === "" ? home : isAbs ? path.resolve(expanded) : path.resolve(home, expanded);
  } else {
    const roots = deps.policy.allowedRoots("hosted");
    if (roots.length === 0) return { ok: false, message: "No linked source is available to this model, so no file can be read." };
    if (text !== "" && !isAbs && !text.startsWith("~")) {
      if (roots.length > 1) {
        const list = roots.map((r) => `${r.label}: ${r.path}`).join("\n");
        return { ok: false, message: `Several linked sources are available. Give an absolute path inside one of them:\n${list}` };
      }
      abs = path.resolve(roots[0].path, expanded);
    } else {
      abs = text === "" ? path.resolve(roots.length === 1 ? roots[0].path : "") : path.resolve(expanded);
      if (text === "" && roots.length > 1) {
        const list = roots.map((r) => `${r.label}: ${r.path}`).join("\n");
        return { ok: false, message: `Several linked sources are available. Give an absolute path inside one of them:\n${list}` };
      }
    }
    const real = realOrSelf(abs);
    const inside = roots.some((r) => lexicallyUnder(abs, r.path) && lexicallyUnder(real, realOrSelf(r.path)));
    if (!inside) {
      const list = roots.map((r) => `${r.label}: ${r.path}`).join("\n");
      return { ok: false, message: `That path is outside the linked sources that this model may read. The available sources are:\n${list}` };
    }
  }
  if (deps.policy.isDenied(abs) || deps.policy.isDenied(realOrSelf(abs))) return { ok: false, message: NOT_AVAILABLE };
  return { ok: true, abs };
}

/** Cuts text on whole lines at the byte limit. */
export function cutLines(text: string, maxBytes = OUTPUT_LIMIT_BYTES): { text: string; cut: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, cut: false };
  const lines = text.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const add = Buffer.byteLength(line) + 1;
    if (size + add > maxBytes) break;
    kept.push(line);
    size += add;
  }
  return { text: kept.join("\n"), cut: true };
}

function braceExpand(pattern: string): string[] {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  return m[1].split(",").map((alt) => pattern.slice(0, m.index) + alt + pattern.slice(m.index + m[0].length));
}

function globToRegex(glob: string): RegExp {
  let out = "";
  const chars = [...glob];
  let pos = 0;
  while (pos < chars.length) {
    const ch = chars[pos++];
    if (ch === "?") {
      out += "[^/]";
    } else if (ch !== "*") {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    } else if (chars[pos] !== "*") {
      out += "[^/]*";
    } else if (chars[pos + 1] === "/") {
      out += "(?:.*/)?";
      pos += 2;
    } else {
      out += ".*";
      pos += 1;
    }
  }
  return new RegExp(`^${out}$`, process.platform === "win32" ? "i" : "");
}

/** A matcher over a path relative to the search root, with forward slashes. */
export function globMatcher(pattern: string): (rel: string) => boolean {
  const matchers = braceExpand(pattern.trim()).map((alt) => {
    if (!alt.includes("/")) {
      const re = globToRegex(alt);
      return (rel: string) => re.test(rel.slice(rel.lastIndexOf("/") + 1));
    }
    const anchored = alt.startsWith("/");
    const body = anchored ? alt.slice(1) : alt;
    const re = globToRegex(anchored || body.startsWith("**") ? body : `**/${body}`);
    return (rel: string) => re.test(rel);
  });
  return (rel) => matchers.some((m) => m(rel));
}

interface Walked {
  rel: string;
  abs: string;
  dir: boolean;
}

interface WalkState {
  deadline: number;
  timedOut: boolean;
  aborted: boolean;
}

/** Depth first walk. It never follows a symlink, skips noise folders and denied names, and stops at the deadline. */
function* walk(root: string, deps: FileToolDeps, state: WalkState, signal?: AbortSignal, rel = ""): Generator<Walked> {
  if (signal?.aborted) {
    state.aborted = true;
    return;
  }
  if ((deps.now ?? Date.now)() > state.deadline) {
    state.timedOut = true;
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
  for (const entry of entries) {
    if (state.timedOut || state.aborted) return;
    if (entry.isSymbolicLink()) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const abs = path.join(root, childRel);
    if (deps.policy.isDenied(abs)) continue;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      yield { rel: childRel, abs, dir: true };
      yield* walk(root, deps, state, signal, childRel);
    } else if (entry.isFile()) {
      yield { rel: childRel, abs, dir: false };
    }
  }
}

const text = (t: string, isError = false): AgentToolResult<null> => ({ content: [{ type: "text", text: t }], details: null, ...(isError ? { isError: true } : {}) });

function failure(e: unknown): AgentToolResult<null> {
  return text(e instanceof Error && e.message ? e.message : "The tool failed.", true);
}

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** The first bytes of a file, enough to tell its type. */
function readHead(abs: string): Uint8Array {
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const n = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads a text file up to the read ceiling, so a file that grows after the size check is still bounded. */
function readBounded(abs: string): string {
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.alloc(READ_FILE_LIMIT_BYTES);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    return buf.toString("utf8", 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function notFoundText(raw: string | undefined): string {
  return `Nothing exists at ${raw ?? "that path"}. Check the spelling, or use find to search by name.`;
}

// The worker holds the model's regular expression and answers with the numbers of the lines that match.
const SEARCH_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const re = new RegExp(workerData.source, workerData.flags);
parentPort.on("message", (m) => {
  const hits = [];
  for (let i = 0; i < m.lines.length && hits.length < m.max; i++) if (re.test(m.lines[i])) hits.push(i);
  parentPort.postMessage({ hits });
});
`;

type SearchResult = { hits: number[]; stop?: undefined } | { hits: number[]; stop: "timeout" | "aborted" | "failed" };

/** Runs one regular expression over the lines of each file in a worker thread, which is ended when a call passes its time limit. */
function createSearcher(re: RegExp) {
  let worker: Worker | null = null;
  let dead = false;
  const kill = () => {
    dead = true;
    void worker?.terminate();
    worker = null;
  };
  return {
    find(lines: string[], max: number, ms: number, signal?: AbortSignal): Promise<SearchResult> {
      if (dead) return Promise.resolve({ hits: [], stop: "failed" });
      if (!worker) {
        try {
          worker = new Worker(SEARCH_WORKER, { eval: true, workerData: { source: re.source, flags: re.flags } });
        } catch {
          dead = true;
          return Promise.resolve({ hits: [], stop: "failed" });
        }
      }
      const w = worker;
      return new Promise<SearchResult>((resolve) => {
        const done = (r: SearchResult) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          w.off("message", onMessage);
          w.off("error", onError);
          if (r.stop) kill();
          resolve(r);
        };
        const onMessage = (m: { hits: number[] }) => done({ hits: m.hits });
        const onError = () => done({ hits: [], stop: "failed" });
        const onAbort = () => done({ hits: [], stop: "aborted" });
        const timer = setTimeout(() => done({ hits: [], stop: "timeout" }), ms);
        w.on("message", onMessage);
        w.on("error", onError);
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort);
        w.postMessage({ lines, max });
      });
    },
    close: kill,
  };
}

export function createFileTools(deps: FileToolDeps): AnyTool[] {
  const now = deps.now ?? Date.now;
  const walkMs = deps.walkDeadlineMs ?? WALK_DEADLINE_MS;

  const read = defineTool({
    name: "read",
    label: "Read a file",
    description:
      "Reads a text file or an image. Give a path, and optionally a 1 based line offset and a line limit. Output stops at 2,000 lines or 50 KB, and a notice names the offset to continue from.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute: async (_id: string, params: { path: string; offset?: number; limit?: number }) => {
      try {
        const r = resolveToolPath(params.path, deps);
        if (!r.ok) return text(r.message, true);
        const st = statOrNull(r.abs);
        if (!st) return text(notFoundText(params.path), true);
        if (st.isDirectory()) return text("That path is a folder. Use ls to list it.", true);
        // the type comes from the first bytes, so a picture under a text name is still a picture
        const sniffed = sniffImageType(readHead(r.abs));
        const mime = sniffed ?? IMAGE_TYPES[path.extname(r.abs).toLowerCase()];
        if (mime) {
          if (st.size > MAX_IMAGE_FILE_BYTES) return text("The image is larger than 25 MiB and cannot be shown.", true);
          const processed = await processImage(fs.readFileSync(r.abs), mime, { resize: deps.imageLimits });
          const note = deps.imageInput === false ? " The session model does not take images, so it may not see this one." : "";
          if (!processed.ok) return text(`Read image file [${mime}]\n${processed.message}${note}`);
          const lines = [`Read image file [${processed.mimeType}] ${path.basename(r.abs)}`, ...processed.hints].join("\n") + note;
          return {
            content: [
              { type: "text", text: lines },
              { type: "image", data: processed.data, mimeType: processed.mimeType },
            ],
            details: null,
          };
        }
        if (st.size > READ_FILE_LIMIT_BYTES) {
          return text("The file is larger than 10 MiB, so it is not read whole. Use grep to find the part you need.", true);
        }
        const raw = readBounded(r.abs).replace(/\r\n/g, "\n");
        const lines = raw.split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        const start = (params.offset ?? 1) - 1;
        if (start >= lines.length && !(start === 0 && lines.length === 0)) {
          return text(`The offset is past the end of the file, which has ${lines.length} lines.`, true);
        }
        const wanted = Math.min(params.limit ?? READ_LINE_LIMIT, READ_LINE_LIMIT);
        const slice = lines.slice(start, start + wanted);
        const cut = cutLines(slice.join("\n"));
        const shown = cut.text === "" ? 0 : cut.text.split("\n").length;
        const last = start + shown;
        const more = last < lines.length;
        const notice = more ? `\n\n[Showing lines ${start + 1} to ${last} of ${lines.length}. Use offset ${last + 1} to continue.]` : "";
        return text(wrapUntrusted(cut.text, FILE_LABEL) + notice);
      } catch (e) {
        return failure(e);
      }
    },
  });

  const ls = defineTool({
    name: "ls",
    label: "List a folder",
    description: "Lists the entries of a folder, sorted without regard to case, with a trailing slash on folders. Dotfiles are included. Output stops at 500 entries.",
    parameters: Type.Object({ path: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1 })) }),
    execute: async (_id: string, params: { path?: string; limit?: number }) => {
      try {
        const r = resolveToolPath(params.path, deps);
        if (!r.ok) return text(r.message, true);
        const st = statOrNull(r.abs);
        if (!st) return text(notFoundText(params.path), true);
        if (!st.isDirectory()) return text("That path is a file. Use read to open it.", true);
        const entries = fs
          .readdirSync(r.abs, { withFileTypes: true })
          .filter((e) => !deps.policy.isDenied(path.join(r.abs, e.name)))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
        if (entries.length === 0) return text("The folder is empty.");
        const limit = Math.min(params.limit ?? LS_LIMIT, LS_LIMIT);
        const shown = entries.slice(0, limit);
        const body = cutLines(shown.join("\n"));
        const notes: string[] = [];
        if (entries.length > shown.length) notes.push(`Showing ${shown.length} of ${entries.length} entries.`);
        if (body.cut) notes.push("The output was cut at 50 KB.");
        return text(body.text + (notes.length ? `\n\n[${notes.join(" ")}]` : ""));
      } catch (e) {
        return failure(e);
      }
    },
  });

  const find = defineTool({
    name: "find",
    label: "Find files by name",
    description:
      "Finds files and folders by a glob. A pattern with no slash matches the base name at any depth. A star stays within one path segment, two stars cross segments, a question mark is one character, and one level of braces expands. Output stops at 1,000 entries.",
    parameters: Type.Object({
      pattern: Type.String({ minLength: 1 }),
      path: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute: async (_id: string, params: { pattern: string; path?: string; limit?: number }, signal?: AbortSignal) => {
      try {
        const r = resolveToolPath(params.path, deps);
        if (!r.ok) return text(r.message, true);
        const st = statOrNull(r.abs);
        if (!st || !st.isDirectory()) return text(notFoundText(params.path), true);
        const matches = globMatcher(params.pattern);
        const limit = Math.min(params.limit ?? FIND_LIMIT, FIND_LIMIT);
        const state: WalkState = { deadline: now() + walkMs, timedOut: false, aborted: false };
        const found: string[] = [];
        let capped = false;
        for (const entry of walk(r.abs, deps, state, signal)) {
          if (!matches(entry.rel)) continue;
          if (found.length >= limit) {
            capped = true;
            break;
          }
          found.push(entry.dir ? `${entry.rel}/` : entry.rel);
        }
        if (found.length === 0 && !state.timedOut && !state.aborted) return text("No file matched the pattern.");
        const body = cutLines(found.join("\n"));
        const notes: string[] = [];
        if (capped) notes.push(`Stopped at ${limit} entries.`);
        if (state.timedOut) notes.push("The search stopped at its time limit, so the list may be incomplete.");
        if (state.aborted) notes.push("The search was stopped, so the list may be incomplete.");
        if (body.cut) notes.push("The output was cut at 50 KB.");
        return text(body.text + (notes.length ? `\n\n[${notes.join(" ")}]` : ""));
      } catch (e) {
        return failure(e);
      }
    },
  });

  const grep = defineTool({
    name: "grep",
    label: "Search file contents",
    description:
      "Searches text files for a regular expression, or for a literal when literal is true. Optional glob, ignoreCase and context lines. Files over 2 MB and binary files are skipped, a line is cut at 500 characters, and output stops at 100 matches.",
    parameters: Type.Object({
      pattern: Type.String({ minLength: 1 }),
      path: Type.Optional(Type.String()),
      glob: Type.Optional(Type.String()),
      ignoreCase: Type.Optional(Type.Boolean()),
      literal: Type.Optional(Type.Boolean()),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute: async (
      _id: string,
      params: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number },
      signal?: AbortSignal,
    ) => {
      try {
        const r = resolveToolPath(params.path, deps);
        if (!r.ok) return text(r.message, true);
        const st = statOrNull(r.abs);
        if (!st) return text(notFoundText(params.path), true);
        let re: RegExp;
        try {
          const source = params.literal ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : params.pattern;
          re = new RegExp(source, params.ignoreCase ? "i" : "");
        } catch (e) {
          return text(`The pattern is not a valid regular expression: ${(e as Error).message}. Set literal to true to search for the text as it is.`, true);
        }
        const globOk = params.glob ? globMatcher(params.glob) : () => true;
        const ctx = params.context ?? 0;
        const limit = Math.min(params.limit ?? GREP_LIMIT, GREP_LIMIT);
        const state: WalkState = { deadline: now() + walkMs, timedOut: false, aborted: false };
        const files: { abs: string; rel: string }[] = [];
        if (st.isFile()) files.push({ abs: r.abs, rel: path.basename(r.abs) });
        else for (const e of walk(r.abs, deps, state, signal)) if (!e.dir && globOk(e.rel)) files.push({ abs: e.abs, rel: e.rel });
        const out: string[] = [];
        let matches = 0;
        let capped = false;
        let skipped = 0;
        const searcher = createSearcher(re);
        try {
          for (const file of files) {
            if (signal?.aborted) {
              state.aborted = true;
              break;
            }
            if (now() > state.deadline) {
              state.timedOut = true;
              break;
            }
            let buf: Buffer;
            try {
              const fst = fs.statSync(file.abs);
              if (fst.size > GREP_FILE_LIMIT_BYTES) {
                skipped++;
                continue;
              }
              buf = fs.readFileSync(file.abs);
            } catch {
              continue;
            }
            if (buf.subarray(0, 8192).includes(0)) {
              skipped++;
              continue;
            }
            const lines = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
            const emitted = new Set<number>();
            // the pattern runs in a worker that is stopped at the deadline, so a pattern that never returns cannot freeze the server
            const found = await searcher.find(lines, limit - matches + 1, Math.max(0, state.deadline - now()), signal);
            if (found.stop) {
              if (found.stop === "aborted") state.aborted = true;
              else if (found.stop === "timeout") state.timedOut = true;
              else return text("The search could not run.", true);
              break;
            }
            for (const i of found.hits) {
              if (matches >= limit) {
                capped = true;
                break;
              }
              matches++;
              for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) {
                if (emitted.has(k)) continue;
                emitted.add(k);
                const line = lines[k].length > GREP_LINE_LIMIT ? `${lines[k].slice(0, GREP_LINE_LIMIT)} … [truncated]` : lines[k];
                out.push(`${file.rel}${k === i ? ":" : "-"}${k + 1}${k === i ? ":" : "-"} ${line}`);
              }
            }
            if (capped) break;
          }
        } finally {
          searcher.close();
        }
        if (matches === 0 && !state.timedOut && !state.aborted) return text("No match was found.");
        const body = cutLines(out.join("\n"));
        const notes: string[] = [];
        if (capped) notes.push(`Stopped at ${limit} matches.`);
        if (skipped) notes.push(`${skipped} files were skipped as binary or over 2 MB.`);
        if (state.timedOut) notes.push("The search stopped at its time limit, so the matches may be incomplete.");
        if (state.aborted) notes.push("The search was stopped, so the matches may be incomplete.");
        if (body.cut) notes.push("The output was cut at 50 KB.");
        return text(wrapUntrusted(body.text, FILE_LABEL) + (notes.length ? `\n\n[${notes.join(" ")}]` : ""));
      } catch (e) {
        return failure(e);
      }
    },
  });

  return [read, ls, find, grep];
}
