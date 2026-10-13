// Draws the Ranviera icon, a myelinated nerve fibre with nodes of Ranvier, as desktop/icon.svg and renders it to desktop/icon.png with Playwright.
// Run with: node scripts/build/icon.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SIZE = 1024;
const C = SIZE / 2;
const SIGNAL = "#6ee7ff";
const SURFACE = "#0a0f1a";

// A diagonal axon: myelin sheath segments (rounded bars) separated by small gaps, the nodes of Ranvier, each marked by a
// bright node, with a soma at the lower left and a branching terminal at the upper right.
const f = (n) => n.toFixed(1);
const dir = -Math.PI / 4;
const ux = Math.cos(dir);
const uy = Math.sin(dir);
const at = (t) => [C + t * ux, C + t * uy];
const sheaths = [];
const nodes = [];
const seg = 85;
const gap = 112;
for (let i = -2; i <= 2; i += 1) {
  const mid = i * (seg + gap);
  const [x1, y1] = at(mid - seg / 2);
  const [x2, y2] = at(mid + seg / 2);
  sheaths.push(`<path d="M${f(x1)} ${f(y1)} L${f(x2)} ${f(y2)}" stroke-width="84"/>`);
  if (i < 2) {
    const [nx, ny] = at(mid + seg / 2 + gap / 2);
    nodes.push(`<circle cx="${f(nx)}" cy="${f(ny)}" r="22"/>`);
  }
}
const [sx, sy] = at(-2 * (seg + gap) - seg / 2 - 45);
const [ex, ey] = at(2 * (seg + gap) + seg / 2 + 25);
const branches = [-0.5, 0, 0.5].map((d) => {
  const [bx, by] = [ex + 85 * Math.cos(dir + d), ey + 85 * Math.sin(dir + d)];
  nodes.push(`<circle cx="${f(bx)}" cy="${f(by)}" r="24"/>`);
  return `<path d="M${f(ex)} ${f(ey)} L${f(bx)} ${f(by)}" stroke-width="16"/>`;
});
const axon = `<path d="M${f(sx)} ${f(sy)} L${f(ex)} ${f(ey)}" stroke-width="30"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="Ranviera">
  <defs>
    <radialGradient id="soma" cx="45%" cy="40%" r="65%">
      <stop offset="0" stop-color="#bdf5ff"/>
      <stop offset="1" stop-color="${SIGNAL}"/>
    </radialGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" rx="200" fill="${SURFACE}"/>
  <g stroke="${SIGNAL}" stroke-linecap="round" fill="none">${axon}${branches.join("")}</g>
  <g stroke="url(#soma)" stroke-linecap="round" fill="none">${sheaths.join("")}</g>
  <g fill="#ffffff">${nodes.join("")}</g>
  <circle cx="${f(sx)}" cy="${f(sy)}" r="62" fill="${SIGNAL}"/>
  <circle cx="${f(sx)}" cy="${f(sy)}" r="24" fill="${SURFACE}" opacity="0.55"/>
`;

fs.writeFileSync(path.join(ROOT, "desktop", "icon.svg"), svg);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg}`);
await page.screenshot({ path: path.join(ROOT, "desktop", "icon.png"), omitBackground: true, clip: { x: 0, y: 0, width: SIZE, height: SIZE } });
await browser.close();
console.log("Wrote desktop/icon.svg and desktop/icon.png (1024 by 1024).");
