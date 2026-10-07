import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphFile, StreamMessage } from "../../shared/types.ts";
import { DEFAULT_PARAMS } from "./activation.ts";
import type { Config } from "./config.ts";
import { EventHub, makeEvent } from "./events.ts";
import { GraphStore, buildView } from "./graph.ts";
import { monthKey } from "./util.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ev-"));
  dirs.push(root);
  const cfg: Config = {
    claude_home: path.join(root, "home").replace(/\\/g, "/"),
    projects_root: root, memory_dir: root, data_dir: path.join(root, "data").replace(/\\/g, "/"),
    port: 5182, include_sensitivity: ["public"], log_prompt_snippets: false,
    python_cmd: "python", repo_root: root,
  };
  const sent: StreamMessage[] = [];
  const store = new GraphStore(cfg);
  const node = (id: string) => ({ id, type: "T", label: id, family: "instruction", path: null, summary: null, date: null, status: null, sensitivity: "internal", props: {}, metrics: { uses: 0, last_used: null, base_level: null, degree: 0 } });
  store.view = buildView({ v: 1, built: "b", relations: [{ id: "r", label: "r", inverse_label: "r", weight: 1, reverse_weight: 1 }], nodes: [node("a"), node("b")], edges: [{ s: "a", r: "r", t: "b", w: 1, evidence: null }] } as unknown as GraphFile, DEFAULT_PARAMS);
  const hub = new EventHub(cfg, store, (m) => sent.push(m));
  hub.init();
  return { cfg, hub, sent, root };
}

describe("events", () => {
  it("drops a repeat of the same session and key, and node ids that are not in the graph", () => {
    const { hub, sent } = setup();
    const ev = makeEvent({ session: "s1", source: "hook", kind: "read", nodes: ["a", "zzz"], weight: 1, key: "k1" });
    hub.append(ev);
    hub.append({ ...ev });
    hub.append({ ...ev, session: "s2" });
    hub.append({ ...ev, key: null });
    hub.append({ ...ev, key: null });
    const fires = sent.filter((m) => m.type === "fire");
    expect(fires).toHaveLength(4);
    const first = fires[0];
    if (first.type !== "fire") throw new Error("expected a fire message");
    expect(first.event.nodes).toEqual(["a"]);
    expect(first.activation.map((x) => x.id).sort()).toEqual(["a", "b"]);
  });

  it("turns a register record with faults into a stored fault event", () => {
    const { hub, sent, cfg } = setup();
    const dir = path.join(cfg.claude_home, "register-log");
    fs.mkdirSync(dir, { recursive: true });
    hub.init();
    const t = new Date().toISOString();
    fs.appendFileSync(path.join(dir, `${monthKey(new Date())}.jsonl`), JSON.stringify({ t, kind: "stop", session: "s9", path: "", faults: ["dashes", "colons"], metrics: {} }) + "\n");
    fs.appendFileSync(path.join(dir, `${monthKey(new Date())}.jsonl`), JSON.stringify({ t, kind: "stop", session: "s9", path: "", faults: [] }) + "\n");
    hub.pump();
    const fires = sent.filter((m) => m.type === "fire");
    expect(fires).toHaveLength(1);
    const f = fires[0];
    if (f.type !== "fire") throw new Error("expected a fire message");
    expect(f.event.kind).toBe("fault");
    expect(f.event.label).toBe("Register fault: dashes, colons");
    expect(f.event.key).toBe(`register:${t}:s9:`);
    const stored = fs.readFileSync(hub.eventsFile(monthKey(new Date())), "utf8");
    expect(stored).toContain("Register fault: dashes, colons");
  });
});
