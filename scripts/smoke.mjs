// Opens Cortex at 1440 x 900, opens every window and the palette, and fails on console errors or failed requests.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const URL = process.env.CORTEX_URL ?? "http://localhost:5182";
const TITLES = ["Missions", "Graph", "Rules", "Lexicon", "Projects", "Pulse", "Query", "Health"];
const problems = [];

mkdirSync("shots", { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console error: ${m.text()}`);
});
page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
page.on("requestfailed", (r) => {
  // The browser closes the event stream on navigation, which is not a fault.
  if (!r.url().includes("/api/stream")) problems.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ""}`);
});
page.on("response", (r) => {
  if (r.status() >= 400) problems.push(`response ${r.status()}: ${r.url()}`);
});

try {
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForSelector("canvas", { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "shots/desktop.png" });

  for (const title of TITLES) {
    const button = page.locator(`button[aria-label^="${title}"]`).first();
    if ((await button.count()) === 0) {
      problems.push(`dock button not found: ${title}`);
      continue;
    }
    await button.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `shots/${title.toLowerCase()}.png` });
  }

  await page.keyboard.press("Control+K");
  await page.keyboard.type("deck");
  await page.waitForTimeout(800);
  await page.screenshot({ path: "shots/palette.png" });
} catch (e) {
  problems.push(`script error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
}

if (problems.length > 0) {
  console.error(`Smoke test failed with ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`Smoke test passed: ${TITLES.length + 2} screenshots saved in shots/.`);
