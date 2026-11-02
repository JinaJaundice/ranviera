import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_PREFIX, MISMATCH_MESSAGE, ToolBridge } from "./bridge.ts";

const ask = {
  name: "ask",
  description: "Ask the learner a question.",
  inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
};

const open: ToolBridge[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
});

async function start(violations: string[] = []): Promise<ToolBridge> {
  const b = await ToolBridge.start({ tools: [ask], onViolation: (m) => violations.push(m) });
  open.push(b);
  return b;
}

function post(b: ToolBridge, body: unknown, token: string | null = b.token, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return fetch(b.url, { method: "POST", headers, body: JSON.stringify(body), signal });
}

async function rpc(res: Response): Promise<{ result?: { content?: { type: string; text?: string; data?: string }[]; isError?: boolean; tools?: { name: string; inputSchema: unknown }[] }; error?: { message: string } }> {
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : text);
}

const call = (id: string | null, name: string, args: unknown) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name, arguments: args, ...(id === null ? {} : { _meta: { "claudecode/toolUseId": id } }) },
});

const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("bridge transport", () => {
  it("binds to loopback with a 64 hex character token and lists exactly the given tools with their schemas", async () => {
    const b = await start();
    expect(b.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(b.token).toMatch(/^[0-9a-f]{64}$/);
    const res = await post(b, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = await rpc(res);
    expect(body.result?.tools).toEqual([{ name: "ask", description: ask.description, inputSchema: ask.inputSchema, annotations: { readOnlyHint: true } }]);
    expect(b.allowedToolNames()).toEqual([`${BRIDGE_PREFIX}ask`]);
  });

  it("rejects a request with no token, a wrong token and a token of another length", async () => {
    const b = await start();
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await post(b, body, null)).status).toBe(401);
    expect((await post(b, body, "0".repeat(64))).status).toBe(401);
    expect((await post(b, body, "short")).status).toBe(401);
  });

  it("names one HTTP server in the generated configuration, with the authorisation header", async () => {
    const b = await start();
    expect(b.mcpConfig()).toEqual({ mcpServers: { learn: { type: "http", url: b.url, headers: { Authorization: `Bearer ${b.token}` } } } });
  });

  it("frees the port when it closes and answers held calls", async () => {
    const b = await start();
    b.declareIntent({ id: "t1", name: "ask", arguments: { question: "q" } });
    const held = post(b, call("t1", "ask", { question: "q" })).then(rpc);
    await tick();
    await b.close();
    const body = await held;
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0].text).toBe("MCP bridge closed.");
    await expect(fetch(b.url, { method: "POST" })).rejects.toThrow();
  });
});

