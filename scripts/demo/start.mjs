// Builds the Northgate demonstrator and starts the server on it.
// Usage: npm run demo -- [--out FOLDER] [--seed N]
// The folder defaults to northgate-demo under the temporary folder of the machine. When `demo build` exits with 2 because the
// demonstrator is not built, this script prints the sentence of the compiler and exits with 2.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);

function option(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  return joined ? joined.slice(name.length + 3) : fallback;
}

const out = path.resolve(option("out", path.join(os.tmpdir(), "northgate-demo")));
const seed = option("seed", "7");
if (!/^\d+$/.test(seed)) {
  console.error("The seed must be a whole number.");
  process.exit(1);
}
// The first interpreter that answers with Python 3. On Windows the command python may be the Microsoft Store stub, which
// prints an install message, so the Python install manager's launcher is tried first there.
function findPython() {
  const candidates = [process.env.CORTEX_PYTHON];
  if (process.platform === "win32" && process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "Python", "bin", "python.exe"));
  candidates.push("python3", "python", "py");
  for (const c of candidates.filter(Boolean)) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0 && /^Python 3\./.test(`${r.stdout}${r.stderr}`.trim())) return c;
  }
  return null;
}
const python = findPython();
if (!python) {
  console.error("No Python 3 interpreter answered. Set CORTEX_PYTHON to the full path of python.exe and run the command again.");
  process.exit(1);
}

const build = spawnSync(python, [path.join(root, "cortex.py"), "demo", "build", "--seed", seed, "--out", out, "--json"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, PYTHONIOENCODING: "utf-8" },
});
if (build.error) {
  console.error(`The compiler could not be started. ${build.error.message}`);
  process.exit(1);
}
if (build.status !== 0) {
  let said = "";
  try {
    said = String(JSON.parse(build.stdout).error ?? "");
  } catch {
    said = (build.stderr || build.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  }
  console.error(said || "The demonstrator could not be built.");
  process.exit(build.status === 2 ? 2 : 1);
}

const config = path.join(out, "ranviera.config.json");
if (!fs.existsSync(config)) {
  console.error(`The demonstrator was built but ${config} does not exist.`);
  process.exit(1);
}
console.log(`The demonstrator is built in ${out}.`);
console.log("Starting the server. Open the Oversight window from the dock. Press Ctrl+C to stop.");

const server = spawn(process.execPath, ["--import", "tsx", path.join(root, "server", "src", "main.ts")], {
  cwd: root,
  stdio: "inherit",
  // the server calls the compiler with the same interpreter that built the demonstrator
  env: { ...process.env, CORTEX_CONFIG: config, CORTEX_KG_CMD: JSON.stringify([python, path.join(root, "cortex.py")]) },
});
server.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.kill());
