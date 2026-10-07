// The public content check of docs/DISTRIBUTION.md.
//
// Usage:
//   node scripts/public/check.mjs <tree> [--denylist <file>] [--data-dir <folder>]
//   node scripts/public/check.mjs --seed [--data-dir <folder>] [--name "Full Name"]... [--term <word>]... [--force]
//
// The check fails, and names each file and line, when the tree holds
//   - a term of the private deny list (<data_dir>/overlay/public_denylist.txt, never committed)
//   - a secret, found by the patterns of the sync's secret scan (kg/cortex_kg/sync.py)
//   - an absolute path that names a user folder
//   - an e-mail address other than the GitHub no-reply form
//   - a file over 5 MB other than the brain model.
// The seed writes the deny list. It refuses to write inside a git working tree, so that the list is never committed.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");

export const MAX_BYTES = 5 * 1024 * 1024;
// Build output and installed packages are ignored by git and never published, so the check skips them.
export const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", "dist", "build", "release", ".pytest_cache"]);
const BRAIN_MODEL = /(^|\/)brain\/(brain\.glb|brain-points\.bin)$/;

// The patterns of SECRET_PATTERNS in kg/cortex_kg/sync.py, written for JavaScript.
const PLACEHOLDER = String.raw`(?!(?:\{\{|\$|<|%|os\.|process\.|env\.|your|example|xxxx|\.\.\.|changeme|placeholder|none\b|null\b))`;
export const SECRET_PATTERNS = [
  ["GitHub token", /gh[opsu]_[A-Za-z0-9]{20,}/],
  ["GitHub fine-grained token", /github_pat_[A-Za-z0-9_]{20,}/],
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{10,}/],
  ["API key with the sk- prefix", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["Slack token", /\bxox[abeprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/],
  ["authorization header", /\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/i],
  ["bearer token", new RegExp(String.raw`\bbearer\s+${PLACEHOLDER}[A-Za-z0-9._~+/=-]{20,}`, "i")],
  ["credentials in a URL", new RegExp(String.raw`\b[a-z][a-z0-9+.-]*://[^\s/:@"'<>]+:${PLACEHOLDER}[^\s/@"'<>{}]{3,}@`)],
  ["password value", /password["']?\s*[:=]\s*["']?[^\s"'<>{}$*[\]()]{4,}/i],
  [
    "key or secret assignment",
    new RegExp(
      String.raw`(?<![A-Za-z])[a-z0-9_.-]*(?:api[_\- ]?key|apikey|secret|token|passwd|credential|auth[_-]?key)[a-z0-9_-]*` +
        String.raw`["']?\s*[:=]\s*["']?${PLACEHOLDER}[A-Za-z0-9_\-+/=.]{16,}(?![A-Za-z0-9_\-+/=.]|\s*[=(])`,
      "i",
    ),
  ],
  [
    "environment-style secret line",
    new RegExp(
      String.raw`^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)=${PLACEHOLDER}[^\s"'<>]{8,}\s*$`,
    ),
  ],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

// An e-mail address. The last label must be letters, so a version such as pkg@1.2.3 is not one.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
// The GitHub no-reply form, Anthropic's no-reply address in commit trailers, and the domains reserved for examples
// and the top-level domains .test, .example and .invalid (RFC 2606) are public by design.
const EMAIL_OK = /(?:@users\.noreply\.github\.com|^noreply@anthropic\.com|@example\.(?:com|org|net)|\.(?:test|example|invalid))$/i;

// An absolute path into a user folder. The capture is the user name, which a placeholder may fill.
const USER_PATH = /(?:[A-Za-z]:)?[\\/]{1,4}Users[\\/]{1,4}([^\\/\s"'`<>*|)\]},;:]+)|(?<![\w.~-])\/home\/([^\\/\s"'`<>*|)\]},;:]+)/g;
const PATH_PLACEHOLDER =
  /^(?:<.*>|%.*%|\$.*|\{.*\}|\[.*\]|username|user|you|yourname|your-name|name|me|someone|example|runner|runneradmin|public|default|all users|default user|\.\.\.|x+|[a-z]|test|tester|person|jdoe|janedoe|johndoe|alice|bob|dev)$/i;

// A test file that must hold fake keys, such as the tests of the secret scanner, says so in its first 15 lines with this
// marker. The marker lifts only the secret rule, and only in a test file. The deny list and the other rules still apply.
const SYNTHETIC_SECRETS = /public-check: synthetic-secrets/;
const TEST_FILE = /(?:^|\/)(?:tests?|__fixtures__|fixtures)\/|\.test\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$/;

export function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

export function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) visit(full);
      } else if (st.isFile()) out.push({ full, rel: relative(root, full).split(sep).join("/"), size: st.size });
    }
  };
  visit(root);
  return out;
}

