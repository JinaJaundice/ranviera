// Builds the public tree of docs/DISTRIBUTION.md from an allow list of paths.
//
// Usage: node scripts/public/export.mjs [--out <folder>] [--denylist <file>] [--data-dir <folder>]
//          [--accept <package>=<licence>]... [--skip-notices] [--force]
//
// A private name found in the copy stops the export with the file and line of each hit. No file is rewritten or left out.
// The tree is written to a folder outside the repository (by default the folder ranviera-export beside the
// repository). The script never runs git and never pushes. It copies the allowed paths, publishes docs/public/ as
// docs/, places the files of public/ at the root, rewrites package.json under the name ranviera, generates
// THIRD_PARTY_NOTICES.md, checks the sha-256 of LICENSE and runs the public content check on the result.
// Exit code 0 means the tree is clean, 1 means there are hits or an unlisted licence, and 2 means the export failed.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTree, denylistPath, formatHit, loadDenylist, resolveDataDir } from "./check.mjs";
import { generate } from "./notices.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");

// The sha-256 of the Apache License 2.0 text published at https://www.apache.org/licenses/LICENSE-2.0.txt
export const APACHE_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

export const PUBLIC_DESCRIPTION =
  "Reads a person's Claude Code set-up into a knowledge graph, checks it against an ontology and shows it as a brain, on their own computer.";

// The allow list. A path that is not on it never reaches the public tree. A folder is copied whole, apart from the
// names in SKIP_NAMES and the paths in SKIP_PATHS.
export const ALLOW = [
  "cortex.py",
  "requirements.txt",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.web.json",
  "tsconfig.server.json",
  "vite.config.ts",
  "vitest.config.ts",
  "eslint.config.js",
  "electron-builder.yml",
  ".gitattributes",
  "kg/cortex_kg",
  "kg/tests",
  "server",
  "web",
  "shared",
  "desktop",
  "packaging",
  "hooks/cortex_hook.py",
  "hooks/cortex_session.py",
  "ontology/cortex.ttl",
  "ontology/shapes.ttl",
  "ontology/rules",
  "ontology/queries",
  "ontology/defaults",
  "scripts/brain",
  "scripts/build",
  "scripts/demo",
  "scripts/public",
  "scripts/smoke.mjs",
  "scripts/desktop-smoke.mjs",
];

export const SKIP_NAMES = new Set(["node_modules", "__pycache__", ".pytest_cache", ".git", ".DS_Store", "Thumbs.db", "dist", "release", "shots"]);
// The private pack of section 10 of docs/AGENT_TRANSPARENCY.md (7 October 2026): the rules that read the bank side classes,
// the loaders of the local obligation packs and their tests, and the synthetic demonstrator. Nothing else is left out by
// path, so every other script and test of an allowed folder is exported.
export const SKIP_PATHS = new Set([
  "ontology/rules/transparency_private.rls",
  "kg/tests/test_importers_private.py",
  "kg/cortex_kg/demo",
  "kg/tests/test_demo_northgate.py",
]);
const SKIP_SUFFIXES = [".pyc", ".pyo", ".tsbuildinfo", ".log"];

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isEmpty(dir) {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

function copyAllowed(repo, out, rel) {
  const src = join(repo, rel);
  if (!existsSync(src)) return { rel, missing: true, files: 0 };
  let files = 0;
  cpSync(src, join(out, rel), {
    recursive: true,
    filter: (from) => {
      const r = relative(repo, from).split(sep).join("/");
      const name = r.split("/").pop();
      if (SKIP_NAMES.has(name) || SKIP_PATHS.has(r) || (r.startsWith("kg/cortex_kg/importers/") && name.endsWith("_loader.py")) || SKIP_SUFFIXES.some((s) => name.endsWith(s))) return false;
      if (statSync(from).isFile()) files++;
      return true;
    },
  });
  return { rel, missing: false, files };
}

/** Rewrites package.json and the top of package-lock.json under the public name. */
function renamePackage(out) {
  const pkgFile = join(out, "package.json");
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  const next = { name: "ranviera", private: true, version: pkg.version, type: pkg.type, description: PUBLIC_DESCRIPTION, license: "Apache-2.0" };
  next.repository = { type: "git", url: "git+https://github.com/JinaJaundice/ranviera.git" };
  next.homepage = "https://github.com/JinaJaundice/ranviera";
  next.bugs = { url: "https://github.com/JinaJaundice/ranviera/issues" };
  for (const [k, v] of Object.entries(pkg)) if (!(k in next)) next[k] = v;
  writeFileSync(pkgFile, JSON.stringify(next, null, 2) + "\n");
  const lockFile = join(out, "package-lock.json");
  if (existsSync(lockFile)) {
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    lock.name = "ranviera";
    if (lock.packages?.[""]) {
      lock.packages[""].name = "ranviera";
      lock.packages[""].license = "Apache-2.0";
    }
    // A deprecation message of a package may hold the maintainer's e-mail address, which the check rejects.
    const text = JSON.stringify(lock, null, 2).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b(?<!@users\.noreply\.github\.com)/g, "[e-mail address removed]");
    writeFileSync(lockFile, text + "\n");
  }
}

