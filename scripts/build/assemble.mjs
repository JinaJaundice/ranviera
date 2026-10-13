// Assembles build/app, the folder that electron-builder copies into the installer as extra resources:
//   web/       the web app, built by Vite
//   ontology/  the product ontology (cortex.ttl, shapes.ttl, rules/, queries/ and defaults/)
//   LICENSE, NOTICE and THIRD_PARTY_NOTICES.md, where they exist
// The server (scripts/build/server.mjs) and the compiler (scripts/build/kg.mjs) write server/ and kg/ beside them.
// Run with: node scripts/build/assemble.mjs [--skip-vite]   (or "all" to run the three steps)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = path.join(ROOT, "build", "app");

function copy(from, to) {
  fs.cpSync(from, to, { recursive: true, filter: (src) => !/[\\/](__pycache__|\.pytest_cache)([\\/]|$)/.test(src) && !src.endsWith("README.md") });
}

export function assemble({ vite = true } = {}) {
  if (vite) fs.rmSync(path.join(APP, "web"), { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });
  if (vite) {
    const bin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
    const r = spawnSync(process.execPath, [bin, "build", "--outDir", path.join(APP, "web"), "--emptyOutDir"], { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) throw new Error("vite build failed.");
  }
  const ontology = path.join(APP, "ontology");
  fs.rmSync(ontology, { recursive: true, force: true });
  fs.mkdirSync(ontology, { recursive: true });
  const missing = [];
  for (const name of ["cortex.ttl", "shapes.ttl", "rules", "queries", "defaults"]) {
    const from = path.join(ROOT, "ontology", name);
    if (fs.existsSync(from)) copy(from, path.join(ontology, name));
    else missing.push(name);
  }
  const notices = [];
  for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    const from = [path.join(ROOT, "public", name), path.join(ROOT, name)].find((c) => fs.existsSync(c));
    if (from) {
      fs.copyFileSync(from, path.join(APP, name));
      notices.push(name);
    }
  }
  if (!notices.includes("LICENSE")) throw new Error("LICENSE was not found in public/ or the repository root.");
  console.log(`Assembled build/app: the web app, the ontology (${missing.length ? `missing: ${missing.join(", ")}` : "complete"}) and ${notices.length ? notices.join(", ") : "no notice files"}.`);
  return { missing, notices };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assemble({ vite: !process.argv.includes("--skip-vite") });
}
