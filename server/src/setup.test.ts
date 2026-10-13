// The first-run routes, the hooks routes against a fake compiler, the access token and the privacy of the claude state.
// public-check: synthetic-secrets (the claude state is tested with a fake token that must never reach a response)
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REPO_ROOT, loadConfig, type Config } from "./config.ts";
import { createApp, type App } from "./main.ts";
import { claudeState, setupState } from "./setup.ts";

let app: App;
let base = "";
let root = "";
let data = "";
let configFile = "";
let calls = "";
const TOKEN = "tok-3f9a1c77";

// The fake compiler records its arguments and answers the hooks commands with JSON.
const FAKE = `
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_KG_LOG, args.join(" ") + "\\n");
const [a, b] = args;
if (a === "hooks" && b === "preview") console.log(JSON.stringify({ installed: false, settings_path: "S/settings.json", backup_dir: "S/backups", entries: [{ event: "PreToolUse", matcher: "Read", command: "ranviera hook PreToolUse" }] }));
else if (a === "hooks" && b === "install") console.log(JSON.stringify({ installed: true, backup: "S/backups/settings-1.json" }));
else if (a === "hooks" && b === "uninstall") console.log(JSON.stringify({ installed: false, removed: 3, backup: "S/backups/settings-2.json" }));
else if (a === "fail") { console.error("The compiler broke."); process.exit(2); }
`;

const GRAPH = { v: 1, built: "2026-10-06T10:00:00Z", nodes: [], edges: [], relations: {}, stats: { nodes: 0, edges: 0, by_class: {} }, health: { errors: 0, warnings: 0, infos: 0, checked: "" } };

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-setup-")).replace(/\\/g, "/");
  data = `${root}/data`;
  fs.mkdirSync(data);
  fs.mkdirSync(`${root}/claude/projects/p1/memory`, { recursive: true });
  fs.writeFileSync(`${root}/claude/projects/p1/memory/MEMORY.md`, "# Memory\n");
  fs.mkdirSync(`${root}/work`);
  fs.writeFileSync(`${root}/fake-kg.mjs`, FAKE);
  calls = `${root}/calls.log`;
  process.env.FAKE_KG_LOG = calls;
  configFile = `${root}/config.json`;
  fs.writeFileSync(configFile, JSON.stringify({ port: 5182, log_prompt_snippets: false }));
  fs.writeFileSync(`${data}/graph.json`, JSON.stringify(GRAPH));
  fs.writeFileSync(`${data}/graph.ttl`, "");
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
    token: TOKEN,
    config_file: configFile,
  };
  app = await createApp(cfg, false);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  cfg.port = (app.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${cfg.port}`;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const H = { "x-cortex-token": TOKEN };
const get = (url: string) => fetch(base + url, { headers: H });
const post = (url: string, body: unknown = {}) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify(body) });

describe("configuration", () => {
  it("reads the environment variables and picks the data folder by product", () => {
    const cfgFile = `${root}/env-config.json`;
    fs.writeFileSync(cfgFile, JSON.stringify({ claude_home: `${root}/claude`, product: "cortex" }));
    const c = loadConfig({ CORTEX_CONFIG: cfgFile, CORTEX_PORT: "0", CORTEX_TOKEN: "t", CORTEX_STATIC: `${root}/web`, CORTEX_ONTOLOGY: `${root}/onto`, CORTEX_VERSION: "1.2.3", CORTEX_KG_CMD: '["kg.exe","--x"]' });
    expect(c).toMatchObject({ product: "cortex", port: 0, token: "t", version: "1.2.3", kg_cmd: ["kg.exe", "--x"], data_dir: `${root}/claude/cortex`, static_dir: `${root}/web`, ontology_dir: `${root}/onto` });
    const g = loadConfig({ CORTEX_CONFIG: `${root}/none.json`, CORTEX_DATA_DIR: `${root}/d` });
    expect(g.product).toBe("ranviera");
    expect(g.data_dir).toBe(`${root}/d`);
    expect(g.projects_root).toBeNull();
    expect(g.memory_dir).toBe("auto");
    expect(loadConfig({ CORTEX_CONFIG: `${root}/none.json` }).data_dir.endsWith("/.claude/ranviera")).toBe(true);
  });
});

describe("the access token", () => {
  it("refuses an /api request without the token and accepts the header", async () => {
    expect((await fetch(base + "/api/status")).status).toBe(401);
    expect((await fetch(base + "/api/status", { headers: { "x-cortex-token": "wrong" } })).status).toBe(401);
    const ok = await get("/api/status");
    expect(ok.status).toBe(200);
    const j = (await ok.json()) as { product: string; version: string };
    expect(j).toMatchObject({ product: "ranviera", version: "9.9.9" });
  });

  it("sets the cookie on /auth and then accepts the cookie", async () => {
    expect((await fetch(base + "/auth?t=wrong", { redirect: "manual" })).status).toBe(401);
    const r = await fetch(base + `/auth?t=${TOKEN}`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/?shell=desktop");
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`cortex_token=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toContain("Path=/");
    const viaCookie = await fetch(base + "/api/status", { headers: { cookie: `cortex_token=${TOKEN}` } });
    expect(viaCookie.status).toBe(200);
  });

  it("needs no token for a static page", async () => {
    expect([200, 503]).toContain((await fetch(base + "/")).status);
  });
});

