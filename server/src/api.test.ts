// The HTTP layer over a real socket: host and origin checks, read-only SPARQL, /api/open refusals, the plan check and the stale flag.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, type Config } from "./config.ts";
import { createApp, type App } from "./main.ts";

let app: App;
let base = "";
let port = 0;
let root = "";

const GRAPH = { v: 1, built: "2026-10-06T10:00:00Z", nodes: [], edges: [], relations: {}, stats: { nodes: 0, edges: 0, by_class: {} }, health: { errors: 0, warnings: 0, infos: 0, checked: "" } };
const HEALTH = (built: string) => JSON.stringify({ v: 1, checked: "x", graph_built: built, counts: { violation: 0, warning: 0, info: 0 }, findings: [] });

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-api-"));
  const data = path.join(root, "data");
  fs.mkdirSync(data);
  fs.mkdirSync(path.join(root, "projects"));
  fs.writeFileSync(path.join(root, "projects", "run.pyw"), "print(1)");
  fs.writeFileSync(path.join(data, "graph.json"), JSON.stringify(GRAPH));
  fs.writeFileSync(path.join(data, "graph.ttl"), "");
  fs.writeFileSync(path.join(data, "health.json"), HEALTH("2026-10-05T00:00:00Z"));
  const cfg: Config = {
    claude_home: path.join(root, "claude"),
    projects_root: path.join(root, "projects"),
    memory_dir: path.join(root, "memory"),
    data_dir: data,
    port: 0,
    python_cmd: "python",
    include_sensitivity: ["public", "internal", "client-confidential"],
    log_prompt_snippets: false,
    repo_root: REPO_ROOT,
  };
  app = await createApp(cfg, false);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  port = (app.server.address() as AddressInfo).port;
  // the host check reads the port from the configuration, so it is set once the server has one
  cfg.port = port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("host and origin enforcement", () => {
  it("refuses a Host header that is not localhost", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/api/status", headers: { host: "evil.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject);
    });
    expect(status).toBe(403);
  });

  it("refuses a POST from another origin and accepts one from the same origin", async () => {
    expect((await post("/api/sparql", { query: "ASK { ?s ?p ?o }" }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await post("/api/sparql", { query: "ASK { ?s ?p ?o }" }, { origin: base })).status).toBe(200);
  });
});

describe("routes", () => {
  it("refuses a SPARQL update with a 400", async () => {
    const r = await post("/api/sparql", { query: "DROP ALL" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/read-only/);
  });

  it("opens only documents under the allowed folders", async () => {
    expect((await post("/api/open", { path: path.join(root, "projects", "run.pyw") })).status).toBe(403);
    expect((await post("/api/open", { path: path.join(root, "data", "graph.json") })).status).toBe(403);
    expect((await post("/api/open", { path: path.join(root, "projects", "missing.md") })).status).toBe(404);
  });

  it("checks the shape of a given plan, the agent name and the load paths", async () => {
    // the shape check comes after consent and sign-in, so both are given here
    fs.writeFileSync(path.join(root, "data", "setup.json"), JSON.stringify({ missions_consent_at: "2026-10-06T10:00:00Z" }));
    app.ctx.claude = (args) => Promise.resolve({ stdout: args[0] === "auth" ? JSON.stringify({ loggedIn: true }) : "2.0.0", code: 0 });
    const plan = (over: object) => ({ prompt_hash: "h", task_types: [], entities: [], fire: [], load: [], steps: [{ agent: "main", purpose: "x" }], gates: [], cautions: [], ...over });
    expect((await post("/api/missions", { prompt: "do it", plan: plan({ steps: [{ agent: "--dangerously-skip-permissions", purpose: "x" }] }) })).status).toBe(400);
    expect((await post("/api/missions", { prompt: "do it", plan: plan({ load: [{ path: "C:/Windows/win.ini", node: "n", reason: "r" }] }) })).status).toBe(400);
    expect((await post("/api/missions", { prompt: "do it", plan: { steps: [] } })).status).toBe(400);
  });

  it("marks the health report stale when it describes another build", async () => {
    const h = (await (await fetch(`${base}/api/health`)).json()) as { stale?: boolean };
    expect(h.stale).toBe(true);
    fs.writeFileSync(path.join(root, "data", "health.json"), HEALTH(GRAPH.built));
    const again = (await (await fetch(`${base}/api/health`)).json()) as { stale?: boolean };
    expect(again.stale).toBeUndefined();
  });
});
