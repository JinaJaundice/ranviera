import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleMethod } from "./http.ts";
import { FRAGMENT, PRACTICE_SHARED, SEPARATOR, createPromptStore, defaultPromptsDir, normaliseKey } from "./prompt-store.ts";
import { makeMethodEnv, tmpDir, type MethodEnv } from "./support.ts";
import type { MethodSettings } from "./deps.ts";

function settings(): MethodSettings & { prompts: Record<string, boolean> } {
  const prompts: Record<string, boolean> = {};
  return {
    prompts,
    tools: () => ({}),
    promptSwitches: () => prompts,
    clearPromptSwitch: (k) => {
      delete prompts[k];
    },
  };
}

const store = (learnDir = tmpDir("prompts-"), s = settings(), promptsDir?: string) => ({ learnDir, s, ps: createPromptStore({ learnDir, settings: s, promptsDir }) });

const keys = (list: { key: string }[]) => list.map((e) => e.key);

describe("the source fragments (B-8-54, B-8-57, B-8-42)", () => {
  it("lists each agent in composition order: base, own fragments, then shared fragments", () => {
    const { ps } = store();
    const list = ps.list();
    expect(keys(list.prober)).toEqual(["system-prompt", "prober/10-measuring", ...[10, 15, 16, 20, 25, 30, 40].map((n) => `shared/${n}-${{ 10: "voice", 15: "accuracy", 16: "mental-model", 20: "question-tools", 25: "confidence", 30: "learner-files", 40: "formatting" }[n]}`)]);
    expect(keys(list.teacher).slice(0, 7)).toEqual(["system-prompt", "teacher/05-method", "teacher/10-planning", "teacher/20-teaching", "teacher/28-predictions", "teacher/30-checks", "teacher/40-jobs"]);
    expect(keys(list.teacher).slice(7)).toEqual(keys(list.prober).slice(2));
    // the practice agent has no base and only four shared fragments
    expect(keys(list.practice)).toEqual(["practice/00-base", "practice/10-doctrine", ...PRACTICE_SHARED]);
    expect(list.prober[0]).toMatchObject({ agent: "base", shared: true, enabled: false, override: null });
    expect(list.prober[1]).toMatchObject({ agent: "prober", shared: false });
    expect(list.prober[2]).toMatchObject({ agent: "shared", shared: true });
  });

  it("holds only numbered fragments, so a read me never enters a prompt", () => {
    const dir = tmpDir("src-");
    fs.mkdirSync(path.join(dir, "teacher"));
    fs.writeFileSync(path.join(dir, "system-prompt.md"), "Base.");
    fs.writeFileSync(path.join(dir, "teacher", "10-a.md"), "A.");
    fs.writeFileSync(path.join(dir, "teacher", "README.md"), "Do not load.");
    fs.writeFileSync(path.join(dir, "teacher", "notes.txt"), "Do not load.");
    fs.writeFileSync(path.join(dir, "teacher", "x-nonumber.md"), "Do not load.");
    const { ps } = store(undefined, undefined, dir);
    expect(ps.compose("teacher")).toBe(["Base.", "A."].join(SEPARATOR));
    expect(ps.segments("prober").map((s) => s.key)).toEqual(["system-prompt"]);
    expect(FRAGMENT.test("README.md")).toBe(false);
  });

  it("composes the doctrine of each agent and keeps the others out (B-8-42)", () => {
    const { ps } = store();
    const prober = ps.compose("prober");
    const teacher = ps.compose("teacher");
    const practice = ps.compose("practice");
    for (const text of [prober, teacher, practice]) {
      expect(text).toContain("# Voice");
      expect(text).toContain("# Accuracy");
      expect(text).toContain("# Formatting");
    }
    expect(prober).toContain("# Reading confidence");
    expect(prober).toContain("probe_done");
    expect(prober).not.toContain("# Predictions");
    expect(teacher).toContain("# Predictions");
    expect(teacher).toContain("plan_init");
    expect(teacher).not.toContain("# Your job: measure");
    expect(practice).toContain("# Doctrine of practice");
    expect(practice).toContain("# The model of the learner");
    expect(practice).not.toContain("# Purpose");
    expect(practice).not.toContain("# Question tools");
    expect(practice).not.toContain("# Reading confidence");
    expect(practice).not.toContain("# The learner's files");
  });

  it("keeps each composed prompt within a size guard (B-8-57)", () => {
    const { ps } = store();
    for (const agent of ["prober", "teacher", "practice"] as const) expect(ps.compose(agent).length).toBeLessThan(40_000);
  });

  it("states the register: dry voice, UK English, and the method of each agent", () => {
    const { ps } = store();
    expect(ps.sourceText("shared/10-voice")).toMatch(/dry, plain voice/);
    expect(ps.sourceText("shared/25-confidence")).toMatch(/0, 30, 50, 70, 90 and 100/);
    expect(ps.sourceText("practice/10-doctrine")).toMatch(/R0[\s\S]*R5/);
    expect(ps.sourceText("practice/10-doctrine")).toMatch(/85 per cent/);
  });
});

