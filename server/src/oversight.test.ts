// The oversight routes against a fake compiler: role refusals, the actor taken from the configuration, the demonstration header and the route shapes.
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, type Config } from "./config.ts";
import { createApp, type App } from "./main.ts";

let root = "";
let data = "";
let calls = "";

// The fake compiler logs its arguments and the text file of a draft, keeps the ratified mappings in a file and answers each view command.
const FAKE = `
import fs from "node:fs";
const args = process.argv.slice(2);
const log = process.env.FAKE_KG_LOG;
const state = process.env.FAKE_KG_STATE;
fs.appendFileSync(log, args.join(" ") + "\\n");
const flag = (n) => { const a = args.find((x) => x.startsWith("--" + n + "=")); return a ? a.slice(n.length + 3) : null; };
const out = (v) => console.log(JSON.stringify(v));
const done = () => (fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : {});
const mapping = (id, maker, status) => ({ id, relation: "realises", s: "clause:a", t: "control:b", status, basis: "b", origin: "reviewer", owner: "person:" + maker, maker, checker: null, valid_from: null, valid_to: null, anchors: { s_hash: null, t_hash: null }, reason: null, superseded_by: null, history: [] });
const [a, b] = args;
if (a === "oversight" && b === "runs") out([{ run: "run:r1", agent: "dagent:x", case_ref: "A-1", ts: "2026-10-01T09:00:00Z", outcome: "close", reviewed: true, override: false, findings: 0, replayable: true }]);
else if (a === "oversight" && b === "trace") { if (args[2] === "run:none") { out({ error: "No run matches run:none." }); process.exit(2); } out({ run: args[2], steps: [], chains: {}, findings: [] }); }
else if (a === "oversight" && b === "coverage") out({ agent: flag("agent"), columns: [], rows: [], findings: [] });
else if (a === "oversight" && b === "instructions") out([{ id: "instr:x-a", label: "A", agent: "dagent:x", file: "a.md", versions: 2, latest: "instr:x-a-v2", in_force: "instr:x-a-v1", findings: 0 }]);
else if (a === "oversight" && b === "instruction") out({ id: args[2], label: "A", agent: "dagent:x", file: "a.md", versions: [{ id: args[2] + "-v1", version: 1, status: "approved", maker: "ana-reyes", in_force: true, history: [] }, { id: args[2] + "-v2", version: 2, status: done().v2 ? "approved" : "draft", maker: "dan-ng", in_force: false, history: [] }], diff: null, mappings: [], findings: [], impact: { stale_mappings: [], decisions: [] } });
else if (a === "mappings" && b === "list") { const d = done(); out([mapping("map:1", "ana-reyes", d["map:1"] ? "ratified" : "proposed"), mapping("map:2", "dan-ng", d["map:2"] ? "ratified" : "proposed"), mapping("map:3", "bob-chen", "proposed")]); }
else if (a === "mappings" && ["ratify", "reject", "reassign"].includes(b)) { const d = done(); d[args[2]] = b; fs.writeFileSync(state, JSON.stringify(d)); out({ ok: true }); }
else if (a === "instructions" && args[1] === "draft") { fs.appendFileSync(log, "TEXT " + fs.readFileSync(flag("text-file"), "utf8") + "\\n"); out({ ok: true }); }
else if (a === "instructions" && args[1] === "approve") { fs.writeFileSync(state, JSON.stringify({ ...done(), v2: true })); out({ ok: true }); }
else if (a === "monitor") { if (flag("agent") === "dagent:findings") { out({ from: null, to: null, agents: [], findings: [{ check: "O13" }] }); process.exit(1); } out({ from: flag("from"), to: flag("to"), agents: [], findings: [] }); }
else if (a === "sample" && b === "draw") out({ v: 1, id: "sample-1", agent: flag("agent"), requested: Number(flag("size")), size: Number(flag("size")), seed: flag("seed") ? Number(flag("seed")) : null, risk_weighted: args.includes("--risk-weighted"), pool: 3, drawn_by: flag("by"), drawn_at: "2026-10-07T10:00:00Z", runs: [] });
else if (a === "sample" && b === "verdict") out({ v: 1, id: args[2], runs: [{ run: args[3], verdict: flag("verdict"), reason: flag("reason") }] });
else if (a === "pack") out({ path: "P/pack-1", manifest: { v: 1, created: "2026-10-07T10:00:00Z", files: [{ path: "pack.json", sha256: "ab", bytes: 3 }] } });
else if (a === "build" || a === "check") { /* rebuilt */ }
else { console.error("unexpected " + args.join(" ")); process.exit(1); }
`;