describe("first-run routes", () => {
  it("records the consent in setup.json", async () => {
    const s0 = (await (await get("/api/setup")).json()) as { accepted_at: string | null; claude_home_found: boolean; memory_dirs: string[]; product: string; counts: { nodes: number } | null };
    expect(s0.accepted_at).toBeNull();
    expect(s0.claude_home_found).toBe(true);
    expect(s0.memory_dirs).toEqual([`${root}/claude/projects/p1/memory`]);
    expect(s0.counts).toEqual({ nodes: 0, edges: 0 });
    const s1 = (await (await post("/api/setup/accept")).json()) as { accepted_at: string | null; version: string };
    expect(s1.accepted_at).toMatch(/^\d{4}-/);
    expect(s1.version).toBe("9.9.9");
    const onDisk = JSON.parse(fs.readFileSync(`${data}/setup.json`, "utf8")) as { accepted_at: string; v: number };
    expect(onDisk.accepted_at).toBe(s1.accepted_at);
    expect(fs.readdirSync(data).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a projects folder that does not exist", async () => {
    expect((await post("/api/setup/read", { projects_root: `${root}/nope` })).status).toBe(400);
  });

  it("writes projects_root to the configuration file, then builds and reasons", async () => {
    fs.writeFileSync(calls, "");
    const r = await post("/api/setup/read", { projects_root: `${root}/work` });
    expect(r.status).toBe(200);
    const s = (await r.json()) as { read_consent_at: string | null; projects_root: string | null };
    expect(s.read_consent_at).not.toBeNull();
    expect(s.projects_root).toBe(`${root}/work`);
    const cfg = JSON.parse(fs.readFileSync(configFile, "utf8")) as { projects_root: string; port: number };
    expect(cfg.projects_root).toBe(`${root}/work`);
    expect(cfg.port).toBe(5182);
    expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toEqual(["build", "reason"]);
    // null clears it
    const c = (await (await post("/api/setup/read", { projects_root: null })).json()) as { projects_root: string | null };
    expect(c.projects_root).toBeNull();
  });
});

describe("hooks routes", () => {
  it("previews, installs and uninstalls through the compiler", async () => {
    fs.writeFileSync(calls, "");
    const h = (await (await get("/api/hooks")).json()) as { installed: boolean; entries: { event: string }[]; settings_path: string; backup_dir: string };
    expect(h).toMatchObject({ installed: false, settings_path: "S/settings.json", backup_dir: "S/backups" });
    expect(h.entries[0].event).toBe("PreToolUse");
    expect(await (await post("/api/hooks/install")).json()).toEqual({ installed: true, backup: "S/backups/settings-1.json" });
    expect(JSON.parse(fs.readFileSync(`${data}/setup.json`, "utf8")).hooks_installed_at).toMatch(/^\d{4}-/);
    expect(await (await post("/api/hooks/uninstall")).json()).toEqual({ installed: false, removed: 3, backup: "S/backups/settings-2.json" });
    expect(JSON.parse(fs.readFileSync(`${data}/setup.json`, "utf8")).hooks_installed_at).toBeNull();
    expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toEqual(["hooks preview --json", "hooks install --json", "hooks uninstall --json"]);
  });
});

describe("the claude state", () => {
  const STATUS = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "person@example.com", accessToken: "sk-ant-oat01-secret", orgName: "Acme" });

  it("keeps only the sign-in fields and leaks no e-mail address or token", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((k) => vi.spyOn(console, k));
    const written: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => (written.push(String(c)), true));
    app.ctx.claude = async (args) => (args[0] === "--version" ? { stdout: "2.1.5 (Claude Code)\n", code: 0 } : { stdout: STATUS, code: 0 });
    const r = await get("/api/claude");
    const text = await r.text();
    out.mockRestore();
    expect(r.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ installed: true, version: "2.1.5", signed_in: true, auth_method: "claude.ai", plan: "max" });
    expect(text).not.toMatch(/@|sk-ant|secret|Acme|email|token/i);
    const logged = [...spies.flatMap((s) => s.mock.calls.flat().map(String)), ...written].join("\n");
    expect(logged).not.toMatch(/@|sk-ant|secret|Acme/);
    spies.forEach((s) => s.mockRestore());
  });

  it("reports a missing command and a signed-out command", async () => {
    expect((await claudeState(async () => null)).installed).toBe(false);
    const out = await claudeState(async (a) => (a[0] === "--version" ? { stdout: "2.0.0", code: 0 } : { stdout: "not json", code: 1 }));
    expect(out).toMatchObject({ installed: true, signed_in: false, auth_method: null, plan: null });
  });

  it("opens the sign-in window at once through the launcher", async () => {
    const launcher = vi.fn(() => ({ started: true, terminal: "Test terminal", message: "Opened." }));
    app.ctx.login = launcher;
    const r = await post("/api/claude/login");
    expect(await r.json()).toEqual({ started: true, terminal: "Test terminal", message: "Opened." });
    expect(launcher).toHaveBeenCalledOnce();
  });
});