describe("the fragments follow the house register", () => {
  const dir = defaultPromptsDir();
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".md")) files.push(path.join(d, e.name));
    }
  };
  walk(dir);

  it("finds the whole set", () => {
    expect(files.length).toBe(1 + 7 + 1 + 6 + 2);
  });

  it.each(files.map((f) => [path.relative(dir, f).replace(/\\/g, "/"), f]))("%s has no dash, semicolon, contraction or exclamation mark in its prose", (_name, file) => {
    const text = fs
      .readFileSync(file, "utf8")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`]*`/g, "");
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/ - /);
    expect(text).not.toMatch(/;/);
    expect(text).not.toMatch(/!/);
    expect(text).not.toMatch(/\b\w+n't\b|\b(?:it|that|there|we|they|you|he|she|what|who)'s\b|\b\w+'(?:ll|re|ve|d)\b/i);
  });
});

describe("keys and overrides (B-8-52, B-8-53, B-8-55, B-8-56)", () => {
  it("accepts the base and a numbered fragment of the four folders, with or without the suffix", () => {
    expect(normaliseKey("system-prompt")).toBe("system-prompt");
    expect(normaliseKey("system-prompt.md")).toBe("system-prompt");
    expect(normaliseKey("teacher/20-teaching.md")).toBe("teacher/20-teaching");
    expect(normaliseKey("shared/10-voice")).toBe("shared/10-voice");
    expect(normaliseKey("practice/00-base")).toBe("practice/00-base");
    for (const bad of ["", "README.md", "teacher/README.md", "teacher/x-name.md", "teacher/20-a.txt", "../x", "teacher/../shared/10-voice", "/abs/20-a.md", "teacher", "teacher/", "a/b/20-c", "teacher\\20-a", "other/20-a", 5, null]) {
      expect(normaliseKey(bad), String(bad)).toBeNull();
    }
  });

  it("writes an override file and lists it, and a file alone never enables anything", () => {
    const { ps, s, learnDir } = store();
    expect(ps.write("teacher/20-teaching", "My teaching.")).toEqual({ written: true, key: "teacher/20-teaching" });
    expect(fs.readFileSync(path.join(learnDir, "prompts", "teacher", "20-teaching.md"), "utf8")).toBe("My teaching.");
    const entry = ps.list().teacher.find((e) => e.key === "teacher/20-teaching")!;
    expect(entry).toMatchObject({ override: "My teaching.", enabled: false });
    expect(ps.compose("teacher")).toBe(store().ps.compose("teacher"));
    expect(ps.compose("teacher")).not.toContain("My teaching.");
    // the switch with the file enables it, and the file with a false switch does not
    s.prompts["teacher/20-teaching.md"] = true;
    expect(ps.list().teacher.find((e) => e.key === "teacher/20-teaching")!.enabled).toBe(true);
    expect(ps.compose("teacher")).toContain("My teaching.");
    s.prompts["teacher/20-teaching.md"] = false;
    expect(ps.compose("teacher")).not.toContain("My teaching.");
  });

  it("does not enable a switch with no file and recomposes on each call (B-8-54)", () => {
    const { ps, s } = store();
    s.prompts["teacher/20-teaching.md"] = true;
    expect(ps.list().teacher.find((e) => e.key === "teacher/20-teaching")!.enabled).toBe(false);
    const before = ps.compose("teacher");
    expect(before).toContain("# Teaching one step at a time");
    ps.write("teacher/20-teaching", "Replacement.");
    const after = ps.compose("teacher");
    expect(after).toContain("Replacement.");
    expect(after).not.toContain("# Teaching one step at a time");
  });

  it("swaps one shared fragment for both agents that compose it, and an enabled empty override contributes nothing", () => {
    const { ps, s } = store();
    ps.write("shared/10-voice", "Speak like a pirate.");
    s.prompts["shared/10-voice.md"] = true;
    expect(ps.compose("prober")).toContain("Speak like a pirate.");
    expect(ps.compose("teacher")).toContain("Speak like a pirate.");
    expect(ps.compose("practice")).toContain("Speak like a pirate.");
    ps.write("shared/10-voice", "   ");
    const emptied = ps.compose("teacher");
    expect(emptied).not.toContain("# Voice");
    expect(emptied).not.toContain("pirate");
    // the shared key is the same in each list
    expect(ps.list().prober.find((e) => e.key === "shared/10-voice")!.override).toBe("   ");
    expect(ps.list().teacher.find((e) => e.key === "shared/10-voice")!.enabled).toBe(true);
  });

  it("composes byte for byte as the plain source with no switches", () => {
    const { ps } = store();
    for (const agent of ["prober", "teacher", "practice"] as const) {
      const expected = ps
        .segments(agent)
        .map((seg) => ps.sourceText(seg.key).trim())
        .filter(Boolean)
        .join(SEPARATOR);
      expect(ps.compose(agent)).toBe(expected);
    }
  });

  it("ignores an invalid key and a key that is not a current segment, and writes nothing outside the folder", () => {
    const { ps, learnDir } = store();
    expect(ps.write("../../escape", "x").written).toBe(false);
    expect(ps.write("teacher/99-unknown", "x").written).toBe(false);
    expect(ps.write("README.md", "x").written).toBe(false);
    expect(fs.existsSync(path.join(learnDir, "prompts"))).toBe(false);
    expect(fs.existsSync(path.join(learnDir, "..", "escape.md"))).toBe(false);
  });

  it("deletes idempotently and clears the switch with the file, and an orphan switch is healed on delete", () => {
    const { ps, s, learnDir } = store();
    ps.write("teacher/20-teaching", "Mine.");
    s.prompts["teacher/20-teaching.md"] = true;
    expect(ps.remove("teacher/20-teaching")).toEqual({ deleted: true, switchCleared: true });
    expect(fs.existsSync(path.join(learnDir, "prompts", "teacher", "20-teaching.md"))).toBe(false);
    expect("teacher/20-teaching.md" in s.prompts).toBe(false);
    expect(ps.remove("teacher/20-teaching")).toEqual({ deleted: true, switchCleared: false });
    // a switch that is on for a file that is gone is cleared by a delete, and reads as off meanwhile
    s.prompts["teacher/10-planning.md"] = true;
    expect(ps.list().teacher.find((e) => e.key === "teacher/10-planning")!.enabled).toBe(false);
    expect(ps.remove("teacher/10-planning").switchCleared).toBe(true);
    expect(ps.remove("not-a-key")).toEqual({ deleted: false, switchCleared: false });
  });
});

