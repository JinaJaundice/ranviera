// Builds the brain asset of the Cortex brain view (docs/BRAIN.md, "The brain model").
//
//   node build-brain-asset.mjs [--out <dir>]
//
// Reads the HRA Allen brain model (male, v1.4), groups its 283 meshes into regions with
// regions.json, and writes into web/public/brain/ (or --out):
//   brain.glb              one mesh for each region and hemisphere, plus the shell meshes,
//                          centred on the origin, 200 units across, welded, simplified,
//                          quantised and compressed with EXT_meshopt_compression
//   brain-points.bin       little-endian Float32 groups of 6 (x y z nx ny nz), same coordinates
//   brain-regions.json     centroids, label anchors, triangle counts and point ranges
//   NOTICE.txt             the CC BY 4.0 attribution
// The output is deterministic: the same source and regions.json give the same bytes.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO, Document } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { meshopt } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

export const SOURCE = {
  url: "https://cdn.humanatlas.io/digital-objects/ref-organ/brain-male/v1.4/assets/3d-allen-m-brain.glb",
  sha256: "c97d7d0b9ff0baebbdec5566fa7b08d789195ef965e0bd04cf743a8d683882db",
  bytes: 11982812,
  localPath: resolve(repo, "_work/research/brain/assets/hra-allen-brain-male-v1.4.glb"),
  cachePath: resolve(here, ".cache/3d-allen-m-brain.glb"),
};
export const CITATION =
  "Browne, Kristen, and Heidi Schlehlein. 2024. 3D Reference Organ for Brain, Male v1.4. https://doi.org/10.48539/HBM538.NKCT.649";
export const LICENCE = { name: "Creative Commons Attribution 4.0 International (CC BY 4.0)", url: "https://creativecommons.org/licenses/by/4.0/" };
export const CHANGES =
  "Cortex simplified the meshes, grouped them into regions, re-centred and rescaled them, mirrored them to true handedness (the X axis is negated so that the left hemisphere lies at positive X), and recoloured them.";
export const DERIVED_FROM =
  "Ding et al. 2016, Comprehensive Cellular-Resolution Atlas of the Adult Human Brain, Journal of Comparative Neurology 524(16):3127-3481 (Allen Human Brain Atlas).";

