import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "./util.ts";
import { classify, loadSavedQueries, nodeOfIri, projectedVars, SparqlService, stripNoise } from "./sparql.ts";

const HEAD = "@prefix cx: <https://cortex.local/ont#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n";
const iri = (prefix: string, slug: string) => `<https://cortex.local/id/${prefix}/${slug}>`;

const dirs: string[] = [];
const services: SparqlService[] = [];

function dataDir(graph: string, inferred?: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-sparql-"));
  dirs.push(d);
  fs.writeFileSync(path.join(d, "graph.ttl"), HEAD + graph);
  if (inferred !== undefined) fs.writeFileSync(path.join(d, "inferred.ttl"), HEAD + inferred);
  return d;
}

function service(dir: string, opts = {}): SparqlService {
  const s = new SparqlService(dir, opts);
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

describe("update refusal", () => {
  it.each(["INSERT DATA { <http://a> <http://b> 1 }", "DELETE WHERE { ?s ?p ?o }", "LOAD <http://example.org/x>", "CLEAR ALL", "CREATE GRAPH <http://g>", "DROP ALL", "ADD <http://a> TO <http://b>", "MOVE <http://a> TO <http://b>", "COPY <http://a> TO <http://b>", "WITH <http://g> DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }"])(
    "refuses %s with a 400 and a plain message",
    (text) => {
      try {
        classify(text);
        throw new Error("not refused");
      } catch (e) {
        expect(e).toBeInstanceOf(HttpError);
        expect((e as HttpError).status).toBe(400);
        expect((e as HttpError).message).toMatch(/read-only/);
      }
    },
  );

  it("refuses lower case keywords after a prefix declaration", () => {
    expect(() => classify("PREFIX cx: <https://cortex.local/ont#>\ninsert data { cx:a cx:b cx:c }")).toThrow(/not allowed/);
  });

  it("ignores a keyword inside a comment, a string, an IRI or a prefixed name", () => {
    expect(classify("# DROP everything\nSELECT * WHERE { ?s ?p ?o }")).toBe("select");
    expect(classify('SELECT * WHERE { ?s ?p "delete me" }')).toBe("select");
    expect(classify("SELECT * WHERE { ?s ?p 'it\\'s a COPY' }")).toBe("select");
    expect(classify('SELECT * WHERE { ?s ?p """a\nCLEAR\nb""" }')).toBe("select");
    expect(classify("SELECT * WHERE { <http://example.org/drop> ?p ?o }")).toBe("select");
    expect(classify("PREFIX cx: <https://cortex.local/ont#> SELECT * WHERE { ?s cx:move ?o . ?s cx:with ?x }")).toBe("select");
    expect(classify("SELECT * WHERE { ?s ?p ?o . FILTER (?o < 5 && ?o > 1) }")).toBe("select");
  });

  it("names the three read kinds and refuses an empty or unknown query", () => {
    expect(classify("ASK { ?s ?p ?o }")).toBe("ask");
    expect(classify("CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }")).toBe("construct");
    expect(() => classify("   ")).toThrow(/empty/);
    expect(() => classify("hello")).toThrow(/SELECT, ASK or CONSTRUCT/);
  });

  it("refuses an update through the service", async () => {
    const s = service(dataDir(`${iri("rule", "a")} a cx:Rule .\n`));
    const e = await rejects(s.query("INSERT DATA { <http://a> <http://b> <http://c> }"));
    expect(e.status).toBe(400);
  });

  it("returns a 400 for text that is not valid SPARQL", async () => {
    const s = service(dataDir(`${iri("rule", "a")} a cx:Rule .\n`));
    const e = await rejects(s.query("SELECT ?s WHERE { ?s ?p"));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/not valid/);
  });

  it("blanks comments, strings and IRIs", () => {
    expect(stripNoise("a # b\nc 'd' <http://e> f")).toBe('a  \nc "" <> f');
  });
});