describe("the prompt routes 13 to 15", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  async function serve(env: MethodEnv) {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handleMethod(env.method, req, res, url.pathname, url.searchParams).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end("unhandled");
        }
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/learn`;
    return async (method: string, p: string, body?: unknown) => {
      const res = await fetch(base + p, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await res.text();
      let json: Record<string, unknown> | null;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = null;
      }
      return { status: res.status, json, headers: res.headers };
    };
  }

  it("lists the three agents, writes and deletes an override by its key (routes 13 to 15)", async () => {
    const env = makeMethodEnv();
    const call = await serve(env);
    const list = await call("GET", "/prompts");
    expect(list.status).toBe(200);
    expect(Object.keys(list.json!)).toEqual(["prober", "teacher", "practice"]);
    expect(list.headers.get("cache-control")).toBe("no-store");

    const put = await call("PUT", "/prompts/teacher/20-teaching", { text: "Mine." });
    expect(put.json).toMatchObject({ ok: true, key: "teacher/20-teaching" });
    env.switches.prompts["teacher/20-teaching.md"] = true;
    const after = (await call("GET", "/prompts")).json as { teacher: { key: string; override: string | null; enabled: boolean }[] };
    expect(after.teacher.find((e) => e.key === "teacher/20-teaching")).toMatchObject({ override: "Mine.", enabled: true });
    // the next agent that is built uses the override
    expect(env.method.prompts.compose("teacher")).toContain("Mine.");

    const withSuffix = await call("PUT", "/prompts/system-prompt.md", { text: "Base." });
    expect(withSuffix.json).toMatchObject({ ok: true, key: "system-prompt" });

    const del = await call("DELETE", "/prompts/teacher/20-teaching");
    expect(del.json).toEqual({ ok: true, deleted: true, switchCleared: true });
    expect(env.switches.prompts["teacher/20-teaching.md"]).toBeUndefined();
    expect((await call("DELETE", "/prompts/teacher/20-teaching")).json).toMatchObject({ deleted: true, switchCleared: false });
  });

  it("ignores an invalid key and refuses a bad body, a large body and another method", async () => {
    const env = makeMethodEnv();
    const call = await serve(env);
    expect((await call("PUT", "/prompts/..%2Fescape", { text: "x" })).json).toEqual({ ok: true, ignored: true });
    expect((await call("PUT", "/prompts/teacher/99-unknown", { text: "x" })).json).toEqual({ ok: true, ignored: true });
    expect((await call("DELETE", "/prompts/README.md")).json).toEqual({ ok: true, ignored: true });
    expect((await call("PUT", "/prompts/teacher/20-teaching", { text: 5 })).json).toMatchObject({ code: "bad_request" });
    expect((await call("PUT", "/prompts/teacher/20-teaching", "not json")).status).toBe(400);
    const big = await call("PUT", "/prompts/teacher/20-teaching", { text: "x".repeat(100_001) });
    expect(big.status).toBe(413);
    expect(big.json).toMatchObject({ code: "too_large" });
    expect((await call("POST", "/prompts")).status).toBe(405);
    expect((await call("GET", "/prompts/teacher/20-teaching")).status).toBe(405);
    expect((await call("GET", "/nothing")).status).toBe(404);
  });
});
