// Reads cortex.config.json from the repository root, or from CORTEX_CONFIG, and applies the environment variables.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BRAIN_DOMAINS, type BrainDomains } from "../../shared/brain.ts";
import type { Product, Sensitivity } from "../../shared/types.ts";
import { norm } from "./util.ts";

export interface Config {
  claude_home: string;
  /** an optional folder of projects. When it is null, the project harvesters read nothing. */
  projects_root: string | null;
  /** a memory folder, or "auto" for every memory folder under <claude_home>/projects that holds a MEMORY.md */
  memory_dir: string;
  data_dir: string;
  port: number;
  /** the Python executable that runs the compiler in development */
  python_cmd: string;
  include_sensitivity: Sensitivity[];
  log_prompt_snippets: boolean;
  /** missions keep ANTHROPIC_API_KEY only when this is true, so by default they run on the claude.ai plan */
  missions_use_api_key?: boolean;
  repo_root: string;
  /** the name shown and the default data folder (6 October 2026) */
  product?: Product;
  version?: string;
  /** the words that place an instruction node in the writing or the visual region (docs/BRAIN.md) */
  brain_domains?: BrainDomains;
  /** the command that runs the compiler, for example the bundled ranviera-kg executable; null runs python_cmd with cortex.py */
  kg_cmd?: string[] | null;
  /** the access token of the packaged app. When it is set, every /api request must carry it. */
  token?: string | null;
  /** the built web folder and the ontology folder, when the packaged app names them */
  static_dir?: string | null;
  ontology_dir?: string | null;
  profile_dir?: string | null;
  /** the people file of the oversight views, the person who uses this installation, and the demonstration switch (docs/CONTRACTS.md, "Identity and roles") */
  oversight_people?: string | null;
  oversight_actor?: string | null;
  oversight_demo?: boolean;
  /** the configuration file that was read, or would be written */
  config_file?: string;
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..").replace(/\\/g, "/");

const DEFAULTS = {
  claude_home: "~/.claude",
  projects_root: null as string | null,
  memory_dir: "auto",
  data_dir: "",
  profile_dir: "",
  port: 5182,
  python_cmd: "",
  product: "ranviera" as Product,
  kg_cmd: null as string[] | null,
  include_sensitivity: ["public", "internal", "client-confidential"] as Sensitivity[],
  log_prompt_snippets: false,
  missions_use_api_key: false,
  brain_domains: null as Partial<BrainDomains> | null,
  oversight_people: null as string | null,
  oversight_actor: null as string | null,
  oversight_demo: false,
};

/** True when the server runs from the packaged app, which names its web and ontology folders. */
export const isPackaged = (env: NodeJS.ProcessEnv = process.env): boolean => Boolean(env.CORTEX_STATIC || env.CORTEX_ONTOLOGY);

/** The version, in order: CORTEX_VERSION, the constant that the bundle build defines, then package.json. */
export function readVersion(env: NodeJS.ProcessEnv = process.env, built: string | undefined = process.env.CORTEX_BUILD_VERSION): string {
  if (env.CORTEX_VERSION) return env.CORTEX_VERSION;
  if (built) return built;
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version?: unknown }).version;
    if (typeof v === "string" && v) return v;
  } catch {
    // a bundled server may sit beside no package.json
  }
  // a packaged build never reports 0.0.0, so a bundle with no version says so
  return isPackaged(env) ? "unknown" : "0.0.0";
}

function wordList(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const words = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().toLowerCase());
  return words.length > 0 ? words : fallback;
}

function parseKgCmd(v: unknown): string[] | null {
  if (typeof v === "string") {
    try {
      return parseKgCmd(JSON.parse(v));
    } catch {
      return v.trim() ? [v.trim()] : null;
    }
  }
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x)) return v as string[];
  return null;
}

const isTrue = (v: unknown): boolean => v === true || (typeof v === "string" && /^(1|true|yes)$/i.test(v.trim()));
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The configuration file. A packaged app reads CORTEX_CONFIG only, and with none set it reads no file, so nothing beside the bundle is read or written. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CORTEX_CONFIG) return path.resolve(env.CORTEX_CONFIG);
  return isPackaged(env) ? "" : path.join(REPO_ROOT, "cortex.config.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = configPath(env);
  let raw: Partial<typeof DEFAULTS> = {};
  if (file && fs.existsSync(file)) {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<typeof DEFAULTS>;
  }
  const c = { ...DEFAULTS, ...raw };
  const product: Product = c.product === "cortex" ? "cortex" : "ranviera";
  const claudeHome = norm(c.claude_home);
  const dataDir = env.CORTEX_DATA_DIR || c.data_dir || path.join(claudeHome, product === "cortex" ? "cortex" : "ranviera");
  const port = env.CORTEX_PORT !== undefined && env.CORTEX_PORT !== "" ? Number(env.CORTEX_PORT) : Number(c.port);
  return {
    claude_home: claudeHome,
    projects_root: typeof c.projects_root === "string" && c.projects_root.trim() ? norm(c.projects_root) : null,
    memory_dir: c.memory_dir === "auto" ? "auto" : norm(c.memory_dir),
    data_dir: norm(dataDir),
    port: Number.isFinite(port) ? port : 5182,
    python_cmd: typeof c.python_cmd === "string" && c.python_cmd.trim() ? c.python_cmd.trim() : process.platform === "win32" ? "python" : "python3",
    include_sensitivity: c.include_sensitivity,
    log_prompt_snippets: Boolean(c.log_prompt_snippets),
    missions_use_api_key: Boolean(c.missions_use_api_key),
    repo_root: REPO_ROOT,
    product,
    version: readVersion(env),
    brain_domains: {
      writing: wordList(c.brain_domains?.writing, DEFAULT_BRAIN_DOMAINS.writing),
      visual: wordList(c.brain_domains?.visual, DEFAULT_BRAIN_DOMAINS.visual),
    },
    kg_cmd: parseKgCmd(env.CORTEX_KG_CMD) ?? parseKgCmd(c.kg_cmd),
    token: env.CORTEX_TOKEN || null,
    static_dir: env.CORTEX_STATIC ? norm(env.CORTEX_STATIC) : null,
    ontology_dir: env.CORTEX_ONTOLOGY ? norm(env.CORTEX_ONTOLOGY) : null,
    profile_dir: norm(c.profile_dir || path.join(dataDir, "profile")),
    oversight_people: (() => {
      const v = text(env.CORTEX_OVERSIGHT_PEOPLE) ?? text(c.oversight_people);
      return v ? norm(v) : null;
    })(),
    oversight_actor: text(env.RANVIERA_ACTOR) ?? text(c.oversight_actor),
    oversight_demo: env.RANVIERA_DEMO !== undefined && env.RANVIERA_DEMO !== "" ? isTrue(env.RANVIERA_DEMO) : isTrue(c.oversight_demo),
    config_file: file ? file.replace(/\\/g, "/") : undefined,
  };
}

/** The built web folder: CORTEX_STATIC when set, the repository's dist folder otherwise. */
export const staticDir = (cfg: Config): string => cfg.static_dir || path.join(cfg.repo_root, "dist");
/** The ontology folder: CORTEX_ONTOLOGY when set, the repository's ontology folder otherwise. */
export const ontologyDir = (cfg: Config): string => cfg.ontology_dir || path.join(cfg.repo_root, "ontology");
export const productOf = (cfg: Config): Product => cfg.product ?? "ranviera";
export const versionOf = (cfg: Config): string => cfg.version ?? readVersion();