const PEOPLE = {
  v: 1,
  people: [
    { id: "ana-reyes", name: "Ana Reyes", roles: ["maker"] },
    { id: "bob-chen", name: "Bob Chen", roles: ["checker", "approver", "reviewer"] },
    { id: "dan-ng", name: "Dan Ng", roles: ["maker", "approver"] },
    { id: "eve-ward", name: "Eve Ward", roles: ["viewer"] },
  ],
};
const GRAPH = { v: 1, built: "2026-10-07T10:00:00Z", nodes: [], edges: [], relations: {}, stats: { nodes: 0, edges: 0, by_class: {} }, health: { errors: 0, warnings: 0, infos: 0, checked: "" } };

interface Run {
  base: string;
  app: App;
  get: (url: string, headers?: Record<string, string>) => Promise<Response>;
  post: (url: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
}
const running: App[] = [];

async function start(over: Partial<Config>): Promise<Run> {
  const cfg: Config = {
    claude_home: `${root}/claude`,
    projects_root: null,
    memory_dir: "auto",
    data_dir: data,
    port: 0,
    python_cmd: "python",
    include_sensitivity: ["public", "internal", "client-confidential"],
    log_prompt_snippets: false,
    repo_root: REPO_ROOT,
    product: "ranviera",
    version: "9.9.9",
    kg_cmd: [process.execPath, `${root}/fake-kg.mjs`],
    profile_dir: `${root}/profile`,
    oversight_people: `${root}/profile/people.json`,
    ...over,
  };
  const app = await createApp(cfg, false);
  running.push(app);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  cfg.port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${cfg.port}`;
  return {
    base,
    app,
    get: (url, headers = {}) => fetch(base + url, { headers }),
    post: (url, body = {}, headers = {}) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
  };
}

const logged = () => fs.readFileSync(calls, "utf8").split("\n").filter(Boolean);
const reset = () => {
  fs.writeFileSync(calls, "");
  fs.rmSync(`${root}/state.json`, { force: true });
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ranviera-oversight-")).replace(/\\/g, "/");
  data = `${root}/data`;
  fs.mkdirSync(`${data}/runs`, { recursive: true });
  fs.mkdirSync(`${root}/profile`, { recursive: true });
  fs.writeFileSync(`${data}/graph.json`, JSON.stringify(GRAPH));
  fs.writeFileSync(`${data}/graph.ttl`, "");
  fs.writeFileSync(`${root}/profile/people.json`, JSON.stringify(PEOPLE));
  fs.writeFileSync(`${root}/fake-kg.mjs`, FAKE);
  calls = `${root}/calls.log`;
  process.env.FAKE_KG_LOG = calls;
  process.env.FAKE_KG_STATE = `${root}/state.json`;
  fs.writeFileSync(calls, "");
});

afterAll(async () => {
  for (const a of running) await a.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("status", () => {
  it("reports the actor of the configuration, the people and whether a store is loaded", async () => {
    const r = await start({ oversight_actor: "ana-reyes" });
    expect(await (await r.get("/api/oversight/status")).json()).toMatchObject({ available: false, actor: "ana-reyes", demo: false });
    fs.writeFileSync(`${data}/runs/r1.json`, "{}");
    const s = (await (await r.get("/api/oversight/status")).json()) as { available: boolean; people: { id: string }[] };
    expect(s.available).toBe(true);
    expect(s.people.map((p) => p.id)).toEqual(["ana-reyes", "bob-chen", "dan-ng", "eve-ward"]);
  });

  it("reports no actor and no people where nothing is configured", async () => {
    const r = await start({ oversight_people: null });
    expect(await (await r.get("/api/oversight/status")).json()).toMatchObject({ actor: null, people: [], demo: false });
  });

  it("ignores the demonstration header when demo is off", async () => {
    const r = await start({ oversight_actor: "bob-chen", oversight_demo: false });
    const s = await (await r.get("/api/oversight/status", { "x-ranviera-actor": "eve-ward" })).json();
    expect(s).toMatchObject({ actor: "bob-chen", demo: false });
    reset();
    // bob-chen made map:3, so the refusal that names the maker proves that the header of eve-ward was not used
    const res = await r.post("/api/oversight/mappings/map:3/ratify", {}, { "x-ranviera-actor": "eve-ward" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("The maker of a mapping may not ratify it.");
    expect(logged().some((l) => l.startsWith("mappings ratify"))).toBe(false);
  });

  it("lets the header select a person of the people file when demo is on", async () => {
    const r = await start({ oversight_actor: "ana-reyes", oversight_demo: true });
    expect(await (await r.get("/api/oversight/status", { "x-ranviera-actor": "bob-chen" })).json()).toMatchObject({ actor: "bob-chen", demo: true });
    expect(await (await r.get("/api/oversight/status", { "x-ranviera-actor": "nobody" })).json()).toMatchObject({ actor: "ana-reyes" });
    reset();
    expect((await r.post("/api/oversight/mappings/map:1/ratify", {}, { "x-ranviera-actor": "bob-chen" })).status).toBe(200);
    expect(logged()).toContain("mappings ratify map:1 --by=bob-chen --json");
    const unknown = await r.post("/api/oversight/mappings/map:2/ratify", {}, { "x-ranviera-actor": "nobody" });
    expect(unknown.status).toBe(403);
    expect(((await unknown.json()) as { error: string }).error).toContain("is not in the people file");
  });
});

describe("the actor of a write", () => {
  it("comes from the configuration and never from the body", async () => {
    const r = await start({ oversight_actor: "bob-chen" });
    reset();
    const res = await r.post("/api/oversight/mappings/map:1/ratify", { by: "ana-reyes", actor: "ana-reyes", maker: "bob-chen" });
    expect(res.status).toBe(200);
    expect(logged()).toContain("mappings ratify map:1 --by=bob-chen --json");
    expect(logged().some((l) => l.includes("ana-reyes") && l.startsWith("mappings ratify"))).toBe(false);
  });

  it("is refused where the configuration names nobody", async () => {
    const r = await start({ oversight_actor: null });
    const res = await r.post("/api/oversight/mappings/map:1/ratify", { by: "bob-chen" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("No person is set as the actor of this installation, so no write is allowed.");
  });

  it("is refused where no people file is configured", async () => {
    const r = await start({ oversight_actor: "bob-chen", oversight_people: null });
    const res = await r.post("/api/oversight/samples", { agent: "dagent:x", size: 2 });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("No people file is configured, so no write is allowed.");
  });
});

describe("role refusals", () => {
  it("names the rule for each refused write and calls no command", async () => {
    const asAna = await start({ oversight_actor: "ana-reyes" });
    const asBob = await start({ oversight_actor: "bob-chen" });
    const asEve = await start({ oversight_actor: "eve-ward" });
    const asDan = await start({ oversight_actor: "dan-ng" });
    reset();
    const refused = async (r: Run, url: string, body: unknown, sentence: string) => {
      const res = await r.post(url, body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(sentence);
    };
    await refused(asBob, "/api/oversight/mappings/map:3/ratify", {}, "The maker of a mapping may not ratify it.");
    await refused(asBob, "/api/oversight/mappings/map:3/reject", { reason: "x" }, "The maker of a mapping may not reject it.");
    await refused(asAna, "/api/oversight/mappings/map:1/reject", { reason: "x" }, "Ana Reyes does not hold the role checker, which rejecting a mapping needs.");
    await refused(asAna, "/api/oversight/mappings/map:1/reassign", { owner: "person:bob-chen" }, "Ana Reyes does not hold the role checker, which reassigning a mapping needs.");
    await refused(asEve, "/api/oversight/instructions/instr:x-a/draft", { text: "t" }, "Eve Ward does not hold the role maker, which drafting an instruction needs.");
    await refused(asDan, "/api/oversight/versions/instr:x-a-v2/approve", {}, "The maker of an instruction version may not approve it.");
    await refused(asAna, "/api/oversight/versions/instr:x-a-v1/approve", {}, "Ana Reyes does not hold the role approver, which approving an instruction version needs.");
    await refused(asAna, "/api/oversight/samples", { agent: "dagent:x", size: 2 }, "Ana Reyes does not hold the role reviewer, which drawing a sample needs.");
    await refused(asAna, "/api/oversight/samples/sample-1/verdict", { run: "run:r1", verdict: "agree" }, "Ana Reyes does not hold the role reviewer, which recording a verdict on a sample needs.");
    const wrote = logged().filter((l) => /^(mappings (ratify|reject|reassign)|instructions|sample|build|check)/.test(l));
    expect(wrote).toEqual([]);
  });
});

describe("writes", () => {
  it("ratifies, rebuilds and returns the updated mapping", async () => {
    const r = await start({ oversight_actor: "bob-chen" });
    reset();
    const res = await r.post("/api/oversight/mappings/map:1/ratify", { note: "Checked against the clause." });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "map:1", status: "ratified" });
    const l = logged();
    const at = (s: string) => l.findIndex((x) => x.startsWith(s));
    expect(l[at("mappings ratify")]).toBe("mappings ratify map:1 --by=bob-chen --json --note=Checked against the clause.");
    expect(at("build")).toBeGreaterThan(at("mappings ratify"));
    expect(at("check")).toBeGreaterThan(at("build"));
  });

  it("needs a reason to reject and an owner to reassign, and reports an unknown mapping", async () => {
    const r = await start({ oversight_actor: "bob-chen" });
    const noReason = await r.post("/api/oversight/mappings/map:1/reject", {});
    expect(noReason.status).toBe(400);
    expect(((await noReason.json()) as { error: string }).error).toBe("A rejection needs a reason.");
    expect((await r.post("/api/oversight/mappings/map:1/reassign", {})).status).toBe(400);
    const none = await r.post("/api/oversight/mappings/map:9/ratify", {});
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: string }).error).toBe("There is no mapping with the id map:9.");
    expect((await r.post("/api/oversight/mappings/map:1/reject", { reason: "The clause was withdrawn." })).status).toBe(200);
    expect((await r.post("/api/oversight/mappings/map:2/reassign", { owner: "person:bob-chen" })).status).toBe(200);
    expect(logged()).toContain("mappings reject map:1 --by=bob-chen --json --reason=The clause was withdrawn.");
  });

  it("passes the text of a draft by file and returns the instruction", async () => {
    const r = await start({ oversight_actor: "ana-reyes" });
    reset();
    const res = await r.post("/api/oversight/instructions/instr:x-a/draft", { text: "Escalate every match.\nSecond line." });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "instr:x-a" });
    const l = logged();
    expect(l.some((x) => x.startsWith("instructions draft instr:x-a --text-file=") && x.endsWith("--by=ana-reyes --json"))).toBe(true);
    expect(l.join("\n")).toContain("TEXT Escalate every match.");
    expect((await r.post("/api/oversight/instructions/instr:x-a/draft", { text: "  " })).status).toBe(400);
  });

  it("approves a version that another person made", async () => {
    const r = await start({ oversight_actor: "bob-chen" });
    reset();
    const res = await r.post("/api/oversight/versions/instr:x-a-v2/approve");
    expect(res.status).toBe(200);
    expect(logged()).toContain("instructions approve instr:x-a-v2 --by=bob-chen --json");
    expect((await res.json()) as { versions: { id: string; status: string }[] }).toMatchObject({ versions: [{}, { id: "instr:x-a-v2", status: "approved" }] });
    expect((await r.post("/api/oversight/versions/nonsense/approve")).status).toBe(400);
  });

  it("draws a sample and records a verdict", async () => {
    const r = await start({ oversight_actor: "bob-chen" });
    reset();
    const d = await r.post("/api/oversight/samples", { agent: "dagent:x", size: 5, seed: 7, risk_weighted: true });
    expect(d.status).toBe(200);
    expect(await d.json()).toMatchObject({ id: "sample-1", size: 5, seed: 7, risk_weighted: true, drawn_by: "bob-chen" });
    expect((await r.post("/api/oversight/samples", { agent: "dagent:x", size: 0 })).status).toBe(400);
    expect((await r.post("/api/oversight/samples", { agent: "--bad", size: 2 })).status).toBe(400);
    const v = await r.post("/api/oversight/samples/sample-1/verdict", { run: "run:r1", verdict: "disagree", reason: "Missed a match." });
    expect(v.status).toBe(200);
    expect(logged()).toContain("sample verdict sample-1 run:r1 --verdict=disagree --by=bob-chen --json --reason=Missed a match.");
    expect((await r.post("/api/oversight/samples/sample-1/verdict", { run: "run:r1", verdict: "maybe" })).status).toBe(400);
  });
});

describe("reads", () => {
  it("passes the views through with their filters", async () => {
    const r = await start({ oversight_actor: "bob-chen" });
    reset();
    const runs = (await (await r.get("/api/oversight/runs?agent=dagent:x&outcome=close")).json()) as { run: string }[];
    expect(runs[0].run).toBe("run:r1");
    expect(logged()).toContain("oversight runs --json --agent=dagent:x --outcome=close");
    expect(await (await r.get("/api/oversight/trace/run:r1")).json()).toMatchObject({ run: "run:r1" });
    expect(await (await r.get("/api/oversight/coverage?agent=dagent:x")).json()).toMatchObject({ agent: "dagent:x" });
    expect(((await (await r.get("/api/oversight/mappings?status=proposed&stale=1")).json()) as unknown[]).length).toBe(3);
    expect(logged()).toContain("mappings list --json --status=proposed --stale");
    expect(await (await r.get("/api/oversight/instructions")).json()).toMatchObject([{ id: "instr:x-a", versions: 2 }]);
    expect(await (await r.get("/api/oversight/instructions/instr:x-a")).json()).toMatchObject({ id: "instr:x-a", diff: null });
    expect(await (await r.get("/api/oversight/monitoring?from=2026-10-01&to=2026-10-07")).json()).toMatchObject({ from: "2026-10-01", to: "2026-10-07" });
  });

  it("returns a report that the compiler marks with exit code 1 because it holds findings", async () => {
    const r = await start({ oversight_actor: "bob-chen" });
    const res = await r.get("/api/oversight/monitoring?agent=dagent:findings");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ findings: [{ check: "O13" }] });
  });

  it("answers a refusal of the compiler with its sentence and the status 404 or 400", async () => {
    const r = await start({ oversight_actor: "bob-chen" });
    const none = await r.get("/api/oversight/trace/run:none");
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: string }).error).toBe("No run matches run:none.");
    expect((await r.get("/api/oversight/trace/-x")).status).toBe(400);
    expect((await r.get("/api/oversight/runs?outcome=maybe")).status).toBe(400);
    expect((await r.get("/api/oversight/monitoring?from=yesterday")).status).toBe(400);
    expect((await r.get("/api/oversight/nothing")).status).toBe(404);
    expect((await r.post("/api/oversight/runs")).status).toBe(405);
  });

  it("exports an evidence pack for a valid scope only", async () => {
    const r = await start({ oversight_actor: "bob-chen" });
    const ok = await r.post("/api/oversight/pack", { scope: "period:2026-10-01..2026-10-07" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ path: "P/pack-1", manifest: { v: 1 } });
    expect(logged()).toContain("pack export --scope=period:2026-10-01..2026-10-07 --json");
    const bad = await r.post("/api/oversight/pack", { scope: "everything" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("The scope must be alert:ID, run:ID, agent:ID or period:FROM..TO.");
  });

  it("reads a file of a written pack by folder and file name only", async () => {
    const r = await start({ oversight_actor: "bob-chen" });
    const dir = path.join(data, "packs", "pack-run-r1-20261013-090000");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pack.html"), "<p>Pack</p>", "utf8");
    const ok = await r.get("/api/oversight/pack-file?folder=pack-run-r1-20261013-090000&file=pack.html");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ file: "pack.html", text: "<p>Pack</p>" });
    expect((await r.get("/api/oversight/pack-file?folder=..&file=pack.html")).status).toBe(400);
    expect((await r.get("/api/oversight/pack-file?folder=pack-run-r1-20261013-090000&file=../../graph.json")).status).toBe(400);
    expect((await r.get("/api/oversight/pack-file?folder=pack-none&file=pack.json")).status).toBe(404);
  });
});
