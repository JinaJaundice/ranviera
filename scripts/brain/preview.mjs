// Renders brain.glb (or the source model with regions.json) from 4 views to PNG files.
// Usage: node preview.mjs [--glb path] [--points path] [--groups regions.json] [--only id,id]
//        [--out dir] [--prefix name] [--no-points]
// With --groups the glb is the source model and each mesh is coloured by its region in the file.
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const glb = resolve(opt("glb", resolve(root, "web/public/brain/brain.glb")));
const pointsPath = args.includes("--no-points") ? null : resolve(opt("points", resolve(root, "web/public/brain/brain-points.bin")));
const groups = opt("groups", null);
const only = opt("only", "");
const outDir = resolve(opt("out", fileURLToPath(new URL("../../_work/brain-preview", import.meta.url))));
const prefix = opt("prefix", "brain");

const PALETTE = {
  prefrontal: "#e6194b", language: "#f58231", occipital: "#4363d8", motor: "#ffe119", parietal: "#3cb44b",
  memory: "#911eb4", basal: "#42d4f4", thalamus: "#f032e6", cerebellum: "#9a6324", brainstem: "#ffffff",
  shell: "#8899aa", hidden: "#333333",
};

const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#101418">
<canvas id="c" width="900" height="900" style="display:block"></canvas>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
const cfg = await (await fetch("/cfg.json")).json();
const PALETTE = cfg.palette;
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById("c"), antialias: true, preserveDrawingBuffer: true });
renderer.setSize(900, 900, false);
renderer.setClearColor(0x101418);
const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 1.1));
const dl = new THREE.DirectionalLight(0xffffff, 2.2); dl.position.set(1, 2, 3); scene.add(dl);
const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
const gltf = await loader.loadAsync("/glb");
const colorMat = new Map();
const mat = (id) => { if (!colorMat.has(id)) colorMat.set(id, new THREE.MeshStandardMaterial({ color: PALETTE[id] || "#ff00ff", roughness: 0.7, metalness: 0, side: THREE.DoubleSide })); return colorMat.get(id); };
let n = 0;
const only = cfg.only;
gltf.scene.traverse((o) => {
  if (!o.isMesh) return;
  let id = o.userData.region || (o.parent && o.parent.userData.region);
  if (cfg.groups) id = cfg.groups[o.name] || cfg.groups[o.parent.name] || "unlisted";
  if (id === "hidden" && !only.length) { o.visible = false; return; }
  if (only.length && !only.includes(id)) { o.visible = false; return; }
  n++;
  if (id === "shell") o.material = new THREE.MeshStandardMaterial({ color: PALETTE.shell, transparent: true, opacity: only.length ? 0.08 : 0.18, depthWrite: false, side: THREE.DoubleSide });
  else o.material = mat(id);
  if (only.length) o.material = mat(id);
});
scene.add(gltf.scene);
const box = new THREE.Box3().setFromObject(gltf.scene);
const size = box.getSize(new THREE.Vector3()); const ctr = box.getCenter(new THREE.Vector3());
if (cfg.points) {
  const buf = await (await fetch("/points")).arrayBuffer();
  const f = new Float32Array(buf);
  const pos = new Float32Array(f.length / 2);
  const col = new Float32Array(f.length / 2);
  // colour points by the region of the nearest labelled point range in the regions manifest
  const man = await (await fetch("/manifest")).json();
  const c = new THREE.Color();
  for (const r of man.regions) {
    if (only.length && !only.includes(r.id)) continue;
    c.set(PALETTE[r.id]).lerp(new THREE.Color(1, 1, 1), 0.45);
    for (let i = r.pointOffset; i < r.pointOffset + r.pointCount; i++) {
      pos[i * 3] = f[i * 6] + f[i * 6 + 3] * 0.8; pos[i * 3 + 1] = f[i * 6 + 1] + f[i * 6 + 4] * 0.8; pos[i * 3 + 2] = f[i * 6 + 2] + f[i * 6 + 5] * 0.8;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.5, vertexColors: true, sizeAttenuation: true }));
  scene.add(pts);
  // dim the meshes a little so the dots read
  gltf.scene.traverse((o) => { if (o.isMesh && o.material && !o.material.transparent) { o.material = o.material.clone(); o.material.color.multiplyScalar(0.55); } });
}
const R = Math.max(size.x, size.y, size.z) * 0.62;
const cam = new THREE.OrthographicCamera(-R, R, R, -R, R * 0.01, R * 30);
window.shoot = (view) => {
  const d = R * 5;
  const v = { left: [d, 0, 0, 0, 1, 0], right: [-d, 0, 0, 0, 1, 0], top: [0, d, 0, 0, 0, 1], front: [0, 0, d, 0, 1, 0], back: [0, 0, -d, 0, 1, 0], bottom: [0, -d, 0, 0, 0, -1] }[view];
  cam.position.set(ctr.x + v[0], ctr.y + v[1], ctr.z + v[2]);
  cam.up.set(v[3], v[4], v[5]);
  cam.lookAt(ctr);
  renderer.render(scene, cam); window.tris = renderer.info.render.triangles;
  return n;
};
window.info = JSON.stringify({size, ctr, R}); let vis=0, tot=0; gltf.scene.traverse(o=>{ if(o.isMesh){tot++; if(o.visible) vis++;} }); window.info += " vis " + vis + " tot " + tot + " " + gltf.scene.visible + " " + gltf.scene.scale.x; window.ready = true;
</script>`;

const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".html": "text/html", ".glb": "model/gltf-binary" };
const threeRoot = resolve(root, "node_modules/three");
const manifestPath = resolve(root, "web/public/brain/brain-regions.json");
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let file = null;
    if (url.pathname === "/") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    if (url.pathname === "/cfg.json") {
      const g = groups ? JSON.parse(await readFile(resolve(groups), "utf8")) : null;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ palette: PALETTE, groups: g ? g.groups ?? g : null, points: !!pointsPath, only: only ? only.split(",") : [] }));
      return;
    }
    if (url.pathname === "/glb") file = glb;
    else if (url.pathname === "/points") file = pointsPath;
    else if (url.pathname === "/manifest") file = manifestPath;
    else if (url.pathname.startsWith("/three/")) file = resolve(threeRoot, "." + url.pathname.slice(6));
    if (!file || !existsSync(file)) { res.statusCode = 404; res.end("missing"); return; }
    res.setHeader("content-type", mime[extname(file)] || "application/octet-stream");
    res.end(await readFile(file));
  } catch (e) { res.statusCode = 500; res.end(String(e)); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const { chromium } = await import(pathToFileURL(resolve(root, "node_modules/playwright/index.mjs")).href);
const browser = await chromium.launch({ channel: "msedge", args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
page.on("pageerror", (e) => console.error("pageerror", e.message));
page.on("console", (m) => { console.error("console", m.text()); });
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction("window.ready === true", null, { timeout: 120000 });
console.log(await page.evaluate("window.info")); await mkdir(outDir, { recursive: true });
const views = opt("views", "left,right,top,front").split(",");
for (const v of views) {
  const n = await page.evaluate((view) => window.shoot(view), v);
  const file = resolve(outDir, `${prefix}-${v}.png`);
  await page.locator("#c").screenshot({ path: file });
  console.log(file, "meshes drawn", n, "tris", await page.evaluate("window.tris"));
}
await browser.close();
server.close();
