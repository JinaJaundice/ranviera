import { afterEach, describe, expect, it, vi } from "vitest";
import type { LearnSettings, PromptList } from "@shared/learn/models";
import { filterByKind, learnSessions, relativeAge, sessionMeta, sessionPath } from "./sessions";
import { learnPrompts, removeOverride, saveOverride, sectionedPrompts, setOverrideOn, switchKey, withPromptSwitch } from "./prompts";

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const sent = typeof init.body === "string" && init.body !== "" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method: init.method ?? "GET", body: sent });
      const r = handler(url, init);
      const status = r.status ?? 200;
      return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)) } as Response;
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("sessions client (routes 16 to 29)", () => {
  it("sends each call to its route with its method and body", async () => {
    const calls = fakeFetch((url) => (url.endsWith("/sessions") ? { body: { sessions: [], session: { id: "chat_1" } } } : url.endsWith("/activity") ? { body: { items: [] } } : { body: {} }));
    await learnSessions.list();
    await learnSessions.create({ title: "T", kind: "practice", graphContext: { propositions: ["n_1"] } });
    await learnSessions.detail("chat_1");
    await learnSessions.rename("chat_1", "New");
    await learnSessions.remove("chat_1", "delete-nodes");
    await learnSessions.settings("chat_1", { thinkingLevel: "high" });
    await learnSessions.activity();
    await learnSessions.abort("chat_1");
    await learnSessions.extract("chat_1");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/learn/sessions",
      "POST /api/learn/sessions",
      "GET /api/learn/sessions/chat_1",
      "PUT /api/learn/sessions/chat_1",
      "DELETE /api/learn/sessions/chat_1?mode=delete-nodes",
      "PUT /api/learn/sessions/chat_1/settings",
      "GET /api/learn/activity",
      "POST /api/learn/activity/abort",
      "POST /api/learn/graph/extract",
    ]);
    expect(calls[1].body).toEqual({ title: "T", kind: "practice", graphContext: { propositions: ["n_1"] } });
    expect(calls[3].body).toEqual({ title: "New" });
    expect(calls[7].body).toEqual({ kind: "turn", id: "chat_1" });
  });

  it("raises the sentence and the code of the server on a refusal", async () => {
    fakeFetch(() => ({ status: 409, body: { error: "A turn is running for this session.", code: "turn_running" } }));
    await expect(learnSessions.remove("chat_1", "preserve-graph")).rejects.toMatchObject({ message: "A turn is running for this session.", code: "turn_running", status: 409 });
  });

  it("builds the addresses that the session model uses", () => {
    expect(sessionPath.input("chat_1")).toBe("/api/learn/sessions/chat_1/input");
    expect(sessionPath.stream("chat_1")).toBe("/api/learn/sessions/chat_1/stream");
    expect(sessionPath.jobs("chat_1")).toBe("/api/learn/jobs?sessionId=chat_1");
    expect(sessionPath.detail("a b")).toBe("/api/learn/sessions/a%20b");
  });
});

describe("the session list (B-9-24, B-9-25, B-9-26)", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const base = { busy: false, compacting: false, pendingQuestion: false, kind: "teach" as const, updatedAt: "2026-11-02T11:55:00Z" };

  it("reads the age as minutes, hours and days and then a date, and treats a clock that runs ahead as just now", () => {
    expect(relativeAge("2026-11-02T11:59:50Z", now)).toBe("Just now");
    expect(relativeAge("2026-11-02T11:55:00Z", now)).toBe("5 minutes ago");
    expect(relativeAge("2026-11-02T11:00:00Z", now)).toBe("1 hour ago");
    expect(relativeAge("2026-10-30T12:00:00Z", now)).toBe("3 days ago");
    expect(relativeAge("2026-06-04T12:00:00Z", now)).toBe("4 June 2026");
    expect(relativeAge("2026-11-02T12:30:00Z", now)).toBe("Just now");
    expect(relativeAge("nonsense", now)).toBe("Not dated");
  });

  it("shows the useful state in place of the age, and compaction outranks a waiting question", () => {
    expect(sessionMeta(base, now)).toBe("5 minutes ago");
    expect(sessionMeta({ ...base, busy: true }, now)).toBe("Working");
    expect(sessionMeta({ ...base, pendingQuestion: true }, now)).toBe("Waiting for your answer");
    expect(sessionMeta({ ...base, pendingQuestion: true, kind: "practice" }, now)).toBe("Problem waiting");
    expect(sessionMeta({ ...base, pendingQuestion: true, compacting: true }, now)).toBe("Compacting context");
  });

  it("filters by kind", () => {
    const rows = [{ kind: "teach" }, { kind: "practice" }] as Parameters<typeof filterByKind>[0];
    expect(filterByKind(rows, "all")).toHaveLength(2);
    expect(filterByKind(rows, "practice")).toEqual([{ kind: "practice" }]);
  });
});