function overlay(from, to) {
  if (!existsSync(from)) return 0;
  let n = 0;
  cpSync(from, to, { recursive: true, filter: (f) => { if (statSync(f).isFile()) n++; return true; } });
  return n;
}

/**
 * Builds the tree and checks it. Options: repo, out, denylist (an array of terms), allow, accepted (licence
 * decisions), skipNotices, python. Returns { out, copied, missing, hits, notices }.
 */
export function exportTree({ repo = REPO, out, denylist = [], allow = ALLOW, accepted = {}, skipNotices = false, force = false, log = () => {} }) {
  if (!out) throw new Error("No output folder was given.");
  out = resolve(out);
  if (isInside(out, repo) || isInside(repo, out)) throw new Error(`The output folder ${out} must be outside the repository ${repo}, and the repository must be outside it.`);
  if (!isEmpty(out)) {
    if (!force) throw new Error(`${out} is not empty. Pass --force to move it to an archive folder beside it first.`);
    // The earlier contents move to an archive folder beside the output, and the output folder itself stays, with its .git
    // folder, because it is the working copy of the public repository: git then shows exactly what changed since the
    // last push. Moving the contents, not the folder, also works while another program has the folder open. Nothing is
    // committed or pushed here.
    const archive = `${out}.archive-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    mkdirSync(archive, { recursive: true });
    for (const name of readdirSync(out)) {
      if (name === ".git") continue;
      renameSync(join(out, name), join(archive, name));
    }
    log(`Moved the earlier export to ${archive}${existsSync(join(out, ".git")) ? " and kept the .git folder of the public repository" : ""}.`);
  }
  mkdirSync(out, { recursive: true });

  const copied = [];
  const missing = [];
  for (const rel of allow) {
    const r = copyAllowed(repo, out, rel);
    (r.missing ? missing : copied).push(r);
  }
  if (existsSync(join(out, "package.json"))) renamePackage(out);

  // A private name stops the export. The files are never rewritten and never dropped to hide a name.
  const named = checkTree(out, { denylist }).filter((h) => h.kind === "denylist");
  if (named.length) return { out, copied, missing, docs: 0, root: 0, licenseOk: false, notices: { skipped: true, failures: [] }, hits: named, stopped: true };
  const docs = overlay(join(repo, "docs", "public"), join(out, "docs"));
  const root = overlay(join(repo, "public"), out);
  const license = join(out, "LICENSE");
  const licenseOk = existsSync(license) && sha256(license) === APACHE_SHA256;

  let notices = { skipped: true, failures: [] };
  if (!skipNotices) {
    const r = generate({ root: repo, accepted });
    writeFileSync(join(out, "THIRD_PARTY_NOTICES.md"), r.markdown.replace(/\r?\n/g, "\n") + "\n", "utf8");
    notices = { skipped: false, failures: r.failures, counts: r.counts };
  }
  const hits = checkTree(out, { denylist });
  return { out, copied, missing, docs, root, licenseOk, notices, hits, stopped: false };
}

export function main(argv) {
  const opt = { accepted: {} };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--out") opt.out = argv[++i];
    else if (v === "--denylist") opt.denylist = argv[++i];
    else if (v === "--data-dir") opt.dataDir = argv[++i];
    else if (v === "--skip-notices") opt.skipNotices = true;
    else if (v === "--force") opt.force = true;
    else if (v === "--accept") {
      const [k, ...rest] = argv[++i].split("=");
      opt.accepted[k] = rest.join("=");
    }
  }
  const out = opt.out ?? resolve(REPO, "..", "ranviera-export");
  const listFile = resolve(opt.denylist ?? denylistPath(resolveDataDir(opt.dataDir)));
  if (!existsSync(listFile)) {
    console.error(`There is no deny list at ${listFile}. Create it with: node scripts/public/check.mjs --seed --name "<full name>"`);
    return 2;
  }
  const denylist = loadDenylist(listFile);
  const r = exportTree({ out, denylist, accepted: opt.accepted, skipNotices: opt.skipNotices, force: opt.force, log: (m) => console.log(m) });
  if (r.stopped) {
    for (const h of r.hits) console.log(formatHit(h));
    console.log(`The export stopped, because ${r.hits.length} line${r.hits.length === 1 ? "" : "s"} in the tree name a private term. Remove each name from the source and run the export again. The incomplete tree is at ${r.out}.`);
    return 1;
  }
  const files = r.copied.reduce((n, c) => n + c.files, 0);
  console.log(`Exported ${files} files from ${r.copied.length} allowed paths, ${r.docs} documents and ${r.root} root files to ${r.out}.`);
  for (const m of r.missing) console.log(`Not found on the allow list: ${m.rel}`);
  if (!r.licenseOk) console.log("LICENSE is missing or does not match the Apache License 2.0 text.");
  for (const f of r.notices.failures) console.log(`NOT ALLOWED: ${f.name} ${f.version} is under '${f.license}', and ${f.reason}.`);
  for (const h of r.hits) console.log(formatHit(h));
  const bad = r.hits.length + r.notices.failures.length + (r.licenseOk ? 0 : 1);
  console.log(bad ? `${bad} problem${bad === 1 ? "" : "s"} found. Nothing was pushed.` : `The public tree is clean (${denylist.length} private terms checked). Nothing was pushed.`);
  return bad ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