describe("admission", () => {
  it("holds a call until the loop supplies the result, then returns text and image content", async () => {
    const b = await start();
    b.declareIntent({ id: "t1", name: "ask", arguments: { question: "why" } });
    let settled = false;
    const pending = post(b, call("t1", "ask", { question: "why" })).then(async (r) => {
      const body = await rpc(r);
      settled = true;
      return body;
    });
    await tick();
    expect(settled).toBe(false);
    expect(b.allAdmitted(["t1"])).toBe(true);
    b.resolve("t1", { content: [{ type: "text", text: "because" }, { type: "image", data: "AAAA", mimeType: "image/png" }] });
    const body = await pending;
    expect(body.result?.content).toEqual([
      { type: "text", text: "because" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    expect(body.result?.isError ?? false).toBe(false);
  });

  it("turns an error result into an MCP error result", async () => {
    const b = await start();
    b.declareIntent({ id: "t1", name: "ask", arguments: { question: "q" } });
    const pending = post(b, call("t1", "ask", { question: "q" })).then(rpc);
    await tick();
    b.resolve("t1", { content: [{ type: "text", text: "failed" }], isError: true });
    expect((await pending).result?.isError).toBe(true);
  });

  it("admits a call whose MCP request arrives before the streamed intent", async () => {
    const b = await start();
    const pending = post(b, call("t1", "ask", { question: "q" })).then(rpc);
    await tick();
    expect(b.allAdmitted(["t1"])).toBe(false);
    b.declareIntent({ id: "t1", name: "ask", arguments: { question: "q" } });
    expect(b.allAdmitted(["t1"])).toBe(true);
    b.resolve("t1", { content: [{ type: "text", text: "ok" }] });
    expect((await pending).result?.content?.[0].text).toBe("ok");
  });

  it("fails closed when the arguments differ from the streamed intent", async () => {
    const violations: string[] = [];
    const b = await start(violations);
    b.declareIntent({ id: "t1", name: "ask", arguments: { question: "a" } });
    const body = await rpc(await post(b, call("t1", "ask", { question: "b" })));
    expect(violations).toEqual([MISMATCH_MESSAGE]);
    expect(body.result?.isError).toBe(true);
    expect(b.allAdmitted(["t1"])).toBe(false);
    expect(() => b.resolve("t1", { content: [] })).toThrow();
  });

  it("compares arguments deeply, so key order does not matter and nested differences do", async () => {
    const violations: string[] = [];
    const b = await start(violations);
    b.declareIntent({ id: "t1", name: "ask", arguments: { a: 1, nested: { x: [1, 2], y: "z" } } });
    const ok = post(b, call("t1", "ask", { nested: { y: "z", x: [1, 2] }, a: 1 })).then(rpc);
    await tick();
    expect(violations).toEqual([]);
    expect(b.allAdmitted(["t1"])).toBe(true);
    b.resolve("t1", { content: [{ type: "text", text: "ok" }] });
    await ok;
    b.declareIntent({ id: "t2", name: "ask", arguments: { nested: { x: [1, 2] } } });
    await post(b, call("t2", "ask", { nested: { x: [1, 3] } }));
    expect(violations).toEqual([MISMATCH_MESSAGE]);
  });

  it("fails closed when the name differs from the streamed intent", async () => {
    const violations: string[] = [];
    const b = await ToolBridge.start({ tools: [ask, { ...ask, name: "other" }], onViolation: (m) => violations.push(m) });
    open.push(b);
    b.declareIntent({ id: "t1", name: "ask", arguments: {} });
    await post(b, call("t1", "other", {}));
    expect(violations).toEqual([MISMATCH_MESSAGE]);
  });

  it("fails closed on a missing identifier", async () => {
    const violations: string[] = [];
    const b = await start(violations);
    const body = await rpc(await post(b, call(null, "ask", { question: "q" })));
    expect(body.error?.message).toMatch(/no tool use identifier/);
    expect(violations).toHaveLength(1);
  });

  it("fails closed on an empty identifier", async () => {
    const violations: string[] = [];
    const b = await start(violations);
    await post(b, call("", "ask", { question: "q" }));
    expect(violations).toHaveLength(1);
  });

  it("fails closed on a reused identifier", async () => {
    const violations: string[] = [];
    const b = await start(violations);
    b.declareIntent({ id: "t1", name: "ask", arguments: { question: "q" } });
    const first = post(b, call("t1", "ask", { question: "q" })).then(rpc);
    await tick();
    b.resolve("t1", { content: [{ type: "text", text: "ok" }] });
    await first;
    const body = await rpc(await post(b, call("t1", "ask", { question: "q" })));
    expect(body.error?.message).toMatch(/reuses/);
    expect(violations).toHaveLength(1);
  });

  it("fails closed on an undeclared tool", async () => {
    const violations: string[] = [];
    const b = await start(violations);
    const body = await rpc(await post(b, call("t1", "bash", { command: "ls" })));
    expect(body.error?.message).toMatch(/not declared/);
    expect(violations).toHaveLength(1);
  });

  it("fails closed on a repeated streamed identifier", async () => {
    const violations: string[] = [];
    const b = await start(violations);
    b.declareIntent({ id: "t1", name: "ask", arguments: {} });
    b.declareIntent({ id: "t1", name: "ask", arguments: {} });
    expect(violations).toHaveLength(1);
  });

  it("fails closed on a parked call that no streamed intent matches", async () => {
    const violations: string[] = [];
    const b = await start(violations);
    void post(b, call("t9", "ask", { question: "q" })).catch(() => undefined);
    await tick();
    b.assertNoOrphans();
    expect(violations).toEqual(["An MCP call arrived with no streamed tool intent."]);
  });

  it("removes only a cancelled request and never admits its identifier later", async () => {
    const violations: string[] = [];
    const b = await start(violations);
    b.declareIntent({ id: "t1", name: "ask", arguments: { question: "q" } });
    b.declareIntent({ id: "t2", name: "ask", arguments: { question: "r" } });
    const ac = new AbortController();
    const first = post(b, call("t1", "ask", { question: "q" }), b.token, ac.signal).catch(() => undefined);
    const second = post(b, call("t2", "ask", { question: "r" })).then(rpc);
    await tick(100);
    expect(b.allAdmitted(["t1", "t2"])).toBe(true);
    ac.abort();
    await first;
    await tick(100);
    expect(b.hasParked("t1")).toBe(false);
    expect(b.wasCancelled("t1")).toBe(true);
    expect(b.hasParked("t2")).toBe(true);
    b.resolve("t2", { content: [{ type: "text", text: "ok" }] });
    expect((await second).result?.content?.[0].text).toBe("ok");
    const retry = await rpc(await post(b, call("t1", "ask", { question: "q" })));
    expect(retry.error?.message).toMatch(/reuses/);
  });
});
