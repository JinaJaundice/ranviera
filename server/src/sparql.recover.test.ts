// Recovery from a query that traps the store, the length limit and the load of graph.trig.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "./util.ts";
import { MAX_QUERY_CHARS, SparqlService, classify } from "./sparql.ts";

const HEAD = "@prefix cx: <https://cortex.local/ont#> .\n";
const dirs: string[] = [];
const services: SparqlService[] = [];

function dataDir(files: Record<string, string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-sparql-"));
  dirs.push(d);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), HEAD + text);
  return d;
}

function service(dir: string): SparqlService {
  const s = new SparqlService(dir);
  services.push(s);
  return s;
}

afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const rejects = async (p: Promise<unknown>): Promise<HttpError> => {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("The promise did not reject.");
};

describe("a query that traps the store", () => {
  it("replaces the worker, so a trivial query still answers afterwards", async () => {
    const s = service(dataDir({ "graph.ttl": '<http://x/a> cx:label "A" .\n' }));
    await s.whenReady();
    const nested = `ASK ${"{ ".repeat(1000)}?s ?p ?o${" }".repeat(1000)}`;
    expect(nested.length).toBeLessThan(MAX_QUERY_CHARS);
    const e = await rejects(s.query(nested));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/restarted/);
    const r = await s.query("SELECT ?s WHERE { ?s ?p ?o } LIMIT 1");
    expect(r.kind === "select" && r.rows.length).toBe(1);
  });

  it("refuses a query longer than the limit before it reaches the store", () => {
    let e: HttpError | null = null;
    try {
      classify(`ASK { ${"?s ?p ?o . ".repeat(3000)} }`);
    } catch (x) {
      e = x as HttpError;
    }
    expect(e?.status).toBe(400);
    expect(e?.message).toMatch(/longer than/);
  });
});

describe("loading graph.trig", () => {
  it("reads the named graphs, takes the union as the default graph and lets GRAPH pick one", async () => {
    const d = dataDir({
      "graph.ttl": '<http://x/ttl> cx:label "ttl only" .\n',
      "graph.trig": '<https://cortex.local/graph/stated> { <http://x/a> cx:label "A" . }\n<https://cortex.local/graph/inferred> { <http://x/b> cx:label "B" . }\n',
    });
    const s = service(d);
    const all = await s.query("SELECT ?s WHERE { ?s ?p ?o }");
    expect(all.kind === "select" && all.rows.map((r) => r.s.value).sort()).toEqual(["http://x/a", "http://x/b"]);
    const one = await s.query("SELECT ?s WHERE { GRAPH <https://cortex.local/graph/inferred> { ?s ?p ?o } }");
    expect(one.kind === "select" && one.rows.map((r) => r.s.value)).toEqual(["http://x/b"]);
  });
});
