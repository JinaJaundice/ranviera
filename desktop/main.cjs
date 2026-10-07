// The desktop shell of Ranviera. It runs in two modes.
//
// Bundled (the public installer): the shell starts the bundled server in a utility process on a free port with
// a random token, opens the app at /auth?t=<token> so that the token reaches the window in an HttpOnly cookie, adds a
// content security policy that allows only the app's own origin, denies every permission request, and blocks
// navigation and new windows outside that origin. The server stops when the app quits.
//
// From the repository (the owner's own installed copy, and any unpackaged run): the shell finds the repository, starts
// its server with Electron's own Node (or uses a server that is already running on port 5182) and shows the app in a
// window of its own. The code, the
// ontology and the data stay in the repository. Closing the window stops the server only when this shell started it.
//
// The environment variable RANVIERA_SELFTEST names a folder. The app then photographs its own window after the first
// screen has loaded, checks that /api/status refuses a request without the token, writes selftest.json there and quits.
const { app, BrowserWindow, dialog, ipcMain, session, shell, utilityProcess } = require("electron");
const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

// The mode: "bundled" runs the server, compiler and web app shipped in the installer (the public product), and "repo"
// runs them from a checkout of the repository, as the owner's own installed copy does. The owner's installer sets
// ranvieraMode "repo" in its package.json (packaging/electron-builder.owner.yml), and an unpackaged run is "repo".
let SHIPPED_MODE = null;
try {
  SHIPPED_MODE = require("./package.json").ranvieraMode || null;
} catch {
  SHIPPED_MODE = null;
}
const MODE = process.env.RANVIERA_MODE || SHIPPED_MODE || (app.isPackaged ? "bundled" : "repo");
const PACKAGED = MODE === "bundled" || process.env.RANVIERA_FORCE_PACKAGED === "1";
const SELFTEST = process.env.RANVIERA_SELFTEST ? path.resolve(process.env.RANVIERA_SELFTEST) : null;
const NAME = "Ranviera";
const DEV_PORT = 5182;

// the origin of the app: fixed in development and the free port of the bundled server when packaged
let origin = `http://localhost:${DEV_PORT}`;
let token = null;
let server = null; // the child process (development) or the utility process (packaged)
let win = null;
let quitting = false;

if (!app.isPackaged) {
  // Keep the folder of the user data that the shell had under its old product name, and in a self-test keep everything
  // inside the output folder, so that the run leaves nothing behind.
  app.setPath("userData", SELFTEST ? path.join(SELFTEST, "userData") : path.join(app.getPath("appData"), "Cortex"));
} else if (SELFTEST) {
  app.setPath("userData", path.join(SELFTEST, "userData"));
}

// In a self-test the steps are logged to selftest.log, which helps when the app ends without a result.
function trace(message) {
  if (!SELFTEST) return;
  try {
    fs.mkdirSync(SELFTEST, { recursive: true });
    fs.appendFileSync(path.join(SELFTEST, "selftest.log"), `${new Date().toISOString()} ${message}
`);
  } catch {
    // the log is optional
  }
}
trace("main.cjs loaded");

// The server log stays open while the app runs and is closed when the shell stops its server.
let logFd = null;
function openLog(file) {
  closeLog();
  logFd = fs.openSync(file, "a");
  return logFd;
}
function writeLog(chunk) {
  if (logFd === null) return;
  try {
    fs.writeSync(logFd, chunk);
  } catch {
    // the log is optional
  }
}
function closeLog() {
  if (logFd === null) return;
  const fd = logFd;
  logFd = null;
  try {
    fs.closeSync(fd);
  } catch {
    // already closed
  }
}

// A second instance quits at once and starts nothing, so there is no second server and no second window.
const HOLDS_LOCK = app.requestSingleInstanceLock();
if (!HOLDS_LOCK) {
  trace("another instance holds the lock, so this one quits");
  app.quit();
}

// ---------------------------------------------------------------- packaged mode

// The folder that holds the bundled web app, ontology, server and compiler.
function bundleDir() {
  return process.env.RANVIERA_BUNDLE || path.join(process.resourcesPath, "ranviera");
}

