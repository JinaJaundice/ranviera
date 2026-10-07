// SPARQL over the graph and the inferred facts. One Oxigraph store lives in a worker thread, because
// Oxigraph has no query timeout: a query that runs too long is stopped by ending the thread.
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { SavedQuery, SparqlResult, SparqlTerm } from "../../shared/types.ts";
import { fileURLToPath } from "node:url";
import { HttpError } from "./util.ts";

/** A bundled server has the worker beside it as sparql.worker.js. From source the worker is the .ts file. */
function workerUrl(): URL {
  const js = new URL("./sparql.worker.js", import.meta.url);
  try {
    if (fs.existsSync(fileURLToPath(js))) return js;
  } catch {
    // fall through to the source file
  }
  return new URL("./sparql.worker.ts", import.meta.url);
}

export const MAX_ROWS = 5000;
export const TIMEOUT_MS = 10_000;
/** A longer query can overflow the parser's stack inside Oxigraph, so it is refused before it reaches the store. */
export const MAX_QUERY_CHARS = 20_000;

const UPDATE_WORDS = ["INSERT", "DELETE", "LOAD", "CLEAR", "CREATE", "DROP", "ADD", "MOVE", "COPY", "WITH"];
const UPDATE_RE = new RegExp(`(?<![\\w:?$-])(${UPDATE_WORDS.join("|")})(?![\\w:-])`, "i");
const KIND_RE = /(?<![\w:?$-])(SELECT|ASK|CONSTRUCT|DESCRIBE)(?![\w:-])/i;

