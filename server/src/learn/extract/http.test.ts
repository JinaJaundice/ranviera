import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { LearnError } from "../models/errors.ts";
import { handleExtract } from "./http.ts";
import { auditorReply, cleanupEnvs, deferred, extractorReply, setupEnv, write, type Env } from "./test-support.ts";

cleanupEnvs();

const servers: http.Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function serve(e: Env): Promise<(method: string, path: string, body?: unknown, type?: string) => Promise<{ status: number; json: Record<string, any>; headers: Headers }>> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    void handleExtract(e.svc, req, res, url.pathname).then((handled) => {
      if (!handled) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not handled", code: "not_found" }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (method, path, body, type = "application/json") => {
    const init: RequestInit = { method, headers: body === undefined ? {} : { "content-type": type } };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const res = await fetch(base + path, init);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  };
}

const finding = { id: "p1", name: "Bucket", statement: "A token bucket refills at a fixed rate.", quote: "A token bucket refills" };

describe("routes 31, 32, 33 and 45", () => {
  it("lists the runs in flight, answers 202 to an extraction and shows the cost afterwards", async () => {
    const gate = deferred();
    const e = setupEnv({ handler: async (c) => (c.role === "auditor" ? auditorReply() : (await gate.promise, extractorReply([finding]))) });
    write(e.notes, "a.md", "# A\n\nA token bucket refills at a fixed rate.\n");
    write(e.notes, "b.md", "# B\n\nSome other note.\n");
    const call = await serve(e);
    await e.sources.scan(e.root.id);
    expect((await call("GET", "/api/learn/graph/status")).json).toEqual({ runs: [] });
    const start = await call("POST", `/api/learn/sources/${e.root.id}/extract`, { paths: ["a.md"] });
    expect(start.status).toBe(202);
    expect(start.json).toEqual({ started: 1, queued: 0 });
    const status = await call("GET", "/api/learn/graph/status");
    expect(status.json.runs).toHaveLength(1);
    expect(status.json.runs[0]).toMatchObject({ title: "Notes/a.md", sessionId: null, phase: expect.stringMatching(/queued|extracting/) });
    // a second request for the file in flight starts nothing
    expect((await call("POST", `/api/learn/sources/${e.root.id}/extract`, { paths: ["a.md"] })).json).toEqual({ started: 0, queued: 0 });
    gate.resolve();
    await e.svc.idle();
    const after = await call("GET", "/api/learn/graph/costs");
    expect(after.status).toBe(200);
    expect(after.json).toMatchObject({ cost: null, unpriced: 1, runs: [{ title: "Notes/a.md", cost: null, stats: { nodes: 1, chains: 0 } }] });
    // without paths the pending file is queued, and the extracted one is not
    expect((await call("POST", `/api/learn/sources/${e.root.id}/extract`, {})).json).toEqual({ started: 1, queued: 0 });
    await e.svc.idle();
  });

  it("asks for confirmation before it extracts more files than one scan pass holds", async () => {
    const e = setupEnv({ handler: (c) => (c.role === "auditor" ? auditorReply() : extractorReply([])) });
    for (let i = 0; i < 51; i++) write(e.notes, `n${String(i).padStart(2, "0")}.md`, `# N${i}

A note of some length.
`);
    const call = await serve(e);
    await e.sources.scan(e.root.id);
    const bytes = e.sources.files(e.root.id).reduce((n, f) => n + f.bytes, 0);
    const asked = await call("POST", `/api/learn/sources/${e.root.id}/extract`, {});
    expect(asked.status).toBe(409);
    expect(asked.json).toMatchObject({ code: "confirm_required", files: 51, tokens: Math.ceil(bytes / 4) });
    expect(e.svc.registered()).toBe(false);
    // confirm false still asks, and a value that is not a boolean is refused
    expect((await call("POST", `/api/learn/sources/${e.root.id}/extract`, { confirm: false })).status).toBe(409);
    expect((await call("POST", `/api/learn/sources/${e.root.id}/extract`, { confirm: "yes" })).status).toBe(400);
    const confirmed = await call("POST", `/api/learn/sources/${e.root.id}/extract`, { confirm: true });
    expect(confirmed.status).toBe(202);
    expect(confirmed.json.started + confirmed.json.queued).toBe(51);
    await e.svc.idle();
    // 51 extractions run to the end here, which can pass the default time limit of a test when the whole suite runs at once
  }, 60_000);

  it("answers the errors of the contracts", async () => {
    const e = setupEnv({ handler: () => extractorReply([]) });
    write(e.notes, "a.md", "# A\n\nText.\n");
    const call = await serve(e);
    await e.sources.scan(e.root.id);
    expect((await call("DELETE", "/api/learn/graph/status")).status).toBe(405);
    expect((await call("POST", "/api/learn/graph/costs")).status).toBe(405);
    expect((await call("GET", "/api/learn/graph/extract")).status).toBe(405);
    expect((await call("GET", `/api/learn/sources/${e.root.id}/extract`)).status).toBe(405);
    expect((await call("POST", "/api/learn/sources/root_00000000/extract", {})).json).toMatchObject({ code: "not_found" });
    expect((await call("POST", `/api/learn/sources/${e.root.id}/extract`, { paths: ["missing.md"] })).status).toBe(400);
    expect((await call("POST", `/api/learn/sources/${e.root.id}/extract`, { paths: "a.md" })).status).toBe(400);
    expect((await call("POST", `/api/learn/sources/${e.root.id}/extract`, "not json", "text/plain")).status).toBe(415);
    expect((await call("POST", "/api/learn/graph/extract", {})).status).toBe(400);
    const none = await call("POST", "/api/learn/graph/extract", { sessionId: "chat_x" });
    expect(none.status).toBe(404);
    expect(none.json.code).toBe("not_found");
    expect((await call("GET", "/api/learn/models")).status).toBe(404);
  });

  it("answers the refusals of the model layer and the gate with their envelopes", async () => {
    const refusal = new LearnError(503, "provider_key_missing", "The provider faux has no key.", { provider: "faux", slots: ["cheap"] });
    const a = setupEnv({ handler: () => extractorReply([]), preflight: refusal });
    write(a.notes, "a.md", "# A\n\nText.\n");
    const callA = await serve(a);
    await a.sources.scan(a.root.id);
    const r1 = await callA("POST", `/api/learn/sources/${a.root.id}/extract`, {});
    expect(r1.status).toBe(503);
    expect(r1.json).toMatchObject({ code: "provider_key_missing", provider: "faux" });

    const b = setupEnv({ handler: () => extractorReply([]), cls: "hosted", sensitivity: "client-confidential" });
    write(b.notes, "a.md", "# A\n\nText.\n");
    const callB = await serve(b);
    await b.sources.scan(b.root.id);
    const r2 = await callB("POST", `/api/learn/sources/${b.root.id}/extract`, {});
    expect(r2.status).toBe(403);
    expect(r2.json).toMatchObject({ code: "sensitivity_refused", sensitivity: "client-confidential", providerClass: "hosted", roots: [b.root.id] });
    expect(b.calls).toHaveLength(0);
  });

  it("starts a session extraction through route 33 and answers 409 for a session that is running", async () => {
    const gate = deferred();
    const e = setupEnv({ handler: async (c) => (c.role === "auditor" ? auditorReply() : (await gate.promise, extractorReply([]))) });
    e.svc.setSessionSource({ get: () => ({ title: "Rates", sensitivity: "internal", view: [{ messageId: "msg_1", fp: "fp1", tokens: 10, lines: ["TEACHER [msg_1] Explanation."] }] }) });
    const call = await serve(e);
    const ok = await call("POST", "/api/learn/graph/extract", { sessionId: "chat_1" });
    expect(ok).toMatchObject({ status: 202, json: { started: true } });
    const busy = await call("POST", "/api/learn/graph/extract", { sessionId: "chat_1" });
    expect(busy.status).toBe(409);
    expect(busy.json.code).toBe("extraction_busy");
    gate.resolve();
    await e.svc.idle();
  });
});