function dataDir() {
  // os.homedir() follows USERPROFILE and HOME, which a test can point at a temporary folder.
  // the owner's copy keeps the data folder its configuration names, which predates the product name
  return path.join(os.homedir(), ".claude", PACKAGED ? "ranviera" : "cortex");
}

function kgExecutable() {
  return path.join(bundleDir(), "kg", process.platform === "win32" ? "ranviera-kg.exe" : "ranviera-kg");
}

// The configuration file of the packaged app. It is written once and never overwritten, so the person may edit it.
function ensureConfig(data) {
  const file = path.join(data, "ranviera.config.json");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ product: "ranviera" }, null, 2)}\n`);
  }
  return file;
}

function serverEnv(data, config) {
  const fwd = (p) => p.split(path.sep).join("/");
  if (!token) token = crypto.randomBytes(24).toString("hex");
  return {
    ...process.env,
    CORTEX_PORT: "0",
    CORTEX_TOKEN: token,
    CORTEX_STATIC: fwd(path.join(bundleDir(), "web")),
    CORTEX_ONTOLOGY: fwd(path.join(bundleDir(), "ontology")),
    CORTEX_KG_CMD: JSON.stringify([fwd(kgExecutable())]),
    CORTEX_DATA_DIR: fwd(data),
    CORTEX_CONFIG: fwd(config),
  };
}

// Starts the bundled server in a utility process and resolves with its port when it posts the ready message.
function startBundledServer(data, config) {
  const env = serverEnv(data, config);
  openLog(path.join(data, "server.log"));
  const child = utilityProcess.fork(path.join(bundleDir(), "server", "server.mjs"), [], {
    env,
    stdio: "pipe",
    serviceName: "Ranviera server",
  });
  server = child;
  child.stdout?.on("data", writeLog);
  child.stderr?.on("data", writeLog);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The Ranviera server did not start within 30 seconds. See ${path.join(data, "server.log")}.`)), 30000);
    child.on("message", (m) => {
      if (m && m.type === "ready" && Number.isInteger(m.port)) {
        clearTimeout(timer);
        resolve(m.port);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!quitting) reject(new Error(`The Ranviera server stopped with code ${code}. See ${path.join(data, "server.log")}.`));
    });
  });
}

// The compiler copies its hook runner to <data>/bin/ on each start, so that the hook entries name a stable path.
function copyHookRunner(data, config) {
  try {
    execFile(kgExecutable(), ["bin"], { env: serverEnv(data, config), windowsHide: true, timeout: 30000 }, () => undefined);
  } catch {
    // the runner is copied again at the next start
  }
}

