/// <reference types="node" />
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CLASS_REGION, DEFAULT_BRAIN_DOMAINS, REGIONS, REGION_IDS, clusterOf, fileKeyOf, pathMatches, regionOf } from "@shared/brain";

const ttl = readFileSync(new URL("../../../../ontology/cortex.ttl", import.meta.url), "utf8");
const CLASSES = [...ttl.matchAll(/^cx:(\w+) a owl:Class/gm)].map((m) => m[1]);

const EXPECTED: Record<string, string> = {
  InstructionFile: "prefrontal",
  MapFile: "prefrontal",
  RuleFile: "prefrontal",
  Skill: "prefrontal",
  ReferenceFile: "prefrontal",
  GuideFile: "prefrontal",
  Section: "prefrontal",
  Rule: "prefrontal",
  PathScope: "prefrontal",
  Decision: "prefrontal",
  OutputStyle: "language",
  Concept: "language",
  ConceptScheme: "language",
  Template: "occipital",
  Tool: "motor",
  BuiltinTool: "motor",
  LaunchConfig: "motor",
  Project: "parietal",
  App: "parietal",
  Deliverable: "parietal",
  Folder: "parietal",
  BacklogSection: "parietal",
  OpenItem: "parietal",
  Organisation: "parietal",
  Client: "parietal",
  Person: "parietal",
  Instrument: "parietal",
  MemoryFile: "memory",
  RecordStore: "memory",
  HistoryFile: "memory",
  Gate: "basal",
  FaultCheck: "basal",
  Finding: "basal",
  TaskType: "thalamus",
  Route: "thalamus",
  Agent: "cerebellum",
  Hook: "brainstem",
  ScheduledTask: "brainstem",
};

describe("regions", () => {
  it("lists the 10 regions of docs/BRAIN.md in order", () => {
    expect(REGION_IDS).toEqual(["prefrontal", "language", "occipital", "motor", "parietal", "memory", "basal", "thalamus", "cerebellum", "brainstem"]);
    for (const r of REGIONS) {
      expect(r.name.length).toBeGreaterThan(3);
      expect(r.label.length).toBeGreaterThan(3);
      expect(r.func.length).toBeGreaterThan(8);
      expect(r.source.length).toBeGreaterThan(8);
    }
  });

  it("finds every class of ontology/cortex.ttl", () => {
    expect(CLASSES.length).toBeGreaterThanOrEqual(38);
    expect(CLASSES).toContain("Finding");
  });

  it.each(CLASSES)("places a node of the class %s in the region of the table", (type) => {
    // a path with no domain word, so that only the class decides
    expect(regionOf({ type, path: "C:/Users/p/.claude/rules/apps.md" })).toBe(EXPECTED[type]);
  });

  it("has an explicit mapping for every class and no class beyond the ontology", () => {
    expect(Object.keys(CLASS_REGION).sort()).toEqual([...CLASSES].sort());
  });
});

describe("domains", () => {
  const rule = (path: string) => regionOf({ type: "Rule", path });

  it("places a rule in the writing domain in the language region", () => {
    expect(rule("C:/Users/p/.claude/rules/writing.md")).toBe("language");
    expect(rule("C:/Users/p/.claude/skills/plain-writing-voice/FCA_REGISTER.md")).toBe("language");
    expect(rule("C:/Users/p/.claude/skills/tone-guide/SKILL.md")).toBe("language");
  });

  it("places a rule in the visual domain in the occipital region", () => {
    expect(rule("C:/Users/p/.claude/rules/decks.md")).toBe("occipital");
    expect(rule("C:/Users/p/.claude/rules/visuals.md")).toBe("occipital");
    expect(rule("C:/Users/p/.claude/skills/x/references/chart-rules.md")).toBe("occipital");
  });

  it("takes the domain from the container path when it is given", () => {
    expect(regionOf({ type: "Section", path: null }, "rules/writing.md")).toBe("language");
    expect(regionOf({ type: "Rule", path: "rules/writing.md" }, "rules/process.md")).toBe("prefrontal");
  });

  it("places a rule that matches neither list in the prefrontal region", () => {
    expect(rule("C:/Users/p/.claude/rules/apps.md")).toBe("prefrontal");
    expect(rule("")).toBe("prefrontal");
  });

  it("gives the writing domain priority when both lists match", () => {
    expect(rule("rules/writing-for-decks.md")).toBe("language");
  });

  it("matches a word only at the start of a word", () => {
    expect(pathMatches("rules/rewrite.md", ["writ"])).toBe(false);
    expect(pathMatches("rules/stone.md", ["tone"])).toBe(false);
    expect(pathMatches("rules/Writing.md", ["writ"])).toBe(true);
    expect(pathMatches("a/b/slides-2.md", ["slide"])).toBe(true);
  });

  it("applies a domain list from the configuration", () => {
    const domains = { writing: ["legal"], visual: ["video"] };
    expect(regionOf({ type: "Rule", path: "rules/legal.md" }, null, domains)).toBe("language");
    expect(regionOf({ type: "Rule", path: "rules/video.md" }, null, domains)).toBe("occipital");
    expect(regionOf({ type: "Rule", path: "rules/writing.md" }, null, domains)).toBe("prefrontal");
  });

  it("applies the domain to instruction files and sections as well as rules", () => {
    for (const type of ["InstructionFile", "MapFile", "RuleFile", "Skill", "ReferenceFile", "GuideFile", "Section"]) {
      expect(regionOf({ type, path: "x/writing.md" }), type).toBe("language");
      expect(regionOf({ type, path: "x/decks.md" }), type).toBe("occipital");
    }
  });

  it("does not apply the domain to a class outside the instruction group", () => {
    expect(regionOf({ type: "Deliverable", path: "deliverables/decks/writing.md" })).toBe("parietal");
    expect(regionOf({ type: "MemoryFile", path: "memory/writing.md" })).toBe("memory");
    expect(regionOf({ type: "Template", path: "x/writing.md" })).toBe("occipital");
  });

  it("holds the word lists of docs/BRAIN.md", () => {
    expect(DEFAULT_BRAIN_DOMAINS.writing).toEqual(["writ", "voice", "register", "style", "tone", "prose", "lexicon"]);
    expect(DEFAULT_BRAIN_DOMAINS.visual).toEqual(["deck", "slide", "visual", "chart", "figure", "poster", "design", "template"]);
  });
});

