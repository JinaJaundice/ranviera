// Loads graph.json and index.json from the data folder and reloads them when they change.
import fs from "node:fs";
import path from "node:path";
import type { GraphEdge, GraphFile, GraphNode, IndexFile, Sensitivity, StreamMessage } from "../../shared/types.ts";
import { buildAdjacency, loadParams, relationWeights, type ActivationParams, type Adjacency } from "./activation.ts";
import { ontologyDir, type Config } from "./config.ts";
import { InferredStore } from "./inferred.ts";
import { SparqlService } from "./sparql.ts";
import { readJsonFile } from "./util.ts";

const WATCHED = new Set(["graph.json", "index.json", "graph.ttl", "graph.trig", "inferred.json", "inferred.ttl"]);

/** What a person does in the app when the graph is missing. Every not-built message uses it. */
export const REBUILD_HINT = "Open the Health window and choose Rebuild and check.";
export const NOT_BUILT = `The graph has not been built. ${REBUILD_HINT}`;

export interface GraphView {
  file: GraphFile;
  byId: Map<string, GraphNode>;
  out: Map<string, GraphEdge[]>;
  inn: Map<string, GraphEdge[]>;
  adj: Adjacency;
  params: ActivationParams;
}

export function buildView(file: GraphFile, params: ActivationParams): GraphView {
  const byId = new Map<string, GraphNode>();
  for (const n of file.nodes) byId.set(n.id, n);
  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  const add = (m: Map<string, GraphEdge[]>, k: string, e: GraphEdge) => {
    const l = m.get(k);
    if (l) l.push(e);
    else m.set(k, [e]);
  };
  for (const e of file.edges) {
    add(out, e.s, e);
    add(inn, e.t, e);
  }
  return { file, byId, out, inn, adj: buildAdjacency(file.edges, relationWeights(file.relations)), params };
}

const RANK: Record<Sensitivity, number> = { public: 0, internal: 1, "client-confidential": 2 };

export function parseSensitivity(value: string | null | undefined): Sensitivity {
  return value === "public" || value === "internal" ? value : "client-confidential";
}

export class GraphStore {
  view: GraphView | null = null;
  index: IndexFile | null = null;
  /** SPARQL over graph.ttl and inferred.ttl, and the facts of inferred.json. Both reload with the graph. */
  sparql: SparqlService;
  inferred: InferredStore;
  private cfg: Config;
  private broadcast: (m: StreamMessage) => void;
  private timer: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private stamp = "";

  constructor(cfg: Config, broadcast: (m: StreamMessage) => void = () => {}) {
    this.cfg = cfg;
    this.broadcast = broadcast;
    this.sparql = new SparqlService(cfg.data_dir);
    this.inferred = new InferredStore(cfg.data_dir);
  }

  get built(): string | null {
    return this.view?.file.built ?? null;
  }

  /** Reads both files. Returns true when graph.json was read. The graph message goes out when the build time changed, or when force is set. */
  reload(force = false): boolean {
    const g = readJsonFile<GraphFile>(path.join(this.cfg.data_dir, "graph.json"));
    const i = readJsonFile<IndexFile>(path.join(this.cfg.data_dir, "index.json"));
    if (i) this.index = i;
    if (!g || !Array.isArray(g.nodes)) return false;
    const before = this.view?.file.built ?? null;
    this.view = buildView(g, loadParams(ontologyDir(this.cfg), this.cfg.profile_dir, this.cfg.data_dir));
    this.stamp = this.fileStamp();
    this.inferred.reload();
    void this.sparql.reload();
    if (force || before !== g.built) this.broadcast({ type: "graph", built: g.built });
    return true;
  }

  private fileStamp(): string {
    try {
      const s = fs.statSync(path.join(this.cfg.data_dir, "graph.json"));
      let extra = "";
      try {
        const i = fs.statSync(path.join(this.cfg.data_dir, "inferred.json"));
        extra = `:${i.mtimeMs}:${i.size}`;
      } catch {
        // inferred.json is optional
      }
      return `${s.mtimeMs}:${s.size}${extra}`;
    } catch {
      return "";
    }
  }

  start(): void {
    this.reload();
    try {
      fs.mkdirSync(this.cfg.data_dir, { recursive: true });
      this.watcher = fs.watch(this.cfg.data_dir, (_event, name) => {
        if (name && !WATCHED.has(name)) return;
        this.schedule();
      });
      this.watcher.on("error", () => {});
    } catch {
      // the poll below covers a folder that cannot be watched
    }
    this.poll = setInterval(() => {
      const s = this.fileStamp();
      if (s && s !== this.stamp) this.schedule();
    }, 5000);
    this.poll.unref();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.reload()) {
        // a build may still be writing the file, so try once more
        this.timer = setTimeout(() => {
          this.timer = null;
          this.reload();
        }, 400);
        this.timer.unref();
      }
    }, 400);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.watcher?.close();
    this.sparql.stop();
  }

  /** The graph filtered to the given sensitivity and below. */
  getGraph(max: Sensitivity = "client-confidential"): GraphFile | null {
    if (!this.view) return null;
    const f = this.view.file;
    const limit = RANK[max];
    if (limit >= 2) return f;
    const nodes = f.nodes.filter((n) => RANK[n.sensitivity] <= limit);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = f.edges.filter((e) => ids.has(e.s) && ids.has(e.t));
    const by_class: Record<string, number> = {};
    for (const n of nodes) by_class[n.type] = (by_class[n.type] ?? 0) + 1;
    return { ...f, nodes, edges, stats: { nodes: nodes.length, edges: edges.length, by_class } };
  }

  getNode(id: string): { node: GraphNode; in: GraphEdge[]; out: GraphEdge[]; neighbours: GraphNode[] } | null {
    const v = this.view;
    const node = v?.byId.get(id);
    if (!v || !node) return null;
    const inn = v.inn.get(id) ?? [];
    const out = v.out.get(id) ?? [];
    const seen = new Set<string>();
    const neighbours: GraphNode[] = [];
    for (const e of [...inn, ...out]) {
      const other = e.s === id ? e.t : e.s;
      const n = v.byId.get(other);
      if (n && !seen.has(other)) {
        seen.add(other);
        neighbours.push(n);
      }
    }
    return { node, in: inn, out, neighbours };
  }
}