export const BRAIN_SPAN = 200; // units across the largest dimension of the drawn brain
export const MAX_GLB_BYTES = 3_000_000;
export const CORTICAL = ["prefrontal", "language", "occipital", "motor", "parietal", "memory"];
export const DEEP = ["basal", "thalamus", "cerebellum", "brainstem"];
export const MIN_POINTS = { cortical: 6000, deep: 1500 };
// Points written for each region. These are above the minimum so that the placer has room.
const POINT_TARGET = { cortical: 7000, deep: 2000 };
const SIMPLIFY = { ratio: 0.3, errorUnits: 0.3, minTriangles: 40 };
// Hex colours that recolour the regions in the GLB. The app draws with its own tokens.
const COLOURS = {
  prefrontal: "#e6194b", language: "#f58231", occipital: "#4363d8", motor: "#ffe119", parietal: "#3cb44b",
  memory: "#911eb4", basal: "#42d4f4", thalamus: "#f032e6", cerebellum: "#9a6324", brainstem: "#ffffff", shell: "#8899aa",
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Finds the source model, downloading it into .cache when it is not on disk, and checks its SHA-256. */
export async function loadSource() {
  let path = [SOURCE.localPath, SOURCE.cachePath].find((p) => existsSync(p));
  let buf;
  if (path) {
    buf = await readFile(path);
  } else {
    const res = await fetch(SOURCE.url);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${SOURCE.url}`);
    buf = Buffer.from(await res.arrayBuffer());
    path = SOURCE.cachePath;
    if (sha256(buf) === SOURCE.sha256) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, buf);
    }
  }
  const digest = sha256(buf);
  if (digest !== SOURCE.sha256) throw new Error(`source SHA-256 mismatch for ${path}: ${digest}`);
  return { path, buf };
}

export async function readSourceMeshes(buf) {
  const doc = await new NodeIO().readBinary(new Uint8Array(buf));
  const meshes = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const pos = [];
    const idx = [];
    let base = 0;
    for (const prim of mesh.listPrimitives()) {
      const p = prim.getAttribute("POSITION").getArray();
      for (let i = 0; i < p.length; i++) pos.push(p[i]);
      const ind = prim.getIndices()?.getArray();
      const count = p.length / 3;
      if (ind) for (let i = 0; i < ind.length; i++) idx.push(ind[i] + base);
      else for (let i = 0; i < count; i++) idx.push(i + base);
      base += count;
    }
    meshes.push({ name: node.getName(), positions: Float64Array.from(pos), indices: Uint32Array.from(idx) });
  }
  return meshes;
}

function hemisphereOf(name) {
  if (/_L$/.test(name)) return "L";
  if (/_R$/.test(name)) return "R";
  return "M";
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (text) => parseInt(sha256(Buffer.from(text)).slice(0, 8), 16);

const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** Welds vertices by position, drops degenerate triangles and returns compact arrays. */
function weldMesh(groupMeshes) {
  const map = new Map();
  const pos = [];
  const idx = [];
  const key = (x, y, z) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
  for (const m of groupMeshes) {
    const remap = new Uint32Array(m.positions.length / 3);
    for (let v = 0; v < remap.length; v++) {
      const x = m.positions[v * 3], y = m.positions[v * 3 + 1], z = m.positions[v * 3 + 2];
      const k = key(x, y, z);
      let id = map.get(k);
      if (id === undefined) {
        id = pos.length / 3;
        map.set(k, id);
        pos.push(x, y, z);
      }
      remap[v] = id;
    }
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = remap[m.indices[t]], b = remap[m.indices[t + 1]], c = remap[m.indices[t + 2]];
      if (a !== b && b !== c && a !== c) idx.push(a, b, c);
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

function smoothNormals(positions, indices) {
  const n = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; // length is twice the area
    for (const i of [a, b, c]) { n[i] += nx; n[i + 1] += ny; n[i + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

function compact(positions, indices) {
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const outPos = [];
  const outIdx = new Uint32Array(indices.length);
  let next = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (remap[v] < 0) {
      remap[v] = next++;
      outPos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    }
    outIdx[i] = remap[v];
  }
  return { positions: Float32Array.from(outPos), indices: outIdx };
}

function simplifyMesh(welded) {
  const tris = welded.indices.length / 3;
  const target = Math.max(SIMPLIFY.minTriangles, Math.ceil(tris * SIMPLIFY.ratio)) * 3;
  if (target >= welded.indices.length) return compact(welded.positions, welded.indices);
  const [out] = MeshoptSimplifier.simplify(welded.indices, welded.positions, 3, target, SIMPLIFY.errorUnits, ["ErrorAbsolute"]);
  return compact(welded.positions, out);
}

/** Region and hemisphere triangles in output coordinates, for sampling and anchors. */
function triangleSoup(groupMeshes) {
  const tris = [];
  for (const m of groupMeshes) {
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3;
      tris.push([
        m.positions[a], m.positions[a + 1], m.positions[a + 2],
        m.positions[b], m.positions[b + 1], m.positions[b + 2],
        m.positions[c], m.positions[c + 1], m.positions[c + 2],
        m.hemisphere,
      ]);
    }
  }
  return tris;
}

function triArea(t) {
  const ux = t[3] - t[0], uy = t[4] - t[1], uz = t[5] - t[2];
  const vx = t[6] - t[0], vy = t[7] - t[1], vz = t[8] - t[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return { area: 0.5 * Math.hypot(nx, ny, nz), nx, ny, nz };
}

/** Samples points by area with a seeded generator and a minimum spacing (dart throwing on a hash grid). */
function samplePoints(tris, count, seedText) {
  const areas = tris.map(triArea);
  const cum = new Float64Array(tris.length);
  let total = 0;
  for (let i = 0; i < tris.length; i++) { total += areas[i].area; cum[i] = total; }
  const pick = (u) => {
    let lo = 0, hi = cum.length - 1;
    const target = u * total;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const candidatesPerPoint = 14;
  let radius = Math.sqrt(total / (0.866 * count)) * 0.72;
  for (let attempt = 0; attempt < 40; attempt++) {
    const rng = mulberry32(seedOf(seedText));
    const cell = radius;
    const grid = new Map();
    const accepted = [];
    const r2 = radius * radius;
    for (let c = 0; c < count * candidatesPerPoint && accepted.length < count; c++) {
      const ti = pick(rng());
      const t = tris[ti];
      let u = rng(), v = rng();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const w = 1 - u - v;
      const x = w * t[0] + u * t[3] + v * t[6];
      const y = w * t[1] + u * t[4] + v * t[7];
      const z = w * t[2] + u * t[5] + v * t[8];
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell), gz = Math.floor(z / cell);
      let clash = false;
      for (let dx = -1; dx <= 1 && !clash; dx++) for (let dy = -1; dy <= 1 && !clash; dy++) for (let dz = -1; dz <= 1 && !clash; dz++) {
        const list = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
        if (!list) continue;
        for (const p of list) {
          const ex = p[0] - x, ey = p[1] - y, ez = p[2] - z;
          if (ex * ex + ey * ey + ez * ez < r2) { clash = true; break; }
        }
      }
      if (clash) continue;
      const a = areas[ti];
      const l = Math.hypot(a.nx, a.ny, a.nz) || 1;
      const p = [x, y, z, a.nx / l, a.ny / l, a.nz / l, t[9]];
      const k = `${gx},${gy},${gz}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(p);
      accepted.push(p);
    }
    if (accepted.length >= count) return { points: accepted, radius };
    radius *= 0.93;
  }
  throw new Error(`could not place ${count} points for ${seedText}`);
}

