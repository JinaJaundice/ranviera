// The worker thread that holds one Oxigraph store. Oxigraph has no query timeout, so the
// service in sparql.ts runs each query here and stops the thread when a query takes too long.
import fs from "node:fs";
import { parentPort } from "node:worker_threads";
import * as oxigraph from "oxigraph";

type Ox = typeof oxigraph;
// Under Node's ES module loader a CommonJS package may arrive as a default export.
const ox: Ox = (oxigraph as unknown as { default?: Ox }).default ?? oxigraph;

interface Term {
  termType: string;
  value: string;
}
type Wire = { type: "uri" | "literal" | "bnode"; value: string };

const wire = (t: Term): Wire => ({ type: t.termType === "NamedNode" ? "uri" : t.termType === "BlankNode" ? "bnode" : "literal", value: t.value });

let store = new ox.Store();

type In =
  | { id: number; op: "load"; files: string[] }
  | { id: number; op: "query"; text: string; kind: "select" | "ask" | "construct"; maxRows: number };

parentPort?.on("message", (m: In) => {
  try {
    if (m.op === "load") {
      const next = new ox.Store();
      let loaded = 0;
      for (const f of m.files) {
        if (!fs.existsSync(f)) continue;
        next.load(fs.readFileSync(f, "utf8"), { format: f.endsWith(".trig") ? "application/trig" : "text/turtle" });
        loaded += 1;
      }
      store = next;
      parentPort?.postMessage({ id: m.id, ok: true, loaded });
      return;
    }
    const r = store.query(m.text, { use_default_graph_as_union: true });
    if (m.kind === "ask") {
      parentPort?.postMessage({ id: m.id, ok: true, kind: "ask", value: Boolean(r) });
    } else if (m.kind === "select") {
      const rows = (r as Map<string, Term>[]).slice(0, m.maxRows + 1);
      const truncated = rows.length > m.maxRows;
      if (truncated) rows.length = m.maxRows;
      const out = rows.map((row) => {
        const o: Record<string, Wire> = {};
        for (const [k, v] of row) o[k] = wire(v);
        return o;
      });
      parentPort?.postMessage({ id: m.id, ok: true, kind: "select", rows: out, truncated });
    } else {
      const quads = (r as unknown as { subject: Term; predicate: Term; object: Term }[]).slice(0, m.maxRows + 1);
      const truncated = quads.length > m.maxRows;
      if (truncated) quads.length = m.maxRows;
      parentPort?.postMessage({ id: m.id, ok: true, kind: "construct", triples: quads.map((q) => [wire(q.subject), wire(q.predicate), wire(q.object)]), truncated });
    }
  } catch (e) {
    // "error" is the name Oxigraph gives a parse or evaluation error. Any other class (a WebAssembly
    // RuntimeError, for example) means the store is no longer sound, and the service ends this thread.
    const name = e instanceof Error ? e.constructor.name : typeof e;
    parentPort?.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e), fatal: name !== "Error" });
  }
});
