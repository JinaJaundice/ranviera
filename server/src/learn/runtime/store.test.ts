import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeError } from "./errors.ts";
import { DEFAULT_TITLE, createSessionStore, titleFromPrompt } from "./store.ts";
import { makeEnv, tmpDir, userMsg } from "./support.ts";

function setup() {
  const dir = tmpDir();
  const clock = { now: Date.parse("2026-11-01T10:00:00Z") };
  const store = createSessionStore({ learnDir: dir, now: () => clock.now });
  return { dir, clock, store };
}

describe("session store", () => {
  it("round trips a record with tab indentation and the version stamp (B-7-01)", () => {
    const { dir, store } = setup();
    const r = store.create({ title: "First" });
    expect(r.id).toMatch(/^chat_[0-9a-z]+_[0-9a-f]{8}$/);
    const raw = fs.readFileSync(path.join(dir, "chats", `${r.id}.json`), "utf8");
    expect(raw).toContain('\n\t"id"');
    expect(JSON.parse(raw).version).toBe(1);
    expect(store.get(r.id)?.title).toBe("First");
    expect(store.list().map((s) => s.id)).toEqual([r.id]);
  });

  it("writes through a temporary file and leaves none behind", () => {
    const { dir, store } = setup();
    const r = store.create({});
    store.appendMessages(r.id, [userMsg("msg_a", "hello")]);
    expect(fs.readdirSync(path.join(dir, "chats")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("bumps updatedAt on a message save only", () => {
    const { clock, store } = setup();
    const r = store.create({ title: "T" });
    const created = r.updatedAt;
    clock.now += 60_000;
    expect(store.rename(r.id, "Renamed").updatedAt).toBe(created);
    expect(store.setSettings(r.id, { thinkingLevel: "low" }).updatedAt).toBe(created);
    expect(store.setTree(r.id, { nodes: [], edges: [], version: 0 }).updatedAt).toBe(created);
    expect(store.appendTurnUsage(r.id, { id: "turn_1", messageId: "m", at: "x", model: "a:b", steps: [] }).updatedAt).toBe(created);
    expect(store.appendMessages(r.id, [userMsg("msg_a", "hi")]).updatedAt).not.toBe(created);
  });

  it("falls back to a default title for a blank title (B-7-06)", () => {
    const { store } = setup();
    const r = store.create({ title: "   " });
    expect(r.title).toBe(DEFAULT_TITLE);
    expect(store.rename(r.id, " \n ").title).toBe(DEFAULT_TITLE);
  });

  it("appends usage idempotently for turns and for extractions", () => {
    const { store } = setup();
    const r = store.create({});
    const usage = { id: "turn_1", messageId: "m", at: "x", model: "a:b", steps: [{ inputTokens: 5 }] };
    store.appendTurnUsage(r.id, usage);
    store.appendTurnUsage(r.id, usage);
    const run = { startedAt: 100, at: "x", durationMs: 1, stages: {} };
    store.appendExtractionUsage(r.id, run);
    store.appendExtractionUsage(r.id, run);
    const back = store.get(r.id)!;
    expect(back.turns).toHaveLength(1);
    expect(back.extractions).toHaveLength(1);
  });

  it("reads a corrupt file as absent and skips it in a list", () => {
    const { dir, store } = setup();
    const good = store.create({ title: "Good" });
    fs.writeFileSync(path.join(dir, "chats", "chat_bad_00000000.json"), "{ not json", "utf8");
    fs.writeFileSync(path.join(dir, "chats", "chat_odd_00000000.json"), JSON.stringify({ id: "other" }), "utf8");
    expect(store.get("chat_bad_00000000")).toBeNull();
    expect(store.get("chat_odd_00000000")).toBeNull();
    expect(store.list().map((s) => s.id)).toEqual([good.id]);
  });

  it("refuses an identifier that is not safe", () => {
    const { store } = setup();
    expect(store.get("../chats/x")).toBeNull();
    expect(store.get("a b")).toBeNull();
  });

  it("refuses a record from a newer format and never rewrites it", () => {
    const { dir, store } = setup();
    const file = path.join(dir, "chats", "chat_new_00000000.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify({ id: "chat_new_00000000", title: "n", createdAt: "x", updatedAt: "x", messages: [], version: 2 });
    fs.writeFileSync(file, text, "utf8");
    let caught: unknown;
    try {
      store.get("chat_new_00000000");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeError);
    expect((caught as RuntimeError).status).toBe(503);
    expect((caught as RuntimeError).body.code).toBe("format_newer");
    expect(() => store.rename("chat_new_00000000", "x")).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(text);
    expect(store.list()).toEqual([]);
  });

  it("archives a deleted session and removes nothing", () => {
    const { dir, store } = setup();
    const r = store.create({});
    const to = store.archive(r.id)!;
    expect(fs.existsSync(path.join(dir, "chats", `${r.id}.json`))).toBe(false);
    expect(fs.existsSync(to)).toBe(true);
    expect(to).toContain(path.join("archive", "2026-11-01", "chats"));
    expect(store.get(r.id)).toBeNull();
  });
});

describe("titleFromPrompt (B-7-90)", () => {
  it("passes a short prompt through with whitespace collapsed", () => {
    expect(titleFromPrompt("  teach   me\n about  bonds ")).toBe("teach me about bonds");
  });
  it("cuts at the last word boundary under the cap with no trailing space", () => {
    const t = titleFromPrompt("alpha beta gamma delta epsilon", 17);
    expect(t).toBe("alpha beta gamma");
    expect(t.endsWith(" ")).toBe(false);
  });
  it("splits one over long word at the cap", () => {
    expect(titleFromPrompt("x".repeat(100), 20)).toBe("x".repeat(20));
  });
});

describe("birth stamp (B-7-93)", () => {
  it("copies the strong slot model and level into a new session", () => {
    const env = makeEnv();
    const s = env.service.create({});
    expect(s.settings?.model?.provider).toBe("faux");
    expect(s.settings?.thinkingLevel).toBe("off");
  });
  it("stamps nothing when no strong slot is set", () => {
    const env = makeEnv();
    env.state.noStrongSlot = true;
    expect(env.service.create({}).settings).toBeUndefined();
  });
  it("stamps kind practice and reads an absent kind as teach (B-7-94)", () => {
    const env = makeEnv();
    const t = env.service.create({});
    const p = env.service.create({ kind: "practice" });
    expect(t.kind).toBeUndefined();
    expect(p.kind).toBe("practice");
    const summaries = env.service.list();
    expect(summaries.find((s) => s.id === t.id)?.kind).toBe("teach");
    expect(summaries.find((s) => s.id === p.id)?.kind).toBe("practice");
  });
  it("writes a graph context marker of at most 64 propositions", () => {
    const env = makeEnv();
    const ids = Array.from({ length: 64 }, (_, i) => `n_${i}`);
    const s = env.service.create({ graphContext: { propositions: ids } });
    expect(s.messages[0]).toMatchObject({ role: "custom", customType: "graph-context" });
    expect(() => env.service.create({ graphContext: { propositions: [...ids, "n_64"] } })).toThrow(/at most 64/);
  });
});