/** The query with comments, string literals and IRIs blanked, so that keywords can be found safely. */
export function stripNoise(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "#") {
      while (i < n && text[i] !== "\n") i += 1;
      out += " ";
    } else if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      i += close.length;
      while (i < n && !text.startsWith(close, i)) {
        if (text[i] === "\\") i += 1;
        if (!triple && text[i] === "\n") break;
        i += 1;
      }
      i += close.length;
      out += '""';
    } else if (c === "<") {
      const end = text.indexOf(">", i);
      if (end > i && !/\s/.test(text.slice(i + 1, end))) {
        i = end + 1;
        out += "<>";
      } else {
        out += c;
        i += 1;
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

export type QueryKind = "select" | "ask" | "construct";

/** Checks that the text is a read-only query and says which kind it is. Throws a 400 otherwise. */
export function classify(text: string): QueryKind {
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "The query is empty.");
  if (text.length > MAX_QUERY_CHARS) throw new HttpError(400, `The query is longer than ${MAX_QUERY_CHARS.toLocaleString("en-GB")} characters. Shorten it and run it again.`);
  const bare = stripNoise(text);
  const bad = UPDATE_RE.exec(bare);
  if (bad) throw new HttpError(400, `This window runs read-only queries, so ${bad[1].toUpperCase()} is not allowed. Use SELECT, ASK or CONSTRUCT.`);
  const k = KIND_RE.exec(bare);
  if (!k) throw new HttpError(400, "The query must be a SELECT, ASK or CONSTRUCT query.");
  const kind = k[1].toUpperCase();
  return kind === "ASK" ? "ask" : kind === "SELECT" ? "select" : "construct";
}

/** The variables a SELECT query projects, in order, or null for SELECT *. */
export function projectedVars(text: string): string[] | null {
  const bare = stripNoise(text);
  const k = KIND_RE.exec(bare);
  if (!k) return null;
  const rest = bare.slice(k.index + k[1].length);
  const stop = /\{|(?<![\w:?$-])WHERE\b/i.exec(rest);
  const header = stop ? rest.slice(0, stop.index) : rest;
  const vars: string[] = [];
  let depth = 0;
  const token = /\(|\)|\bAS\s+[?$](\w+)|[?$](\w+)|\*/gi;
  for (let m = token.exec(header); m; m = token.exec(header)) {
    if (m[0] === "(") depth += 1;
    else if (m[0] === ")") depth -= 1;
    else if (m[0] === "*") {
      if (depth === 0) return null;
    } else if (m[1]) vars.push(m[1]);
    else if (m[2] && depth === 0) vars.push(m[2]);
  }
  return vars;
}

const INSTANCE = /^https:\/\/cortex\.local\/id\/([^/]+)\/(.+)$/;

/** "<prefix>:<slug>" for an instance IRI, or null for any other IRI. */
export function nodeOfIri(iri: string): string | null {
  const m = INSTANCE.exec(iri);
  if (!m) return null;
  try {
    return `${m[1]}:${decodeURIComponent(m[2])}`;
  } catch {
    return `${m[1]}:${m[2]}`;
  }
}

export function withNode(t: SparqlTerm): SparqlTerm {
  if (t.type !== "uri") return t;
  const node = nodeOfIri(t.value);
  return node ? { ...t, node } : t;
}

interface Handle {
  worker: Worker;
  pending: Map<number, { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void }>;
  retired: boolean;
  dead: boolean;
}

export interface SparqlOptions {
  maxRows?: number;
  timeoutMs?: number;
}

export class SparqlService {
  private dir: string;
  private maxRows: number;
  private timeoutMs: number;
  private current: Handle | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private stopped = false;

  constructor(dataDir: string, opts: SparqlOptions = {}) {
    this.dir = dataDir;
    this.maxRows = opts.maxRows ?? MAX_ROWS;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  /** Builds a new store in a new thread and swaps it in when it is ready. Queries keep using the old store until then. */
  reload(): Promise<void> {
    const p = this.build()
      .then((h) => {
        const old = this.current;
        if (this.stopped) {
          void h.worker.terminate();
          return;
        }
        this.current = h;
        if (old) this.retire(old);
      })
      .catch(() => {
        // the old store stays in place when the new one cannot be built
      });
    this.ready ??= p;
    return p;
  }

  /** Resolves when the first load has finished. */
  whenReady(): Promise<void> {
    return this.ready ?? this.reload();
  }

  stop(): void {
    this.stopped = true;
    if (this.current) void this.current.worker.terminate();
    this.current = null;
  }

  private retire(h: Handle): void {
    h.retired = true;
    if (h.pending.size === 0) void h.worker.terminate();
  }

  private spawn(): Handle {
    const worker = new Worker(workerUrl());
    const h: Handle = { worker, pending: new Map(), retired: false, dead: false };
    worker.on("message", (m: Record<string, unknown>) => {
      const w = h.pending.get(m.id as number);
      if (!w) return;
      h.pending.delete(m.id as number);
      w.resolve(m);
      if (h.retired && h.pending.size === 0) void worker.terminate();
    });
    const fail = (e: Error) => {
      h.dead = true;
      for (const w of h.pending.values()) w.reject(e);
      h.pending.clear();
    };
    worker.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
    worker.on("exit", () => fail(new Error("The query worker stopped.")));
    return h;
  }

  private send(h: Handle, msg: Record<string, unknown>, limitMs?: number): Promise<Record<string, unknown>> {
    const id = (this.seq += 1);
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const done = <T>(f: (v: T) => void) => (v: T) => {
        if (timer) clearTimeout(timer);
        f(v);
      };
      h.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      if (limitMs) {
        timer = setTimeout(() => {
          h.pending.delete(id);
          reject(new HttpError(408, `The query ran for longer than ${Math.round(limitMs / 100) / 10} seconds and was stopped. Add a LIMIT or a more specific pattern.`));
          // the thread cannot be interrupted, so it is ended, and the others waiting on it are told to retry
          this.recycle(h);
        }, limitMs);
        timer.unref();
      }
      h.worker.postMessage({ id, ...msg });
    });
  }

  /** Ends a worker that cannot be trusted any more, tells the queries waiting on it to retry, and builds a new store. */
  private recycle(h: Handle): void {
    for (const w of h.pending.values()) w.reject(new HttpError(503, "The query service restarted after a slow query. Run the query again."));
    h.pending.clear();
    h.dead = true;
    void h.worker.terminate();
    if (this.current === h && !this.stopped) {
      this.current = null;
      this.ready = null;
      void this.reload();
    }
  }

  private async build(): Promise<Handle> {
    const h = this.spawn();
    try {
      // graph.trig holds the named graphs and the union is the default graph, so it replaces the two Turtle files when it exists
      const names = fs.existsSync(path.join(this.dir, "graph.trig")) ? ["graph.trig"] : ["graph.ttl", "inferred.ttl"];
      const files = names.map((f) => path.join(this.dir, f));
      const r = await this.send(h, { op: "load", files });
      if (r.ok !== true) throw new Error(String(r.error ?? "The graph could not be loaded."));
      return h;
    } catch (e) {
      void h.worker.terminate();
      throw e;
    }
  }

  async query(text: string): Promise<SparqlResult> {
    const kind = classify(text);
    await this.whenReady();
    const h = this.current;
    if (!h || h.dead) throw new HttpError(503, "The query service is not ready. Open the Health window, choose Rebuild and check, then try again.");
    const t0 = performance.now();
    let r: Record<string, unknown>;
    try {
      r = await this.send(h, { op: "query", text, kind, maxRows: this.maxRows }, this.timeoutMs);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(503, "The query service stopped while the query ran. Run the query again.");
    }
    const ms = Math.round(performance.now() - t0);
    if (r.ok !== true && r.fatal === true) {
      // a WebAssembly trap leaves the store unusable, so the thread is replaced and the next query gets a fresh store
      this.recycle(h);
      throw new HttpError(400, "The query is too large or too deeply nested for the query service, which has been restarted. Simplify the query and run it again.");
    }
    if (r.ok !== true) throw new HttpError(400, `The query is not valid: ${String(r.error ?? "unknown error")}`);
    if (kind === "ask") return { kind: "ask", value: r.value === true, ms };
    if (kind === "select") {
      const rows = (r.rows as Record<string, SparqlTerm>[]).map((row) => {
        const o: Record<string, SparqlTerm> = {};
        for (const [k, v] of Object.entries(row)) o[k] = withNode(v);
        return o;
      });
      let vars = projectedVars(text);
      if (!vars) {
        const seen = new Set<string>();
        for (const row of rows) for (const k of Object.keys(row)) seen.add(k);
        vars = [...seen];
      }
      return { kind: "select", vars, rows, truncated: r.truncated === true, ms };
    }
    const triples = (r.triples as [SparqlTerm, SparqlTerm, SparqlTerm][]).map((t) => t.map(withNode) as [SparqlTerm, SparqlTerm, SparqlTerm]);
    return { kind: "construct", triples, truncated: r.truncated === true, ms };
  }
}

/** The saved queries in ontology/queries/*.rq. The id is the file stem and the title is the first comment line. */
export function loadSavedQueries(dir: string): SavedQuery[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".rq")).sort();
  } catch {
    return [];
  }
  const out: SavedQuery[] = [];
  for (const f of files) {
    let query: string;
    try {
      query = fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");
    } catch {
      continue;
    }
    const first = query.split("\n").find((l) => l.trim() !== "") ?? "";
    const m = /^\s*#+\s*(.*)$/.exec(first);
    const id = f.slice(0, -3);
    out.push({ id, title: m && m[1].trim() ? m[1].trim() : id, query });
  }
  return out;
}
