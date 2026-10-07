// Launch the Cortex desktop app and check that it loads in its own window with a title that names the product and no
// other product name. Two modes:
//   node scripts/desktop-smoke.mjs             the repository mode (desktop/main.cjs, shown as Cortex), driven by Playwright's
//                                              Electron driver, with shots/desktop-app.png
//   node scripts/desktop-smoke.mjs --packaged  the packaged mode (shown as Ranviera) through the self-test switch
//                                              RANVIERA_SELFTEST: the shell photographs its own window, writes selftest.json
//                                              and quits. It runs release/win-unpacked/Ranviera.exe when that exists, and
//                                              otherwise (or with --from-bundle) Electron with the bundle in build/app, which
//                                              node scripts/build/assemble.mjs fills.
import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const packaged = process.argv.includes("--packaged");

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

async function repositoryMode() {
  fs.mkdirSync("shots", { recursive: true });
  const app = await electron.launch({ args: ["desktop"], cwd: ROOT });
  const errors = [];
  const win = await app.firstWindow();
  win.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await win.waitForSelector("canvas", { timeout: 60000 });
  await win.waitForFunction(() => document.title === "Cortex", null, { timeout: 15000 }).catch(() => undefined);
  await win.waitForTimeout(2000);
  const info = await win.evaluate(() => ({
    title: document.title,
    shell: document.documentElement.dataset.shell,
    bridge: typeof window.cortexDesktop,
    topbarDrag: getComputedStyle(document.querySelector(".cx-topbar")).getPropertyValue("-webkit-app-region"),
    names_other_product: /Ranviera/.test(document.body.innerText),
  }));
  const windowTitle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
  await win.screenshot({ path: "shots/desktop-app.png" });
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  await app.close();
  console.log(JSON.stringify({ ...info, window_title: windowTitle, size, errors }, null, 1));
  if (errors.length) fail("The console held errors.");
  if (info.title !== "Cortex" || windowTitle !== "Cortex") fail(`The window title is '${windowTitle}' and the page title '${info.title}', not Cortex.`);
  if (info.names_other_product) fail("The page text names Ranviera in the repository mode.");
}

async function packagedMode() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-desktop-smoke-"));
  const exe = path.join(ROOT, "release", "win-unpacked", "Ranviera.exe");
  const useExe = fs.existsSync(exe) && !process.argv.includes("--from-bundle");
  const home = path.join(out, "home");
  fs.mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    RANVIERA_SELFTEST: path.join(out, "selftest"),
    USERPROFILE: home,
    HOME: home,
    ...(useExe ? {} : { RANVIERA_FORCE_PACKAGED: "1", RANVIERA_BUNDLE: path.join(ROOT, "build", "app") }),
  };
  const command = useExe ? exe : (await import("electron")).default;
  const args = useExe ? [] : ["desktop"];
  const child = spawn(command, args, { cwd: ROOT, env, stdio: "ignore" });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 120000);
    child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
  });
  const file = path.join(out, "selftest", "selftest.json");
  if (!fs.existsSync(file)) fail(`The self-test wrote no result (exit code ${code}). See ${path.join(out, "selftest", "selftest.log")}.`);
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(JSON.stringify({ ...r, text_start: undefined, exit_code: code, source: useExe ? "release/win-unpacked" : "build/app" }, null, 1));
  if (!r.ok) fail("The packaged self-test did not pass.");
  if (r.window_title !== "Ranviera") fail(`The window title is '${r.window_title}', not Ranviera.`);
  if (!r.no_other_names) fail("The packaged window names Cortex.");
  fs.mkdirSync("shots", { recursive: true });
  fs.copyFileSync(path.join(out, "selftest", "selftest.png"), "shots/desktop-packaged.png");
}

if (packaged) await packagedMode();
else await repositoryMode();
process.exit(0);