/** Distance along the ray from the origin to the farthest triangle it crosses (Moller-Trumbore). */
function farthestHit(tris, d) {
  let best = 0;
  for (const t of tris) {
    const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2];
    const e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tx = -t[0], ty = -t[1], tz = -t[2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (s > best) best = s;
  }
  return best;
}

export async function build({ outDir = resolve(repo, "web/public/brain"), log = console.log } = {}) {
  await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const { path: sourcePath, buf } = await loadSource();
  const sourceMeshes = await readSourceMeshes(buf);
  const regionsFile = JSON.parse(await readFile(resolve(here, "regions.json"), "utf8"));
  const groups = regionsFile.groups;
  const regionIds = regionsFile.regionIds;

  for (const m of sourceMeshes) if (!(m.name in groups)) throw new Error(`regions.json does not name ${m.name}`);
  const drawn = sourceMeshes.filter((m) => groups[m.name] !== "hidden");

  // Re-centre on the origin and scale so that the drawn brain spans BRAIN_SPAN units.
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of drawn) for (let i = 0; i < m.positions.length; i++) {
    const a = i % 3;
    if (m.positions[i] < min[a]) min[a] = m.positions[i];
    if (m.positions[i] > max[a]) max[a] = m.positions[i];
  }
  const centre = min.map((v, i) => (v + max[i]) / 2);
  const scale = BRAIN_SPAN / Math.max(...max.map((v, i) => v - min[i]));
  for (const m of drawn) {
    m.hemisphere = hemisphereOf(m.name);
    for (let i = 0; i < m.positions.length; i++) m.positions[i] = (m.positions[i] - centre[i % 3]) * scale;
    // Mirror to true handedness: the source has its left hemisphere at negative X, and with Y up and
    // anterior +Z a person's left is at positive X. Negating X reverses the winding, so swap two
    // indices of each triangle to keep the faces pointing outwards.
    for (let i = 0; i < m.positions.length; i += 3) m.positions[i] = -m.positions[i];
    for (let t = 0; t < m.indices.length; t += 3) { const k = m.indices[t + 1]; m.indices[t + 1] = m.indices[t + 2]; m.indices[t + 2] = k; }
  }

  // Group the drawn meshes by region and hemisphere in a fixed order.
  const order = [...regionIds, "shell"];
  const buckets = [];
  for (const id of order) {
    for (const h of ["L", "R"]) {
      const list = drawn.filter((m) => groups[m.name] === id && m.hemisphere === h).sort((a, b) => (a.name < b.name ? -1 : 1));
      if (list.length) buckets.push({ id, hemisphere: h, meshes: list });
    }
  }
  const stray = drawn.filter((m) => m.hemisphere === "M");
  if (stray.length) throw new Error(`drawn meshes without a hemisphere: ${stray.map((m) => m.name)}`);

  // The GLB.
  const doc = new Document();
  doc.createBuffer("brain");
  const scene = doc.createScene("brain");
  doc.getRoot().getAsset().generator = "cortex build-brain-asset";
  const materials = {};
  for (const id of order) {
    const rgb = [1, 3, 5].map((i) => parseInt(COLOURS[id].slice(i, i + 2), 16) / 255);
    const lin = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    materials[id] = doc.createMaterial(id).setBaseColorFactor([...lin, 1]).setMetallicFactor(0).setRoughnessFactor(0.8).setDoubleSided(true);
  }
  const bucketInfo = [];
  for (const b of buckets) {
    const welded = weldMesh(b.meshes);
    const simplified = simplifyMesh(welded);
    const normals = smoothNormals(simplified.positions, simplified.indices);
    const name = `${b.id}_${b.hemisphere}`;
    const prim = doc.createPrimitive()
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(simplified.positions))
      .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(normals))
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(simplified.indices))
      .setMaterial(materials[b.id]);
    const mesh = doc.createMesh(name).addPrimitive(prim);
    const node = doc.createNode(name).setMesh(mesh).setExtras({ region: b.id, hemisphere: b.hemisphere });
    scene.addChild(node);
    bucketInfo.push({ ...b, sourceTriangles: welded.indices.length / 3, triangles: simplified.indices.length / 3, soup: triangleSoup(b.meshes) });
  }
  await doc.transform(meshopt({
    encoder: MeshoptEncoder, level: "high",
    quantizePosition: 14, quantizeNormal: 8, quantizeTexcoord: 12, quantizeColor: 8, quantizeGeneric: 12,
  }));
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  const glb = Buffer.from(await io.writeBinary(doc));

  // Points, per region, then split between hemispheres in the order L, R.
  const allSoup = bucketInfo.flatMap((b) => b.soup);
  const pointChunks = [];
  const regions = [];
  let pointOffset = 0;
  for (const id of regionIds) {
    const mine = bucketInfo.filter((b) => b.id === id);
    const soup = mine.flatMap((b) => b.soup);
    const target = CORTICAL.includes(id) ? POINT_TARGET.cortical : POINT_TARGET.deep;
    const { points, radius } = samplePoints(soup, target, id);
    for (const b of mine) {
      const own = points.filter((p) => p[6] === b.hemisphere);
      // Surface-area centroid of the region and hemisphere.
      let ax = 0, ay = 0, az = 0, at = 0;
      for (const t of b.soup) {
        const { area } = triArea(t);
        ax += area * (t[0] + t[3] + t[6]) / 3; ay += area * (t[1] + t[4] + t[7]) / 3; az += area * (t[2] + t[5] + t[8]) / 3; at += area;
      }
      const c = [ax / at, ay / at, az / at];
      const len = Math.hypot(...c);
      const dir = c.map((v) => v / len);
      const exit = farthestHit(allSoup, dir);
      const anchor = dir.map((v) => v * (exit + 8));
      regions.push({
        id, hemisphere: b.hemisphere, triangles: b.triangles, sourceTriangles: b.sourceTriangles,
        centroid: c.map((v) => round(v)), labelAnchor: anchor.map((v) => round(v)),
        pointOffset: pointOffset + 0, pointCount: own.length, byteOffset: (pointOffset) * 24,
      });
      for (const p of own) pointChunks.push(p);
      pointOffset += own.length;
    }
    log(`${id}: ${points.length} points, spacing ${round(radius, 2)} units`);
  }
  const pointsBuf = Buffer.alloc(pointChunks.length * 24);
  pointChunks.forEach((p, i) => { for (let k = 0; k < 6; k++) pointsBuf.writeFloatLE(p[k], i * 24 + k * 4); });
  for (const b of bucketInfo.filter((x) => x.id === "shell")) {
    regions.push({ id: "shell", hemisphere: b.hemisphere, triangles: b.triangles, sourceTriangles: b.sourceTriangles, centroid: null, labelAnchor: null, pointOffset: 0, pointCount: 0, byteOffset: 0 });
  }

  const manifest = {
    version: 1,
    source: { url: SOURCE.url, sha256: SOURCE.sha256, bytes: SOURCE.bytes, title: "3D Reference Organ for Brain, Male v1.4", derivedFrom: DERIVED_FROM },
    licence: LICENCE,
    citation: CITATION,
    changes: CHANGES,
    coordinates: {
      note: "Y up, anterior +Z, true handedness: meshes named _L at positive X (the source has them at negative X and Cortex mirrored it). The drawn brain is centred on the origin and spans the stated number of units in its largest dimension.",
      span: BRAIN_SPAN,
      sourceScale: round(scale, 4),
      sourceCentreMetres: centre.map((v) => round(v, 6)),
    },
    points: { file: "brain-points.bin", format: "Float32 little-endian, groups of 6: x y z nx ny nz", stride: 24, count: pointChunks.length, offsetUnit: "points" },
    triangles: regions.reduce((s, r) => s + r.triangles, 0),
    regions,
  };
  const notice = [
    "Brain model notice",
    "",
    "Citation: " + CITATION,
    "Source: " + SOURCE.url,
    "Source SHA-256: " + SOURCE.sha256,
    "Derived from: " + DERIVED_FROM,
    "Licence: " + LICENCE.name + ", " + LICENCE.url,
    "Changes: " + CHANGES,
    "",
    "The files brain.glb, brain-points.bin and brain-regions.json in this folder are adapted material under that licence.",
    "",
  ].join("\n");

  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, "brain.glb"), glb);
  await writeFile(resolve(outDir, "brain-points.bin"), pointsBuf);
  await writeFile(resolve(outDir, "brain-regions.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(resolve(outDir, "NOTICE.txt"), notice);
  log(`source ${sourcePath}`);
  log(`brain.glb ${glb.length} bytes, ${manifest.triangles} triangles; ${pointChunks.length} points`);
  return { outDir, glbBytes: glb.length, triangles: manifest.triangles, regions };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  await build(i >= 0 ? { outDir: resolve(process.argv[i + 1]) } : {});
}