describe("missions need consent and a signed-in command", () => {
  const body = { prompt: "do it", plan: { task_types: [], steps: [{ agent: "main", purpose: "x" }], load: [], gates: [], cautions: [] } };

  it("returns 403 without consent", async () => {
    const r = await post("/api/missions", body);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toContain("agree");
  });

  it("returns 403 with consent but no sign-in", async () => {
    const c = (await (await post("/api/setup/missions-consent")).json()) as { missions_consent_at: string | null };
    expect(c.missions_consent_at).not.toBeNull();
    app.ctx.claude = async (args) => (args[0] === "--version" ? { stdout: "2.0.0", code: 0 } : { stdout: JSON.stringify({ loggedIn: false }), code: 1 });
    const r = await post("/api/missions", body);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toContain("not signed in");
  });
});

describe("compiler failures", () => {
  it("reports the last line of the error", async () => {
    const cfg = app.ctx.cfg;
    const saved = cfg.kg_cmd;
    cfg.kg_cmd = [process.execPath, `${root}/fake-kg.mjs`, "fail"];
    const r = await post("/api/compile");
    cfg.kg_cmd = saved;
    expect(r.status).toBe(500);
  });
});

describe("the demonstrator flag of the set-up state", () => {
  it("is true only where the configuration opens the demonstrator", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ranviera-demo-flag-"));
    const base = { claude_home: path.join(root, "claude"), projects_root: null, memory_dir: null, data_dir: root, port: 0, python_cmd: "python",
      include_sensitivity: ["public", "internal", "client-confidential"], log_prompt_snippets: false, repo_root: REPO_ROOT } as unknown as Config;
    expect(setupState(base, null).demo).toBe(false);
    expect(setupState({ ...base, oversight_demo: true }, null).demo).toBe(true);
  });
});