// A deny-list line is a term. Blank lines and lines that start with # are ignored. A term of 3 characters or fewer
// (an initialism such as a firm's short name) is matched with its case, and a longer term in any case. A term matches
// as a whole word, so that a short user name does not match inside a longer word.
export function parseDenylist(text) {
  const terms = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith("#") || seen.has(t)) continue;
    seen.add(t);
    terms.push(t);
  }
  return terms;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function compileTerms(terms) {
  return terms.map((term) => ({
    term,
    re: new RegExp(`(?<![A-Za-z0-9])${escapeRe(term)}(?![A-Za-z0-9])`, term.length <= 3 ? "" : "i"),
  }));
}

/**
 * Checks every file under root and returns the hits as { file, line, kind, detail }.
 * options.denylist is an array of terms, options.maxBytes overrides the size limit.
 */
export function checkTree(root, options = {}) {
  const hits = [];
  const terms = compileTerms(options.denylist ?? []);
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  for (const { full, rel, size } of walk(root)) {
    if (size > maxBytes && !BRAIN_MODEL.test(rel)) {
      hits.push({ file: rel, line: 0, kind: "size", detail: `${(size / 1048576).toFixed(1)} MB is over the limit of ${(maxBytes / 1048576).toFixed(0)} MB` });
    }
    // A file name is part of the public tree, so it is checked against the deny list too.
    for (const { term, re } of terms) {
      if (re.test(rel)) hits.push({ file: rel, line: 0, kind: "denylist", detail: `file name holds the private term '${term}'` });
    }
    if (size > maxBytes * 4) continue; // far too large to read as text, already reported
    const buf = readFileSync(full);
    if (isBinary(buf)) continue;
    const lines = buf.toString("utf8").split(/\r?\n/);
    const syntheticSecrets = TEST_FILE.test(rel) && lines.slice(0, 15).some((l) => SYNTHETIC_SECRETS.test(l));
    lines.forEach((text, i) => {
      const line = i + 1;
      for (const { term, re } of terms) {
        if (re.test(text)) hits.push({ file: rel, line, kind: "denylist", detail: `private term '${term}'` });
      }
      const found = SECRET_PATTERNS.find(([, re]) => re.test(text)); // one hit for each line, whatever the patterns
      if (found && !syntheticSecrets) hits.push({ file: rel, line, kind: "secret", detail: found[0] });
      for (const m of text.matchAll(USER_PATH)) {
        const user = (m[1] ?? m[2] ?? "").trim();
        if (user && !PATH_PLACEHOLDER.test(user)) hits.push({ file: rel, line, kind: "user-path", detail: `absolute path into the folder of user '${user}'` });
      }
      for (const m of text.matchAll(EMAIL)) {
        if (!EMAIL_OK.test(m[0])) hits.push({ file: rel, line, kind: "email", detail: "e-mail address other than a no-reply or example address" });
      }
    });
  }
  return hits;
}

export function formatHit(h) {
  return `${h.file}${h.line ? `:${h.line}` : ""}  ${h.kind}: ${h.detail}`;
}

// ---------------------------------------------------------------- the data folder and the deny list

