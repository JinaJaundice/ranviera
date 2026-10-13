// Builds the compiler with PyInstaller into build/app/kg/ (a folder with the executable ranviera-kg) and checks that
// `ranviera-kg build` runs on an empty temporary Claude folder. Run with: node scripts/build/kg.mjs [--no-check]
// The check needs the product ontology in build/app/ontology, which scripts/build/assemble.mjs copies.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = path.join(ROOT, "build", "app");
const EXE = path.join(APP, "kg", process.platform === "win32" ? "ranviera-kg.exe" : "ranviera-kg");
const python = process.env.PYTHON_CMD || (process.platform === "win32" ? "python" : "python3");
const fwd = (p) => p.split(path.sep).join("/");

export function buildKg() {
  fs.rmSync(path.join(APP, "kg"), { recursive: true, force: true });
  const r = spawnSync(
    python,
    [
      "-m", "PyInstaller", "--noconfirm", "--clean",
      "--distpath", APP,
      "--workpath", path.join(ROOT, "build", "work", "kg"),
      path.join(ROOT, "packaging", "kg", "ranviera-kg.spec"),
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (r.status !== 0 || !fs.existsSync(EXE)) throw new Error("PyInstaller did not build ranviera-kg.");
  console.log(`Built the compiler at ${path.relative(ROOT, EXE)}.`);
}

export function checkKg() {
  const ontology = path.join(APP, "ontology");
  if (!fs.existsSync(path.join(ontology, "cortex.ttl"))) throw new Error("Run scripts/build/assemble.mjs first, so that build/app/ontology exists.");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ranviera-kg-"));
  const claude = path.join(tmp, "claude");
  const data = path.join(tmp, "data");
  fs.mkdirSync(claude, { recursive: true });
  const config = path.join(tmp, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({ product: "ranviera", claude_home: fwd(claude), data_dir: fwd(data), projects_root: null, memory_dir: "auto" }),
  );
  try {
    const env = { ...process.env, CORTEX_CONFIG: config, CORTEX_DATA_DIR: fwd(data), CORTEX_ONTOLOGY: fwd(ontology), PYTHONIOENCODING: "utf-8" };
    const r = spawnSync(EXE, ["build"], { env, encoding: "utf8", timeout: 300000 });
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (r.status !== 0) throw new Error(`ranviera-kg build exited ${r.status}. Output: ${text.slice(-800)}`);
    if (!fs.existsSync(path.join(data, "graph.json"))) throw new Error("ranviera-kg build wrote no graph.json.");
    const rr = spawnSync(EXE, ["reason"], { env, encoding: "utf8", timeout: 300000 });
    if (rr.status !== 0) throw new Error(`ranviera-kg reason exited ${rr.status}. Output: ${`${rr.stdout ?? ""}${rr.stderr ?? ""}`.slice(-800)}`);
    console.log(`ranviera-kg build and reason ran on an empty Claude folder: ${text.trim().split("\n")[0]}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildKg();
  if (!process.argv.includes("--no-check")) checkKg();
}
