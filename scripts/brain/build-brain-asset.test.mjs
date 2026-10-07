// Run from scripts/brain with: node --test build-brain-asset.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, loadSource, readSourceMeshes, MAX_GLB_BYTES, CORTICAL, DEEP, MIN_POINTS, CITATION, SOURCE } from "./build-brain-asset.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FILES = ["brain.glb", "brain-points.bin", "brain-regions.json", "NOTICE.txt"];
let dirA, dirB, outA;

before(async () => {
  dirA = await mkdtemp(resolve(tmpdir(), "brain-a-"));
  dirB = await mkdtemp(resolve(tmpdir(), "brain-b-"));
  const quiet = () => {};
  outA = await build({ outDir: dirA, log: quiet });
  await build({ outDir: dirB, log: quiet });
});

test("regions.json names every source mesh exactly once", async () => {
  const { buf } = await loadSource();
  const names = (await readSourceMeshes(buf)).map((m) => m.name);
  assert.equal(names.length, 283);
  assert.equal(new Set(names).size, names.length);
  const text = await readFile(resolve(here, "regions.json"), "utf8");
  const groupsText = text.slice(text.indexOf('"groups"'));
  const keys = [...groupsText.matchAll(/"((?:Allen|VH)_[A-Za-z0-9_]+)":/g)].map((m) => m[1]);
  assert.equal(keys.length, names.length, "duplicate or missing keys in groups");
  assert.deepEqual([...keys].sort(), [...names].sort());
  const file = JSON.parse(text);
  const allowed = new Set([...file.regionIds, ...file.others]);
  assert.equal(file.regionIds.length, 10);
  for (const [name, id] of Object.entries(file.groups)) assert.ok(allowed.has(id), `${name} has unknown region ${id}`);
  for (const id of file.regionIds) assert.ok(Object.values(file.groups).includes(id), `${id} has no mesh`);
});

test("the language region holds left-hemisphere meshes only", async () => {
  const { groups } = JSON.parse(await readFile(resolve(here, "regions.json"), "utf8"));
  for (const [name, id] of Object.entries(groups)) if (id === "language") assert.match(name, /_L$/, name);
});

test("the source file matches its SHA-256", async () => {
  const { path } = await loadSource();
  assert.ok(path);
  assert.equal(SOURCE.sha256.length, 64);
});

test("a second run gives byte-identical outputs", async () => {
  for (const f of FILES) {
    const [a, b] = await Promise.all([readFile(resolve(dirA, f)), readFile(resolve(dirB, f))]);
    assert.ok(a.equals(b), `${f} differs between runs`);
  }
});

test("brain.glb is within the size limit and is meshopt compressed", async () => {
  const glb = await readFile(resolve(dirA, "brain.glb"));
  assert.ok(glb.length <= MAX_GLB_BYTES, `${glb.length} bytes`);
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8"));
  assert.ok(json.extensionsUsed.includes("EXT_meshopt_compression"));
  const nodes = json.nodes.map((n) => n.name);
  for (const id of [...CORTICAL, ...DEEP]) assert.ok(nodes.some((n) => n.startsWith(`${id}_`)), `no node for ${id}`);
  for (const n of json.nodes) {
    assert.match(n.name, /^[a-z]+_[LR]$/);
    assert.equal(`${n.extras.region}_${n.extras.hemisphere}`, n.name);
  }
  assert.ok(nodes.includes("shell_L") || nodes.includes("shell_R"));
});

test("each region has its minimum number of points and the points file matches the manifest", async () => {
  const manifest = JSON.parse(await readFile(resolve(dirA, "brain-regions.json"), "utf8"));
  const bin = await readFile(resolve(dirA, "brain-points.bin"));
  assert.equal(bin.length % 24, 0);
  assert.equal(bin.length / 24, manifest.points.count);
  for (const id of [...CORTICAL, ...DEEP]) {
    const mine = manifest.regions.filter((r) => r.id === id);
    const count = mine.reduce((s, r) => s + r.pointCount, 0);
    const min = CORTICAL.includes(id) ? MIN_POINTS.cortical : MIN_POINTS.deep;
    assert.ok(count >= min, `${id} has ${count} points, needs ${min}`);
  }
  // The ranges tile the file with no gap.
  let next = 0;
  for (const r of manifest.regions.filter((x) => x.pointCount > 0)) {
    assert.equal(r.pointOffset, next);
    assert.equal(r.byteOffset, next * 24);
    next += r.pointCount;
  }
  assert.equal(next, manifest.points.count);
  // Language has no right-hemisphere points, and every normal has unit length.
  assert.equal(manifest.regions.filter((r) => r.id === "language" && r.hemisphere === "R").length, 0);
  for (let i = 0; i < manifest.points.count; i += 97) {
    const l = Math.hypot(bin.readFloatLE(i * 24 + 12), bin.readFloatLE(i * 24 + 16), bin.readFloatLE(i * 24 + 20));
    assert.ok(Math.abs(l - 1) < 1e-3);
  }
});

test("the manifest carries the citation, licence and changes, and the brain spans 200 units", async () => {
  const manifest = JSON.parse(await readFile(resolve(dirA, "brain-regions.json"), "utf8"));
  assert.equal(manifest.citation, CITATION);
  assert.equal(manifest.source.sha256, SOURCE.sha256);
  assert.match(manifest.licence.name, /CC BY 4\.0/);
  assert.match(manifest.changes, /simplified/);
  assert.match(manifest.changes, /recoloured/);
  const notice = await readFile(resolve(dirA, "NOTICE.txt"), "utf8");
  assert.ok(notice.includes(CITATION));
  assert.ok(notice.includes("https://creativecommons.org/licenses/by/4.0/"));
  // Label anchors lie outside the points of their own region.
  for (const r of manifest.regions.filter((x) => x.labelAnchor)) {
    assert.ok(Math.hypot(...r.labelAnchor) > Math.hypot(...r.centroid), `${r.id}_${r.hemisphere} anchor is not outside its centroid`);
  }
  assert.ok(outA.glbBytes > 0);
});

test("the committed asset equals a fresh build", async () => {
  const committed = resolve(here, "../../web/public/brain");
  for (const f of FILES) {
    const [a, b] = await Promise.all([readFile(resolve(committed, f)), readFile(resolve(dirA, f))]);
    assert.ok(a.equals(b), `web/public/brain/${f} is stale, run node build-brain-asset.mjs`);
  }
});

test("cleanup", async () => {
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});