// The inline scripts of the web app (the theme resolver) are allowed by hash, so that script-src stays 'self'.
function inlineScriptHashes() {
  try {
    const html = fs.readFileSync(path.join(bundleDir(), "web", "index.html"), "utf8");
    const out = [];
    for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      out.push(`'sha256-${crypto.createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
    }
    return out;
  } catch {
    return [];
  }
}

function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${inlineScriptHashes().join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// The hardening of the packaged app: the policy, the permissions and the navigation.
function lockDown() {
  const ses = session.defaultSession;
  const csp = contentSecurityPolicy();
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
}

function inOrigin(url) {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- development mode (the repository)

function settingsPath() {
  return path.join(app.getPath("userData"), "cortex-desktop.json");
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function isRepo(dir) {
  return !!dir && fs.existsSync(path.join(dir, "cortex.py")) && fs.existsSync(path.join(dir, "server", "src", "main.ts"));
}

// The repository: the saved choice, then the folder this shell runs from in development, then the usual place on
// the usual place under Downloads, and last a folder picker.
async function findRepo() {
  const saved = readSettings().repo;
  const candidates = [
    saved,
    process.env.CORTEX_REPO,
    path.resolve(__dirname, ".."),
    path.join(app.getPath("home"), "Downloads", "Projects", "apps", "cortex"),
  ];
  for (const c of candidates) if (isRepo(c)) return remember(c);
  const pick = await dialog.showOpenDialog({
    title: "Find the Cortex folder",
    message: "Choose the folder that holds the Cortex repository (it contains cortex.py).",
    properties: ["openDirectory"],
  });
  if (!pick.canceled && isRepo(pick.filePaths[0])) return remember(pick.filePaths[0]);
  return null;
}

function remember(dir) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ ...readSettings(), repo: dir }, null, 2));
  } catch {
    // the choice is asked again next time
  }
  return dir;
}

function listening() {
  return new Promise((resolve) => {
    // 127.0.0.1, because the server listens there only and "localhost" may try the IPv6 address first on Windows
    const req = http.get(`http://127.0.0.1:${DEV_PORT}/api/status`, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function nodeRun(repo, args, opts = {}) {
  // Electron's own executable runs as plain Node with ELECTRON_RUN_AS_NODE, so no separate Node is needed.
  return spawn(process.execPath, args, {
    cwd: repo,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
    ...opts,
  });
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}

// Rebuild the web app when its source is newer than the last build.
function ensureBuilt(repo) {
  const built = path.join(repo, "dist", "index.html");
  const stale =
    !fs.existsSync(built) ||
    fs.statSync(built).mtimeMs < Math.max(newestMtime(path.join(repo, "web")), newestMtime(path.join(repo, "shared")));
  if (!stale) return Promise.resolve();
  return new Promise((resolve) => {
    const vite = path.join(repo, "node_modules", "vite", "bin", "vite.js");
    nodeRun(repo, [vite, "build"], { stdio: "ignore" }).on("exit", () => resolve());
  });
}

async function startRepoServer(repo) {
  if (await listening()) return;
  await ensureBuilt(repo);
  const data = dataDir();
  fs.mkdirSync(data, { recursive: true });
  const log = openLog(path.join(data, "server.log"));
  const tsx = path.join(repo, "node_modules", "tsx", "dist", "cli.mjs");
  server = nodeRun(repo, [tsx, path.join(repo, "server", "src", "main.ts")], { stdio: ["ignore", log, log] });
  for (let i = 0; i < 60; i += 1) {
    if (await listening()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The Cortex server did not start within 30 seconds. See ~/.claude/cortex/server.log.");
}

function stopServer() {
  quitting = true;
  const s = server;
  server = null;
  if (s) {
    if (PACKAGED) s.kill();
    else if (s.exitCode === null) {
      if (process.platform === "win32") execFile("taskkill", ["/pid", String(s.pid), "/T", "/F"], () => undefined);
      else s.kill();
    }
  }
  closeLog();
}

// ---------------------------------------------------------------- the window

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: NAME,
    backgroundColor: "#04060b",
    icon: path.join(__dirname, "icon.png"),
    // The top bar (36 px high) doubles as the title bar, and Windows draws its own buttons over the right end.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0a0f1a", symbolColor: "#a3adc2", height: 36 },
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, "preload.cjs") },
  });
  // The title of web/index.html is neutral and the web app sets document.title from /api/status, so the window title
  // follows the page and names the product (Cortex or Ranviera).
  win.once("ready-to-show", () => win.show());
  const wc = win.webContents;
  // Links that leave the app open in the default browser in development. In the packaged app only an https link opens
  // there (such as Anthropic's installation page), and nothing opens a new window of the app.
  const external = (url) => {
    if (!PACKAGED || /^https:\/\//i.test(url)) shell.openExternal(url);
  };
  wc.setWindowOpenHandler(({ url }) => {
    if (!inOrigin(url)) external(url);
    return { action: "deny" };
  });
  const guard = (event, url) => {
    if (!inOrigin(url)) {
      event.preventDefault();
      external(url);
    }
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
  wc.on("will-attach-webview", (event) => event.preventDefault());
  win.loadURL(PACKAGED ? `${origin}/auth?t=${token}` : `${origin}/?shell=desktop`);
}

ipcMain.on("cortex:title-bar", (_event, colour, symbols) => {
  const ok = (c) => /^#[0-9a-f]{3,8}$/i.test(c) || /^rgb/.test(c);
  if (win && ok(colour) && ok(symbols)) win.setTitleBarOverlay({ color: colour, symbolColor: symbols, height: 36 });
});

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// ---------------------------------------------------------------- the self-test

function request(urlPath, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(urlPath, origin);
    const req = http.get({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(0));
    req.setTimeout(5000, () => req.destroy());
  });
}

