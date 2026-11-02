import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { handleSources } from "./http.ts";
import { createSources } from "./index.ts";
import { tmpDir, write } from "./testkit.ts";

const home = tmpDir();
const dataDir = `${home}/data`;
const notes = `${home}/notes`;
const projects = `${home}/Projects`;
fs.mkdirSync(notes, { recursive: true });
fs.mkdirSync(projects, { recursive: true });
const deleted: unknown[] = [];
const events: unknown[] = [];
const service = createSources({
  learnDir: `${dataDir}/learn`,
  dataDir,
  claudeHome: `${home}/claude`,
  projectsRoot: projects,
  deleteKnowledge: (id, mode) => void deleted.push([id, mode]),
  emit: (e, r) => void events.push([e, r]),
});
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  void handleSources(service, req, res, url.pathname, url.searchParams).then((handled) => {
    if (!handled) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not handled", code: "not_found" }));
    }
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => void server.close());

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { ...(body === undefined || typeof body === "string" ? {} : { "content-type": "application/json" }), ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(base + path, init);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

describe("sources routes", () => {
  write(notes, "a.md", "# Title\nline two\n");
  let rootId = "";
  let sourceId = "";

  it("40 lists no roots at first", async () => {
    expect(await call("GET", "/api/learn/sources")).toMatchObject({ status: 200, json: { roots: [] } });
  });

  it("41 adds a root and answers 201 with the root", async () => {
    const r = await call("POST", "/api/learn/sources", { kind: "notes", path: notes, label: "Notes", mode: "scan" });
    expect(r.status).toBe(201);
    expect(r.json.root).toMatchObject({ kind: "notes", label: "Notes", mode: "scan", sensitivity: "internal", hostedConsentAt: null });
    rootId = r.json.root.id;
    expect(events).toContainEqual(["sources-changed", rootId]);
  });

  it("41 answers the error envelopes for a bad body, a duplicate, a denied path and a wrong media type", async () => {
    expect(await call("POST", "/api/learn/sources", { kind: "nope", path: notes })).toMatchObject({ status: 400, json: { code: "bad_request" } });
    expect(await call("POST", "/api/learn/sources", { kind: "notes", path: notes })).toMatchObject({ status: 400, json: { code: "bad_request" } });
    fs.mkdirSync(`${home}/.ssh`, { recursive: true });
    const denied = await call("POST", "/api/learn/sources", { kind: "notes", path: `${home}/.ssh` });
    expect(denied).toMatchObject({ status: 403, json: { code: "forbidden_path" } });
    expect(JSON.stringify(denied.json)).not.toMatch(/\.ssh/);
    expect(await call("POST", "/api/learn/sources", "kind=notes", { "content-type": "text/plain" })).toMatchObject({ status: 415, json: { code: "unsupported_media_type" } });
    expect(await call("POST", "/api/learn/sources", "{not json", { "content-type": "application/json" })).toMatchObject({ status: 400 });
  });

  it("44 scans, 46 lists the files and 38 reads a passage", async () => {
    const scan = await call("POST", `/api/learn/sources/${rootId}/scan`);
    expect(scan.status).toBe(200);
    expect(scan.json.counts).toMatchObject({ new: 1 });
    sourceId = scan.json.files[0].sourceId;
    const files = await call("GET", `/api/learn/sources/${rootId}/files`);
    expect(files.json.files).toMatchObject([{ path: "a.md", state: "pending", sourceId }]);
    const p = await call("GET", `/api/learn/passage?source=${sourceId}&from=1&to=2`);
    expect(p.json).toMatchObject({ sourceId, path: "a.md", from: 1, to: 2, lines: ["# Title", "line two"], heading: "Title", fileChanged: false });
    const list = await call("GET", "/api/learn/sources");
    expect(list.json.roots[0].counts).toMatchObject({ files: 1, pending: 1 });
  });

  it("38 refuses a missing parameter, a bad number and an unknown source", async () => {
    expect(await call("GET", "/api/learn/passage")).toMatchObject({ status: 400 });
    expect(await call("GET", `/api/learn/passage?source=${sourceId}&from=abc`)).toMatchObject({ status: 400, json: { code: "bad_request" } });
    expect(await call("GET", `/api/learn/passage?source=${sourceId}&from=-1&to=3`)).toMatchObject({ status: 400 });
    expect(await call("GET", "/api/learn/passage?source=src_000000000000&from=1&to=2")).toMatchObject({ status: 404, json: { code: "not_found" } });
  });

  it("42 changes a root, records and revokes hosted consent", async () => {
    const on = await call("PATCH", `/api/learn/sources/${rootId}`, { hostedConsent: true, sensitivity: "client-confidential" });
    expect(on.json.root.hostedConsentAt).toMatch(/^\d{4}-/);
    expect(on.json.root.sensitivity).toBe("client-confidential");
    const off = await call("PATCH", `/api/learn/sources/${rootId}`, { hostedConsent: false });
    expect(off.json.root.hostedConsentAt).toBeNull();
    expect(await call("PATCH", `/api/learn/sources/${rootId}`, { mode: "sometimes" })).toMatchObject({ status: 400 });
    expect(await call("PATCH", "/api/learn/sources/root_00000000", { label: "x" })).toMatchObject({ status: 404 });
    expect(await call("PATCH", "/api/learn/sources/not-a-root", { label: "x" })).toMatchObject({ status: 404 });
  });

  it("answers 405 for a wrong method and leaves route 45 to the extraction phase", async () => {
    const r = await call("PUT", "/api/learn/sources");
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, POST");
    expect((await call("DELETE", `/api/learn/sources/${rootId}/scan`)).status).toBe(405);
    expect((await call("POST", `/api/learn/passage`)).status).toBe(405);
    expect((await call("POST", `/api/learn/sources/${rootId}/extract`, {})).json.error).toBe("not handled");
    expect((await call("GET", "/api/learn/graph")).json.error).toBe("not handled");
  });

  it("43 needs a mode, unlinks through the injected deletion and never touches the files", async () => {
    expect(await call("DELETE", `/api/learn/sources/${rootId}`)).toMatchObject({ status: 400, json: { code: "bad_request" } });
    expect(await call("DELETE", `/api/learn/sources/${rootId}?mode=all`)).toMatchObject({ status: 400 });
    const r = await call("DELETE", `/api/learn/sources/${rootId}?mode=delete-nodes`);
    expect(r).toMatchObject({ status: 200, json: { mode: "delete-nodes", files: 1 } });
    expect(deleted).toEqual([[rootId, "delete-nodes"]]);
    expect(fs.readFileSync(`${notes}/a.md`, "utf8")).toBe("# Title\nline two\n");
    expect(await call("GET", "/api/learn/sources")).toMatchObject({ json: { roots: [] } });
    expect(await call("DELETE", `/api/learn/sources/${rootId}?mode=preserve-graph`)).toMatchObject({ status: 404 });
  });
});