describe("projected variables", () => {
  it("lists variables and aliases in order, and gives null for SELECT *", () => {
    expect(projectedVars("SELECT DISTINCT ?a ?b WHERE { ?a ?p ?b }")).toEqual(["a", "b"]);
    expect(projectedVars("SELECT ?t (COUNT(?x) AS ?n) WHERE { ?x a ?t } GROUP BY ?t")).toEqual(["t", "n"]);
    expect(projectedVars("SELECT * WHERE { ?a ?p ?b }")).toBeNull();
  });

  it("returns the variables for a query with no rows", async () => {
    const s = service(dataDir(`${iri("rule", "a")} a cx:Rule .\n`));
    const r = await s.query("SELECT ?x ?y WHERE { ?x <http://nothing> ?y }");
    expect(r).toMatchObject({ kind: "select", vars: ["x", "y"], rows: [], truncated: false });
  });
});

describe("mapping an instance IRI to a node", () => {
  it("gives prefix:slug and decodes the slug", () => {
    expect(nodeOfIri("https://cortex.local/id/rule/decks-001")).toBe("rule:decks-001");
    expect(nodeOfIri("https://cortex.local/id/memory/a%20b")).toBe("memory:a b");
    expect(nodeOfIri("https://cortex.local/id/memory/a%ZZ")).toBe("memory:a%ZZ");
    expect(nodeOfIri("https://cortex.local/ont#Rule")).toBeNull();
    expect(nodeOfIri("https://cortex.local/id/rule")).toBeNull();
  });

  it("marks node terms in SELECT and CONSTRUCT results and leaves other terms alone", async () => {
    const s = service(dataDir(`${iri("rule", "decks-001")} a cx:Rule ;\n  rdfs:label "One" ;\n  cx:governs ${iri("memory", "a%20b")} .\n`));
    const sel = await s.query("PREFIX cx: <https://cortex.local/ont#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> SELECT ?r ?c ?l ?g WHERE { ?r a ?c ; rdfs:label ?l ; cx:governs ?g }");
    if (sel.kind !== "select") throw new Error("not select");
    expect(sel.rows).toHaveLength(1);
    expect(sel.rows[0].r).toEqual({ type: "uri", value: "https://cortex.local/id/rule/decks-001", node: "rule:decks-001" });
    expect(sel.rows[0].g.node).toBe("memory:a b");
    expect(sel.rows[0].c).toEqual({ type: "uri", value: "https://cortex.local/ont#Rule" });
    expect(sel.rows[0].l).toEqual({ type: "literal", value: "One" });
    const con = await s.query("CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }");
    if (con.kind !== "construct") throw new Error("not construct");
    expect(con.triples).toHaveLength(3);
    expect(con.triples.some((t) => t[0].node === "rule:decks-001")).toBe(true);
    const ask = await s.query("ASK { ?s ?p ?o }");
    expect(ask).toMatchObject({ kind: "ask", value: true });
    expect(ask.ms).toBeGreaterThanOrEqual(0);
  });
});

describe("the row cap", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `${iri("rule", `r${i}`)} a cx:Rule .`).join("\n") + "\n";

  it("returns 5,000 rows without truncation and cuts 5,001 to 5,000 with truncated true", async () => {
    const at = service(dataDir(many(5000)));
    const a = await at.query("SELECT ?s WHERE { ?s a ?c }");
    if (a.kind !== "select") throw new Error("not select");
    expect(a.rows).toHaveLength(5000);
    expect(a.truncated).toBe(false);

    const over = service(dataDir(many(5001)));
    const b = await over.query("SELECT ?s WHERE { ?s a ?c }");
    if (b.kind !== "select") throw new Error("not select");
    expect(b.rows).toHaveLength(5000);
    expect(b.truncated).toBe(true);
    const c = await over.query("CONSTRUCT { ?s a ?c } WHERE { ?s a ?c }");
    if (c.kind !== "construct") throw new Error("not construct");
    expect(c.triples).toHaveLength(5000);
    expect(c.truncated).toBe(true);
  });

  it("honours a smaller cap", async () => {
    const s = service(dataDir(many(12)), { maxRows: 5 });
    const r = await s.query("SELECT ?s WHERE { ?s a ?c }");
    if (r.kind !== "select") throw new Error("not select");
    expect(r.rows).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });
});