function expandHome(p) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** The data folder: --data-dir, then CORTEX_DATA_DIR, then data_dir of the configuration, then the default folders. */
export function resolveDataDir(explicit) {
  if (explicit) return resolve(expandHome(explicit));
  if (process.env.CORTEX_DATA_DIR) return resolve(expandHome(process.env.CORTEX_DATA_DIR));
  const cfgPath = process.env.CORTEX_CONFIG ?? join(REPO, "cortex.config.json");
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      if (cfg.data_dir) return resolve(expandHome(cfg.data_dir));
    } catch {
      /* a malformed configuration falls through to the defaults */
    }
  }
  const claude = join(homedir(), ".claude");
  for (const name of ["cortex", "ranviera"]) if (existsSync(join(claude, name))) return join(claude, name);
  return join(claude, "ranviera");
}

export function denylistPath(dataDir) {
  return join(dataDir, "overlay", "public_denylist.txt");
}

// Single common words that name one of the projects. They are left out of the seed, because a deny list that
// flags every use of 'engine' would be ignored. A project that needs one of them can be added with --term.
const COMMON_WORDS = new Set([
  "engine", "foresight", "navigator", "docket", "imprint", "sentinel", "postern", "demo", "delivery", "handbook",
  "capabilities", "leadership", "portfolio", "proposal", "academy", "toolkit", "ontology", "knowledge",
]);

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function jsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
}

const NAMED_PREFIXES = new Set(["client", "person", "project", "app", "org", "deliverable"]);

/**
 * Builds the list of private terms. It reads the overlay of the data folder and, where it exists, the committed
 * entities scheme of the repository, and it writes nothing. options.names and options.terms add to the list.
 */
export function buildSeed({ dataDir, repoRoot = REPO, names = [], terms = [] }) {
  const out = new Map(); // term -> source
  const add = (t, source) => {
    const v = String(t ?? "").trim();
    // A bare number such as 0.95 identifies nobody and matches ordinary constants in code. A figure with a unit or a
    // currency (a percentage, a share in words or a sum in pounds) stays on the list, because it can be a private commercial term.
    if (v.length < 3 || out.has(v) || /^\d+(?:[.,]\d+)*$/.test(v)) return;
    out.set(v, source);
  };
  for (const n of names) {
    add(n, "name given on the command line");
    for (const part of n.split(/\s+/)) add(part, "part of a name given on the command line");
  }
  for (const t of terms) add(t, "term given on the command line");
  const account = userInfo().username;
  add(account, "operating system user name");
  add(basename(homedir()), "home folder name");

  // Client names that the privacy filter of the compiler already treats as private.
  const priv = join(repoRoot, "kg", "cortex_kg", "privacy.py");
  if (existsSync(priv)) {
    const m = readFileSync(priv, "utf8").match(/CLIENT_NAME\s*=\s*re\.compile\(r"\\b\(\?:([^)]*)\)\\b"/);
    if (m) for (const t of m[1].split("|")) add(t, "client list of kg/cortex_kg/privacy.py");
  }

  const overlay = join(dataDir, "overlay");
  // The values that the privacy filter hides (private_values.json maps a token to the value) and any hand-kept terms.
  const values = readJson(join(overlay, "private_values.json"));
  if (values && typeof values === "object" && !Array.isArray(values)) for (const v of Object.values(values)) add(v, "overlay private_values.json");
  const extra = readJson(join(overlay, "private_terms.json"));
  // private_terms.json is a list, or an object of lists such as { clients, projects, people } (kg/cortex_kg/privacy.py).
  const termLists = Array.isArray(extra) ? [extra] : Object.values(extra ?? {}).filter(Array.isArray);
  for (const list of termLists) for (const t of list) add(t, "overlay private_terms.json");
  for (const f of jsonFiles(join(overlay, "vocab"))) {
    for (const c of readJson(f)?.concepts ?? []) {
      add(c.prefLabel, `overlay vocabulary ${basename(f)}`);
      for (const a of c.altLabels ?? []) add(a, `overlay vocabulary ${basename(f)}`);
    }
  }
  for (const f of jsonFiles(join(overlay, "assertions"))) {
    for (const a of readJson(f)?.assertions ?? []) {
      for (const id of [a.s, a.t]) {
        const [prefix, slug] = String(id ?? "").split(/:(.*)/s);
        if (!NAMED_PREFIXES.has(prefix) || !slug) continue;
        if (slug.includes("-")) add(slug, `overlay assertion ${basename(f)}`);
        else if (!COMMON_WORDS.has(slug)) add(slug, `overlay assertion ${basename(f)}`);
      }
    }
  }
  // The committed entities scheme names the clients, people and projects of the private copy.
  for (const base of [join(repoRoot, "ontology", "vocab"), join(repoRoot, "profile", "vocab")]) {
    const data = readJson(join(base, "entities.json"));
    for (const c of data?.concepts ?? []) {
      // Regulators, instruments and vendors are public names, so only clients, people, projects and apps are taken.
      if (!(c.denotes ?? []).some((d) => /^(client|person|project|app):/.test(d))) continue;
      const usable = (label) => !COMMON_WORDS.has(String(label).toLowerCase()) && !/^the /i.test(String(label));
      if (usable(c.prefLabel)) add(c.prefLabel, "entities scheme");
      for (const a of c.altLabels ?? []) if (usable(a)) add(a, "entities scheme");
    }
  }
  add("JinaJaundice" + "/cortex", "the private repository");
  return out;
}

function insideGitTree(path) {
  let dir = resolve(path);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".git"))) return true;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return false;
}

