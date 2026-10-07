// Tails the event files and the register log, and broadcasts each new event with its activation.
import fs from "node:fs";
import path from "node:path";
import type { CortexEvent, EventKind, StreamMessage } from "../../shared/types.ts";
import { spread } from "./activation.ts";
import type { Config } from "./config.ts";
import type { GraphStore } from "./graph.ts";
import { faultKeys, parseRegisterLine, registerTime } from "./register.ts";
import { Lru, dayKey, ensureDir, monthKey, monthsBetween } from "./util.ts";

const SOURCES = new Set(["hook", "orchestrator", "replay", "cortex"]);

export function normaliseEvent(raw: unknown): CortexEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.ts !== "string" || typeof o.kind !== "string") return null;
  const nodes = Array.isArray(o.nodes) ? o.nodes.filter((n): n is string => typeof n === "string") : [];
  const weight = typeof o.weight === "number" && Number.isFinite(o.weight) ? Math.max(0, Math.min(1, o.weight)) : 0.5;
  return {
    v: 1,
    ts: o.ts,
    session: typeof o.session === "string" ? o.session : "unknown",
    source: typeof o.source === "string" && SOURCES.has(o.source) ? (o.source as CortexEvent["source"]) : "hook",
    kind: o.kind as EventKind,
    nodes,
    weight,
    label: typeof o.label === "string" ? o.label.slice(0, 120) : "",
    key: typeof o.key === "string" ? o.key : null,
    meta: o.meta && typeof o.meta === "object" && !Array.isArray(o.meta) ? (o.meta as Record<string, unknown>) : {},
  };
}

export function makeEvent(p: Partial<CortexEvent> & Pick<CortexEvent, "session" | "source" | "kind">): CortexEvent {
  return {
    v: 1,
    ts: new Date().toISOString(),
    nodes: [],
    weight: 0.5,
    label: "",
    key: null,
    meta: {},
    ...p,
  };
}

interface Tail {
  dir: string;
  current: string | null;
  offset: number;
  rest: Buffer;
  handle: (line: string) => void;
}

export class EventHub {
  private graph: GraphStore;
  private broadcast: (m: StreamMessage) => void;
  private seen = new Lru(5000);
  private events: Tail;
  private register: Tail;
  private watchers: fs.FSWatcher[] = [];
  private poll: NodeJS.Timeout | null = null;
  private pumping = false;
  private again = false;

  constructor(cfg: Config, graph: GraphStore, broadcast: (m: StreamMessage) => void) {
    this.graph = graph;
    this.broadcast = broadcast;
    this.events = { dir: path.join(cfg.data_dir, "events"), current: null, offset: 0, rest: Buffer.alloc(0), handle: (l) => this.onEventLine(l) };
    this.register = {
      dir: path.join(cfg.claude_home, "register-log"),
      current: null,
      offset: 0,
      rest: Buffer.alloc(0),
      handle: (l) => this.onRegisterLine(l),
    };
  }

  eventsFile(month: string): string {
    return path.join(this.events.dir, `${month}.jsonl`);
  }

  /** Starts each tail at the end of its current file, so that history is not replayed. */
  init(): void {
    ensureDir(this.events.dir);
    for (const t of [this.events, this.register]) {
      t.current = path.join(t.dir, `${monthKey(new Date())}.jsonl`);
      try {
        t.offset = fs.statSync(t.current).size;
      } catch {
        t.offset = 0;
      }
      t.rest = Buffer.alloc(0);
    }
  }

  start(): void {
    this.init();
    for (const dir of [this.events.dir, this.register.dir]) {
      try {
        const w = fs.watch(dir, () => this.pump());
        w.on("error", () => {});
        this.watchers.push(w);
      } catch {
        // the one second poll covers a folder that does not exist yet
      }
    }
    this.poll = setInterval(() => this.pump(), 1000);
    this.poll.unref();
  }

  stop(): void {
    if (this.poll) clearInterval(this.poll);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  /** Reads the bytes appended since the last call and handles each complete line. */
  pump(): void {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        this.pumpTail(this.register);
        this.pumpTail(this.events);
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }

  private pumpTail(t: Tail): void {
    const wanted = path.join(t.dir, `${monthKey(new Date())}.jsonl`);
    if (t.current && t.current !== wanted) {
      this.readNew(t);
      t.current = wanted;
      t.offset = 0;
      t.rest = Buffer.alloc(0);
    }
    if (!t.current) t.current = wanted;
    this.readNew(t);
  }

  private readNew(t: Tail): void {
    if (!t.current) return;
    let size: number;
    try {
      size = fs.statSync(t.current).size;
    } catch {
      return;
    }
    if (size < t.offset) {
      t.offset = 0;
      t.rest = Buffer.alloc(0);
    }
    if (size === t.offset) return;
    const buf = Buffer.alloc(size - t.offset);
    const fd = fs.openSync(t.current, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, t.offset);
    } finally {
      fs.closeSync(fd);
    }
    t.offset = size;
    const data = Buffer.concat([t.rest, buf]);
    const nl = data.lastIndexOf(10);
    if (nl < 0) {
      t.rest = data;
      return;
    }
    t.rest = data.subarray(nl + 1);
    for (const line of data.subarray(0, nl).toString("utf8").split("\n")) {
      if (line.trim()) t.handle(line);
    }
  }