async function selfTest() {
  const result = { ok: false, packaged: PACKAGED, version: app.getVersion(), origin, errors: [] };
  const out = SELFTEST;
  try {
    fs.mkdirSync(out, { recursive: true });
    const wc = win.webContents;
    // wait for the page to hold its first screen: the app mounted and showed some text
    let text = "";
    for (let i = 0; i < 120; i += 1) {
      text = await wc.executeJavaScript("document.readyState === 'complete' ? (document.body.innerText || '') : ''").catch(() => "");
      if (text.trim().length > 80) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 2500));
    text = await wc.executeJavaScript("document.body.innerText || ''").catch(() => text);
    result.title = wc.getTitle();
    result.text_start = text.replace(/\s+/g, " ").trim().slice(0, 400);
    result.has_affiliation_statement = /not affiliated with, endorsed by or sponsored by Anthropic/.test(text);
    const image = await wc.capturePage();
    fs.writeFileSync(path.join(out, "selftest.png"), image.toPNG());
    result.screenshot = path.join(out, "selftest.png");
    result.screenshot_size = image.getSize();
    if (PACKAGED) {
      result.status_without_token = await request("/api/status");
      result.status_with_token = await request("/api/status", { "x-cortex-token": token });
      result.token_refused = result.status_without_token === 401;
      result.data_dir = dataDir();
      result.config_written = fs.existsSync(path.join(dataDir(), "ranviera.config.json"));
    }
    result.mode = MODE;
    result.window_title = win.getTitle();
    result.title_is_ranviera = result.window_title === NAME;
    result.no_other_names = !/Cortex/.test(text) && !/Cortex/.test(result.window_title);
    result.ok = text.trim().length > 80 && result.title_is_ranviera && result.no_other_names &&
      (!PACKAGED || (result.token_refused && result.status_with_token === 200));
  } catch (err) {
    result.errors.push(String(err && err.message ? err.message : err));
  }
  fs.writeFileSync(path.join(out, "selftest.json"), JSON.stringify(result, null, 2));
  stopServer();
  app.exit(result.ok ? 0 : 1);
}

// ---------------------------------------------------------------- start

// Without the lock the shell has already asked to quit, so it starts no server and opens no window.
if (HOLDS_LOCK) void app.whenReady().then(async () => {
  app.setAppUserModelId(PACKAGED ? "io.github.jinajaundice.ranviera" : "io.github.jinajaundice.ranviera.owner");
  try {
    if (PACKAGED) {
      const data = dataDir();
      fs.mkdirSync(data, { recursive: true });
      const config = ensureConfig(data);
      lockDown();
      const port = await startBundledServer(data, config);
      origin = `http://127.0.0.1:${port}`;
      copyHookRunner(data, config);
    } else {
      const repo = await findRepo();
      if (!repo) {
        dialog.showErrorBox(NAME, "The repository folder was not found, so Ranviera cannot start.");
        app.quit();
        return;
      }
      await startRepoServer(repo);
    }
  } catch (err) {
    if (SELFTEST) {
      fs.mkdirSync(SELFTEST, { recursive: true });
      fs.writeFileSync(path.join(SELFTEST, "selftest.json"), JSON.stringify({ ok: false, errors: [String(err && err.message ? err.message : err)] }, null, 2));
      stopServer();
      app.exit(1);
      return;
    }
    dialog.showErrorBox(NAME, String(err && err.message ? err.message : err));
    app.quit();
    return;
  }
  trace(`server ready at ${origin}`);
  createWindow();
  if (SELFTEST) void selfTest();
});

app.on("window-all-closed", () => {
  trace("window-all-closed");
  stopServer();
  app.quit();
});

app.on("before-quit", stopServer);
