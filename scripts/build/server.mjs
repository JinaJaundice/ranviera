// Bundles the Cortex server into build/app/server/server.mjs for the installer, with the SPARQL worker and the
// Oxigraph WebAssembly file beside it, and checks that the bundle starts and answers /api/status.
// Run with: node scripts/build/server.mjs [--no-check]
import { build } from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "build", "app", "server");

// The server starts its SPARQL worker from "./sparql.worker.ts". In the bundle the worker is a second file, so the
// reference is rewritten while the source is read.
const workerReference = {
  name: "worker-reference",
  setup(b) {
    b.onLoad({ filter: /sparql\.ts$/ }, (args) => {
      const text = fs.readFileSync(args.path, "utf8").replace('"./sparql.worker.ts"', '"./sparql.worker.mjs"');
      return { contents: text, loader: "ts", resolveDir: path.dirname(args.path) };
    });
  },
};

// Oxigraph and a few packages are CommonJS and read __dirname and require, which an ES module does not define.
const banner = [
  'import { createRequire as __cr } from "node:module";',
  'import { fileURLToPath as __fu } from "node:url";',
  'import { dirname as __dn } from "node:path";',
  "const require = __cr(import.meta.url);",
  "const __filename = __fu(import.meta.url);",
  "const __dirname = __dn(__filename);",
].join("\n");

export async function bundleServer() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  await build({
    entryPoints: {
      server: path.join(ROOT, "server", "src", "main.ts"),
      "sparql.worker": path.join(ROOT, "server", "src", "sparql.worker.ts"),
    },
    outdir: OUT,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: ["vite", "electron"],
    plugins: [workerReference],
    define: { "process.env.CORTEX_BUILD_VERSION": JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version) },
    banner: { js: banner },
    logLevel: "warning",
    legalComments: "none",
  });
  fs.copyFileSync(path.join(ROOT, "node_modules", "oxigraph", "node_bg.wasm"), path.join(OUT, "node_bg.wasm"));
  const size = fs.statSync(path.join(OUT, "server.mjs")).size;
  console.log(`Bundled the server into ${path.relative(ROOT, OUT)} (server.mjs ${Math.round(size / 1024)} KB).`);
}

const fwd = (p) => p.split(path.sep).join("/");

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });
}

// Starts the bundle against an empty temporary Claude folder and data folder, and asks /api/status with and without
// the token.
export async function checkServer() {
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ranviera-server-"));
  const claude = path.join(tmp, "claude");
  const data = path.join(tmp, "data");
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const config = path.join(tmp, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({ product: "ranviera", claude_home: fwd(claude), data_dir: fwd(data), projects_root: fwd(tmp), memory_dir: fwd(claude), port }),
  );
  const token = "check-token";
  const child = spawn(process.execPath, [path.join(OUT, "server.mjs")], {
    env: { ...process.env, CORTEX_CONFIG: config, CORTEX_PORT: String(port), CORTEX_TOKEN: token, CORTEX_DATA_DIR: data },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  try {
    for (let i = 0; i < 80 && !/running at/.test(out) && child.exitCode === null; i += 1) await new Promise((r) => setTimeout(r, 250));
    if (!/running at/.test(out)) throw new Error(`The bundled server did not start. Output: ${out.slice(0, 500)}`);
    const refused = await get(port, "/api/status");
    const allowed = await get(port, "/api/status", { "x-cortex-token": token });
    if (refused.status !== 401) throw new Error(`/api/status without the token answered ${refused.status}, not 401.`);
    if (allowed.status !== 200) throw new Error(`/api/status with the token answered ${allowed.status}, not 200.`);
    // the esbuild define in bundleServer() gives a packaged server its version, so it must not report 'unknown'
    const version = JSON.parse(allowed.body).version;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) throw new Error(`/api/status reported the version ${JSON.stringify(version)}, not a build version.`);
    console.log(`The bundled server answered /api/status on port ${port}: 401 without the token and 200 with it, version ${version}.`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundleServer();
  if (!process.argv.includes("--no-check")) await checkServer();
}