  private onEventLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const ev = normaliseEvent(raw);
    if (ev) this.ingest(ev);
  }

  /** Drops a repeat of (session, key) and the node ids that are not in the graph, then broadcasts the event with its spread. Returns false for a repeat. */
  ingest(ev: CortexEvent): boolean {
    if (ev.key !== null && this.seen.seen(`${ev.session}\u0000${ev.key}`)) return false;
    const view = this.graph.view;
    const event = view ? { ...ev, nodes: ev.nodes.filter((n) => view.byId.has(n)) } : ev;
    const activation = view && event.nodes.length ? spread(view.adj, event.nodes.map((n) => [n, event.weight]), view.params) : [];
    this.broadcast({ type: "fire", event, activation });
    return true;
  }

  private onRegisterLine(line: string): void {
    const r = parseRegisterLine(line);
    if (!r) return;
    const keys = faultKeys(r);
    if (keys.length === 0) return;
    const when = registerTime(r.t) ?? new Date();
    this.append(
      makeEvent({
        ts: when.toISOString(),
        session: r.session ?? "register",
        source: "cortex",
        kind: "fault",
        nodes: keys.map((k) => `fault:${k}`),
        weight: 0.6,
        label: `Register fault: ${keys.join(", ")}`.slice(0, 120),
        key: `register:${String(r.t)}:${r.session ?? ""}:${r.path ?? ""}`,
        meta: { path: r.path ?? null, record: r.kind ?? null },
      }),
    );
  }

  /** Appends one event to the current month file. The tail then reads it and broadcasts it. */
  append(ev: CortexEvent): void {
    ensureDir(this.events.dir);
    fs.appendFileSync(this.eventsFile(monthKey(new Date())), JSON.stringify(ev) + "\n", "utf8");
    this.pump();
  }

  /** Events with a time from since to until, oldest first, keeping the newest limit of them. */
  recent(since?: Date, until?: Date, limit = 500): CortexEvent[] {
    const end = until ?? new Date();
    const begin = since ?? new Date(end.getTime() - 86400000);
    const out: CortexEvent[] = [];
    for (const month of monthsBetween(begin, end)) {
      let text: string;
      try {
        text = fs.readFileSync(this.eventsFile(month), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = normaliseEvent(JSON.parse(line));
          if (!ev) continue;
          const t = Date.parse(ev.ts);
          if (t >= begin.getTime() && t <= end.getTime()) out.push(ev);
        } catch {
          // a damaged line is skipped
        }
      }
    }
    out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  withActivation(since?: Date, until?: Date, limit = 2000) {
    const view = this.graph.view;
    return this.recent(since, until, limit).map((event) => {
      const nodes = view ? event.nodes.filter((n) => view.byId.has(n)) : event.nodes;
      const activation = view && nodes.length ? spread(view.adj, nodes.map((n) => [n, event.weight]), view.params) : [];
      return { event: { ...event, nodes }, activation };
    });
  }

  /** The last events that fired a node, looking back over three months. */
  forNode(id: string, limit = 50): CortexEvent[] {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
    return this.recent(from, now, 1_000_000)
      .filter((e) => e.nodes.includes(id))
      .slice(-limit)
      .reverse();
  }

  /** Today's events by kind, read from the month file, so the counts are not limited to the events held in memory. */
  countTodayByKind(): Record<string, number> {
    const today = dayKey(new Date());
    let text: string;
    try {
      text = fs.readFileSync(this.eventsFile(monthKey(new Date())), "utf8");
    } catch {
      return {};
    }
    const out: Record<string, number> = {};
    for (const line of text.split("\n")) {
      if (!line.includes(`"ts":"${today}`)) continue;
      const m = /"kind":"([a-z.]+)"/.exec(line);
      if (m) out[m[1]] = (out[m[1]] ?? 0) + 1;
    }
    return out;
  }

  countToday(): number {
    const today = dayKey(new Date());
    let text: string;
    try {
      text = fs.readFileSync(this.eventsFile(monthKey(new Date())), "utf8");
    } catch {
      return 0;
    }
    let n = 0;
    for (const line of text.split("\n")) if (line.includes(`"ts":"${today}`)) n += 1;
    return n;
  }
}