export function writeSeed({ dataDir, names, terms, force = false, repoRoot = REPO }) {
  const file = denylistPath(dataDir);
  if (insideGitTree(dirname(file))) throw new Error(`The deny list must stay outside a git working tree, and ${file} is inside one.`);
  if (existsSync(file) && !force) throw new Error(`${file} exists. Edit it by hand, or pass --force to replace it.`);
  const seed = buildSeed({ dataDir, names, terms, repoRoot });
  const body = [
    "# Private terms that must not appear in the public tree. One term on each line.",
    "# This file is never committed. A term of 3 characters or fewer is matched with its case.",
    ...seed.keys(),
  ];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body.join("\n") + "\n", "utf8");
  return { file, count: seed.size, sources: [...new Set(seed.values())] };
}

export function loadDenylist(file) {
  return existsSync(file) ? parseDenylist(readFileSync(file, "utf8")) : [];
}

// ---------------------------------------------------------------- command line

function parseArgs(argv) {
  const a = { names: [], terms: [], positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--seed") a.seed = true;
    else if (v === "--force") a.force = true;
    else if (v === "--denylist") a.denylist = argv[++i];
    else if (v === "--data-dir") a.dataDir = argv[++i];
    else if (v === "--name") a.names.push(argv[++i]);
    else if (v === "--term") a.terms.push(argv[++i]);
    else a.positional.push(v);
  }
  return a;
}

export function main(argv) {
  const args = parseArgs(argv);
  const dataDir = resolveDataDir(args.dataDir);
  if (args.seed) {
    const r = writeSeed({ dataDir, names: args.names, terms: args.terms, force: args.force });
    console.log(`Wrote ${r.count} private terms to ${r.file}. Sources: ${r.sources.join("; ")}.`);
    return 0;
  }
  const tree = args.positional[0];
  if (!tree) {
    console.error("Usage: node scripts/public/check.mjs <tree> [--denylist <file>] [--data-dir <folder>]");
    return 2;
  }
  const root = resolve(tree);
  if (!existsSync(root)) {
    console.error(`The tree ${root} does not exist.`);
    return 2;
  }
  const listFile = resolve(args.denylist ?? denylistPath(dataDir));
  if (resolve(listFile).startsWith(root + sep)) {
    console.error(`The deny list ${listFile} is inside the tree that is being checked.`);
    return 2;
  }
  const denylist = loadDenylist(listFile);
  if (!denylist.length) console.warn(`Warning: no deny list at ${listFile}, so only the secret, path, e-mail and size checks ran. Create one with --seed.`);
  const hits = checkTree(root, { denylist });
  for (const h of hits) console.log(formatHit(h));
  console.log(hits.length ? `${hits.length} hit${hits.length === 1 ? "" : "s"} in the public tree.` : `The public tree is clean (${denylist.length} private terms checked).`);
  return hits.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
