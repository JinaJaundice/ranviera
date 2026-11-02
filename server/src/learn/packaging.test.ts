// The packaged server is one bundle file, so the Markdown prompt fragments of the method and of the extraction must be
// copied beside it (scripts/build/learn-prompts.mjs) and the loaders must find them there. These tests copy the
// fragments into a folder that has the layout of the bundle and check that the prompts come out the same.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PROMPT_AREAS, bundleList, copyPromptFragments, markdownFiles } from "../../../scripts/build/learn-prompts.mjs";
import { EXTRACT_FRAGMENTS, createExtractPrompts } from "./extract/prompts/index.ts";
import { createPromptStore, defaultPromptsDir, type PromptAgent } from "./method/prompt-store.ts";
import { promptFolder } from "./prompt-folder.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const made: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bundle-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const AGENTS: PromptAgent[] = ["prober", "teacher", "practice"];
const switches = { tools: () => ({}), promptSwitches: () => ({}), clearPromptSwitch: () => {} };
const area = (name: string) => PROMPT_AREAS.find((a) => a.area === name)!;

/** Every prompt of the method and of the extraction, composed from one pair of folders. */
function composeAll(methodDir: string, extractDir: string): Record<string, string> {
  const store = createPromptStore({ learnDir: tmp(), settings: switches, promptsDir: methodDir });
  const extract = createExtractPrompts(extractDir);
  const out: Record<string, string> = {};
  for (const a of AGENTS) out[`method:${a}`] = store.compose(a);
  for (const shape of ["notes", "transcript", "session"] as const) out[`extract:${shape}`] = extract.extractorPrompt(shape);
  out["extract:auditor"] = extract.auditorPrompt();
  return out;
}

describe("the prompt fragments in the packaged server", () => {
  it("lists every Markdown fragment of both folders in the bundle list", () => {
    const listed = new Set(bundleList().map((i) => i.to));
    for (const a of PROMPT_AREAS) {
      const found = markdownFiles(path.join(ROOT, a.from));
      expect(found.length).toBeGreaterThan(0);
      for (const f of found) expect(listed.has(`${a.to}/${f}`)).toBe(true);
    }
    for (const name of EXTRACT_FRAGMENTS) expect(listed.has(`learn-prompts/extract/${name}`)).toBe(true);
    // the numbered fragments of the three agents and the base prompt
    expect(listed.has("learn-prompts/method/system-prompt.md")).toBe(true);
    expect([...listed].filter((p) => /learn-prompts\/method\/(teacher|prober|practice|shared)\//.test(p)).length).toBeGreaterThanOrEqual(15);
  });

  it("copies the fragments so that the loaders compose the same prompts from the bundle layout", () => {
    const out = tmp();
    const written = copyPromptFragments(out);
    expect(written.length).toBe(bundleList().length);
    const fromBundle = composeAll(path.join(out, area("method").to), path.join(out, area("extract").to));
    const fromRepository = composeAll(path.join(ROOT, area("method").from), path.join(ROOT, area("extract").from));
    expect(fromBundle).toEqual(fromRepository);
    expect(Object.keys(fromBundle)).toHaveLength(AGENTS.length + 4);
    for (const text of Object.values(fromBundle)) expect(text.length).toBeGreaterThan(200);
  });

  it("fails when a fragment is missing from the bundle", () => {
    const out = tmp();
    copyPromptFragments(out);
    const repository = composeAll(path.join(ROOT, area("method").from), path.join(ROOT, area("extract").from));
    // a numbered fragment of the teacher changes the teacher prompt
    fs.rmSync(path.join(out, area("method").to, "teacher", "20-teaching.md"));
    const method = composeAll(path.join(out, area("method").to), path.join(out, area("extract").to));
    expect(method["method:teacher"]).not.toEqual(repository["method:teacher"]);
    // a fragment of the extraction cannot be composed at all
    fs.rmSync(path.join(out, area("extract").to, "auditor.md"));
    expect(() => createExtractPrompts(path.join(out, area("extract").to)).auditorPrompt()).toThrow();
  });

  it("finds the folder in the repository and in the bundle", () => {
    // the repository: the fragments sit in a folder named prompts beside the module
    expect(defaultPromptsDir().replace(/\\/g, "/")).toBe(path.join(ROOT, area("method").from).replace(/\\/g, "/") + "/");
    // the bundle: no prompts folder beside the file, and learn-prompts/<area> instead
    const out = tmp();
    copyPromptFragments(out);
    const bundleFile = pathToFileURL(path.join(out, "server.mjs")).href;
    expect(promptFolder(bundleFile, "method")).toBe(path.join(out, "learn-prompts", "method") + path.sep);
    expect(promptFolder(bundleFile, "extract")).toBe(path.join(out, "learn-prompts", "extract") + path.sep);
  });
});
