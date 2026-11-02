// The prompt fragments and the overrides of the person. A system prompt is the
// base file, then the numbered fragments of the agent's own folder, then the
// shared fragments, joined by a horizontal rule. The practice agent has no base
// and takes only four shared fragments, so that the doctrine of the other
// agents stays out of it.
//
// An override is a file under <learn_dir>/prompts/<key>.md with a switch in
// settings agent.prompts["<key>.md"]. It composes only when the switch is on and
// the file is readable. File presence alone does nothing. An enabled and empty
// override contributes nothing and does not fall back to the source. The prompt
// is composed again whenever an agent is built, so an edit takes effect on the
// next turn and never changes an agent that is already running.
import fs from "node:fs";
import path from "node:path";
import { promptFolder } from "../prompt-folder.ts";
import type { PromptEntry, PromptList } from "../../../../shared/learn/index.ts";
import type { MethodSettings } from "./deps.ts";

export type PromptAgent = "prober" | "teacher" | "practice";

export const FRAGMENT = /^\d+-[\w-]+\.md$/;
const KEY = /^(?:system-prompt|(?:prober|teacher|practice|shared)\/\d+-[\w-]+)$/;
/** The shared fragments that the practice agent composes. */
export const PRACTICE_SHARED = ["shared/10-voice", "shared/15-accuracy", "shared/16-mental-model", "shared/40-formatting"];
export const SEPARATOR = "\n\n---\n\n";
export const MAX_OVERRIDE_CHARS = 100_000;

export const defaultPromptsDir = (): string => promptFolder(import.meta.url, "method");

/** Accepts a key with or without the .md suffix and returns the bare key, or null when it is not a valid key. */
export function normaliseKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.replace(/\.md$/, "");
  if (key.includes("..") || key.includes("\\") || !KEY.test(key)) return null;
  return key;
}

export interface Segment {
  key: string;
  agent: PromptEntry["agent"];
  shared: boolean;
}

export interface PromptStore {
  /** The segments of one agent in composition order. */
  segments(agent: PromptAgent): Segment[];
  /** Every key that composes into some agent. */
  allKeys(): string[];
  list(): PromptList;
  /** Writes an override file. A key that is invalid or not a current segment is ignored and the result says so. */
  write(rawKey: unknown, text: string): { written: boolean; key: string | null };
  /** Clears the switch and then removes the file. Idempotent, and an invalid key is ignored. */
  remove(rawKey: unknown): { deleted: boolean; switchCleared: boolean };
  readOverride(key: string): string | null;
  /** The system prompt of one agent, composed now from the source and the enabled overrides. */
  compose(agent: PromptAgent): string;
  sourceText(key: string): string;
}

export interface PromptStoreOptions {
  learnDir: string;
  settings: MethodSettings;
  promptsDir?: string;
}

export function createPromptStore(options: PromptStoreOptions): PromptStore {
  const sourceDir = options.promptsDir ?? defaultPromptsDir();
  const overrideDir = path.join(options.learnDir, "prompts");

  const fragmentsIn = (dir: string): string[] => {
    try {
      return fs.readdirSync(path.join(sourceDir, dir)).filter((f) => FRAGMENT.test(f)).sort();
    } catch {
      return [];
    }
  };

  function segments(agent: PromptAgent): Segment[] {
    const out: Segment[] = [];
    if (agent !== "practice" && fs.existsSync(path.join(sourceDir, "system-prompt.md"))) out.push({ key: "system-prompt", agent: "base", shared: true });
    for (const f of fragmentsIn(agent)) out.push({ key: `${agent}/${f.replace(/\.md$/, "")}`, agent, shared: false });
    for (const f of fragmentsIn("shared")) {
      const key = `shared/${f.replace(/\.md$/, "")}`;
      if (agent === "practice" && !PRACTICE_SHARED.includes(key)) continue;
      out.push({ key, agent: "shared", shared: true });
    }
    return out;
  }

  const allKeys = (): string[] => [...new Set((["prober", "teacher", "practice"] as const).flatMap((a) => segments(a).map((s) => s.key)))].sort();

  const overridePath = (key: string): string => path.join(overrideDir, `${key}.md`);

  function readOverride(key: string): string | null {
    if (!normaliseKey(key)) return null;
    try {
      return fs.readFileSync(overridePath(key), "utf8");
    } catch {
      return null;
    }
  }

  function sourceText(key: string): string {
    try {
      return fs.readFileSync(path.join(sourceDir, `${key}.md`), "utf8");
    } catch {
      return "";
    }
  }

  function entry(seg: Segment, switches: Record<string, boolean>): PromptEntry {
    const override = readOverride(seg.key);
    return {
      key: seg.key,
      agent: seg.agent,
      source: sourceText(seg.key),
      override,
      enabled: switches[`${seg.key}.md`] === true && override !== null,
      shared: seg.shared,
    };
  }

  return {
    segments,
    allKeys,
    list() {
      const switches = options.settings.promptSwitches();
      return {
        prober: segments("prober").map((s) => entry(s, switches)),
        teacher: segments("teacher").map((s) => entry(s, switches)),
        practice: segments("practice").map((s) => entry(s, switches)),
      };
    },
    write(rawKey, text) {
      const key = normaliseKey(rawKey);
      if (!key || !allKeys().includes(key)) return { written: false, key: null };
      const file = overridePath(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, "utf8");
      fs.renameSync(tmp, file);
      return { written: true, key };
    },
    remove(rawKey) {
      const key = normaliseKey(rawKey);
      if (!key) return { deleted: false, switchCleared: false };
      // the switch goes first, so that a crash leaves a file with its switch off and never a switch with no file
      const wasOn = options.settings.promptSwitches()[`${key}.md`] === true;
      if (`${key}.md` in options.settings.promptSwitches()) options.settings.clearPromptSwitch(`${key}.md`);
      try {
        fs.unlinkSync(overridePath(key));
      } catch {
        // already absent
      }
      return { deleted: true, switchCleared: wasOn };
    },
    readOverride,
    sourceText,
    compose(agent) {
      const switches = options.settings.promptSwitches();
      return segments(agent)
        .map((seg) => {
          const e = entry(seg, switches);
          return (e.enabled ? (e.override ?? "") : e.source).trim();
        })
        .filter(Boolean)
        .join(SEPARATOR);
    },
  };
}