describe("loading and the reload swap", () => {
  const count = async (s: SparqlService) => {
    const r = await s.query("SELECT ?s WHERE { ?s a <https://cortex.local/ont#Rule> }");
    if (r.kind !== "select") throw new Error("not select");
    return r.rows.length;
  };

  it("loads graph.ttl and inferred.ttl together, and copes when inferred.ttl is missing", async () => {
    const both = service(dataDir(`${iri("rule", "a")} a cx:Rule .\n`, `${iri("rule", "b")} a cx:Rule .\n`));
    expect(await count(both)).toBe(2);
    const alone = service(dataDir(`${iri("rule", "a")} a cx:Rule .\n`));
    expect(await count(alone)).toBe(1);
  });

  it("answers from the old store while a new one loads, then swaps", async () => {
    const dir = dataDir(`${iri("rule", "a")} a cx:Rule .\n`);
    const s = service(dir);
    expect(await count(s)).toBe(1);
    fs.writeFileSync(path.join(dir, "graph.ttl"), HEAD + `${iri("rule", "a")} a cx:Rule .\n${iri("rule", "b")} a cx:Rule .\n${iri("rule", "c")} a cx:Rule .\n`);
    const reloading = s.reload();
    expect(await count(s)).toBe(1);
    await reloading;
    expect(await count(s)).toBe(3);
  });

  it("keeps the old store when the new file cannot be parsed", async () => {
    const dir = dataDir(`${iri("rule", "a")} a cx:Rule .\n`);
    const s = service(dir);
    expect(await count(s)).toBe(1);
    fs.writeFileSync(path.join(dir, "graph.ttl"), "this is not turtle {{{");
    await s.reload();
    expect(await count(s)).toBe(1);
  });
});

describe("the timeout", () => {
  it("stops a slow query with a 408, then answers the next query", async () => {
    const triples = Array.from({ length: 150 }, (_, i) => `${iri("rule", `r${i}`)} a cx:Rule .`).join("\n") + "\n";
    const s = service(dataDir(triples), { timeoutMs: 600 });
    await s.whenReady();
    const t0 = Date.now();
    const e = await rejects(s.query("SELECT * WHERE { ?a ?b ?c . ?d ?e ?f . ?g ?h ?i . ?j ?k ?l }"));
    expect(e.status).toBe(408);
    expect(e.message).toMatch(/stopped/);
    expect(Date.now() - t0).toBeLessThan(5000);
    const r = await s.query("SELECT ?s WHERE { ?s a ?c } LIMIT 3");
    if (r.kind !== "select") throw new Error("not select");
    expect(r.rows).toHaveLength(3);
  }, 20000);
});

describe("the saved-query loader", () => {
  it("uses the file stem as the id and the first comment line as the title, in name order", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-rq-"));
    dirs.push(d);
    fs.writeFileSync(path.join(d, "b-second.rq"), "# Second query\r\nSELECT * WHERE { ?s ?p ?o }\r\n");
    fs.writeFileSync(path.join(d, "a-first.rq"), "\n#   First query  \nSELECT * WHERE { ?s ?p ?o }\n");
    fs.writeFileSync(path.join(d, "c-untitled.rq"), "SELECT * WHERE { ?s ?p ?o }\n");
    fs.writeFileSync(path.join(d, "README.md"), "# not a query\n");
    const q = loadSavedQueries(d);
    expect(q.map((x) => x.id)).toEqual(["a-first", "b-second", "c-untitled"]);
    expect(q.map((x) => x.title)).toEqual(["First query", "Second query", "c-untitled"]);
    expect(q[1].query).not.toContain("\r");
  });

  it("returns an empty list when the folder does not exist", () => {
    expect(loadSavedQueries(path.join(os.tmpdir(), "cortex-no-such-folder"))).toEqual([]);
  });

  it("loads the 10 saved queries of the repository, each with a title and a read-only form", () => {
    const q = loadSavedQueries(path.join(import.meta.dirname, "..", "..", "ontology", "queries"));
    expect(q).toHaveLength(10);
    for (const x of q) {
      expect(x.title).not.toBe(x.id);
      expect(() => classify(x.query)).not.toThrow();
      expect(x.query).toContain("PREFIX cx: <https://cortex.local/ont#>");
    }
  });
});