describe("prompt overrides (routes 13 to 15)", () => {
  const entry = (key: string, agent: "teacher" | "prober" | "practice" | "shared" | "base", shared = false, over: Partial<{ override: string | null; enabled: boolean }> = {}) => ({ key, agent, source: `source of ${key}`, override: null, enabled: false, shared, ...over });
  const list: PromptList = {
    teacher: [entry("system-prompt", "base", true), entry("teacher/20-teaching", "teacher"), entry("shared/10-voice", "shared", true)],
    prober: [entry("system-prompt", "base", true), entry("prober/10-probe", "prober"), entry("shared/10-voice", "shared", true)],
    practice: [entry("practice/10-practice", "practice"), entry("shared/10-voice", "shared", true)],
  };

  it("lists each shared key once and keeps the order of assembly", () => {
    const s = sectionedPrompts(list);
    expect(s.shared.map((e) => e.key)).toEqual(["system-prompt", "shared/10-voice"]);
    expect(s.teacher.map((e) => e.key)).toEqual(["teacher/20-teaching"]);
    expect(s.prober.map((e) => e.key)).toEqual(["prober/10-probe"]);
    expect(s.practice.map((e) => e.key)).toEqual(["practice/10-practice"]);
  });

  it("keeps the slash of a key in the address", async () => {
    const calls = fakeFetch(() => ({ body: { ok: true } }));
    await learnPrompts.write("teacher/20-teaching", "text");
    await learnPrompts.remove("teacher/20-teaching");
    await learnPrompts.list();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["PUT /api/learn/prompts/teacher/20-teaching", "DELETE /api/learn/prompts/teacher/20-teaching", "GET /api/learn/prompts"]);
    expect(calls[0].body).toEqual({ text: "text" });
  });

  it("turns a switch on with an explicit true and off by removing the key, keeping the others", () => {
    const s: LearnSettings = { version: 1, agent: { prompts: { "a.md": true } } };
    expect(switchKey("teacher/20-teaching")).toBe("teacher/20-teaching.md");
    expect(withPromptSwitch(s, "teacher/20-teaching", true).agent?.prompts).toEqual({ "a.md": true, "teacher/20-teaching.md": true });
    expect(withPromptSwitch(withPromptSwitch(s, "b", true), "b", false).agent?.prompts).toEqual({ "a.md": true });
  });

  it("saves the file first and then the switch", async () => {
    const calls = fakeFetch((url, init) => (url.endsWith("/settings") && (init.method ?? "GET") === "GET" ? { body: { version: 1 } } : url.endsWith("/settings") ? { body: { version: 1, agent: { prompts: { "teacher/20-teaching.md": true } } } } : { body: { ok: true } }));
    const out = await saveOverride("teacher/20-teaching", "mine");
    expect(calls.map((c) => `${c.method} ${c.url.replace("/api/learn/", "")}`)).toEqual(["PUT prompts/teacher/20-teaching", "GET settings", "PUT settings"]);
    expect(calls[2].body).toEqual({ version: 1, agent: { prompts: { "teacher/20-teaching.md": true } } });
    expect(out.agent?.prompts?.["teacher/20-teaching.md"]).toBe(true);
  });

  it("deletes the file and writes the record again only when a stale switch is left", async () => {
    let calls = fakeFetch((url) => (url.endsWith("/settings") ? { body: { version: 1, agent: { prompts: { "x.md": true } } } } : { body: { ok: true } }));
    await removeOverride("x");
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "GET", "PUT"]);
    expect(calls[2].body).toEqual({ version: 1, agent: { prompts: {} } });
    calls = fakeFetch((url) => (url.endsWith("/settings") ? { body: { version: 1 } } : { body: { ok: true } }));
    await removeOverride("x");
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "GET"]);
  });

  it("switches an override on or off without touching its text", async () => {
    const calls = fakeFetch((url) => (url.endsWith("/settings") ? { body: { version: 1, agent: { prompts: { "k.md": true } } } } : { body: {} }));
    await setOverrideOn("k", false);
    expect(calls.some((c) => c.url.includes("/prompts/"))).toBe(false);
    expect(calls.at(-1)?.body).toEqual({ version: 1, agent: { prompts: {} } });
  });
});