describe("a class the table does not name", () => {
  it("goes to the prefrontal region and is reported once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(regionOf({ type: "Strange", path: null })).toBe("prefrontal");
    expect(regionOf({ type: "Strange", path: null })).toBe("prefrontal");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("category names", () => {
  it("names all 10 regions after the category, with the anatomical name kept apart", () => {
    expect(REGIONS.map((r) => r.label)).toEqual([
      "Rules and decisions",
      "Writing and vocabulary",
      "Decks and visuals",
      "Tools and scripts",
      "Projects and deliverables",
      "Memory and history",
      "Checks and gates",
      "Task routing",
      "Agents",
      "Hooks and schedules",
    ]);
    for (const r of REGIONS) expect(r.label).not.toBe(r.name);
  });
});

describe("clusters", () => {
  const n = (type: string, id: string, label: string, path: string | null = null, props: Record<string, unknown> = {}) => ({ type, id, label, path, props });
  const rules = "C:/Users/p/.claude/rules/apps.md";

  it("gives every class of the ontology a cluster with a key and a label", () => {
    for (const type of CLASSES) {
      const c = clusterOf(n(type, `${type.toLowerCase()}:x`, "A node", rules, {}));
      expect(c.key.length, type).toBeGreaterThan(2);
      expect(c.label.length, type).toBeGreaterThan(0);
    }
  });

  it("groups a rule, a section and the file itself under the file", () => {
    const file = clusterOf(n("RuleFile", "rulefile:apps", "apps", rules));
    expect(clusterOf(n("Rule", "rule:a", "Do x", rules)).key).toBe(file.key);
    expect(clusterOf(n("Section", "section:a", "A section", rules)).key).toBe(file.key);
    expect(clusterOf(n("PathScope", "scope:a", "**/apps/**", null, { evidence: "claude/rules/apps.md:9" })).key).toBe(file.key);
    expect(file.label).toBe("apps");
    expect(fileKeyOf("projects/BACKLOG.md:7")).toBe(fileKeyOf("C:/Users/p/Downloads/Projects/BACKLOG.md"));
  });

  it("names a skill or a map file after its folder", () => {
    expect(clusterOf(n("Skill", "skill:a", "a", "C:/Users/p/.claude/skills/plain-writing/SKILL.md")).label).toBe("plain-writing");
    expect(clusterOf(n("MapFile", "claudemd:a", "a", "C:/Users/p/Projects/apps/northwind/CLAUDE.md")).label).toBe("northwind");
  });

  it("falls back to the file key of a rule that has no path", () => {
    expect(clusterOf(n("Rule", "rule:b", "x", null, { file_key: "academy-decks" }))).toEqual({ key: "file:academy-decks", label: "academy-decks" });
  });

  it("groups a deliverable under its project folder", () => {
    expect(clusterOf(n("Deliverable", "d:1", "Deck", "C:/P/deliverables/client-a/x/y.md", { folder: "client-a" }))).toEqual({ key: "project:client-a", label: "client-a" });
    expect(clusterOf(n("Deliverable", "d:2", "Deck", "C:/P/deliverables/course-b/final/y.md")).label).toBe("course-b");
  });

  it("groups an open item with its backlog section and names it after the section", () => {
    const section = n("BacklogSection", "backlog:11-baringa", "11. Baringa interview", null);
    const item = n("OpenItem", "openitem:11-baringa-38d5dc3c", "Do a thing");
    expect(clusterOf(section).key).toBe("backlog:11-baringa");
    expect(clusterOf(item).key).toBe("backlog:11-baringa");
    expect(clusterOf(section).label).toBe("Baringa interview");
    expect(clusterOf(item, (id) => (id === section.id ? section : undefined)).label).toBe("Baringa interview");
    expect(clusterOf(item).label).toBe("11 baringa");
  });

  it("groups a memory file by its type and a tool by its kind", () => {
    expect(clusterOf(n("MemoryFile", "m:1", "x", null, { memoryType: "project" }))).toEqual({ key: "memory:project", label: "Project memory files" });
    expect(clusterOf(n("MemoryFile", "m:2", "x")).key).toBe("memory:other");
    expect(clusterOf(n("Tool", "t:1", "x", null, { scope: "build" }))).toEqual({ key: "tool:build", label: "Build tools" });
    expect(clusterOf(n("BuiltinTool", "b:1", "Bash", null, { origin: "external" })).label).toBe("Built-in tools");
    expect(clusterOf(n("FaultCheck", "f:1", "x", null, { script: "tools/register/hook.py" })).label).toBe("hook.py checks");
    expect(clusterOf(n("Gate", "g:1", "x", null, { kind: "agent" })).label).toBe("Agent gates");
  });

  it("makes each agent, task type and hook its own cluster", () => {
    for (const type of ["Agent", "TaskType", "Hook"]) {
      expect(clusterOf(n(type, `${type}:a`, "Alpha"))).toEqual({ key: `self:${type}:a`, label: "Alpha" });
      expect(clusterOf(n(type, `${type}:b`, "Beta")).key).not.toBe(clusterOf(n(type, `${type}:a`, "Alpha")).key);
    }
  });
});
