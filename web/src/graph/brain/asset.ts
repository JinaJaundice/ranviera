// Loads the three files of the brain asset (docs/BRAIN.md, "The brain model"). One load serves every engine.
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { Group } from "three";
import type { BrainManifest } from "./types";

export interface BrainAsset {
  scene: Group;
  /** x, y, z and the surface normal of each sample point */
  points: Float32Array;
  manifest: BrainManifest;
}

let cached: Promise<BrainAsset> | null = null;

async function load(base: string): Promise<BrainAsset> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const [gltf, bin, manifest] = await Promise.all([
    loader.loadAsync(`${base}brain.glb`),
    fetch(`${base}brain-points.bin`).then((r) => {
      if (!r.ok) throw new Error(`brain-points.bin: ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch(`${base}brain-regions.json`).then((r) => {
      if (!r.ok) throw new Error(`brain-regions.json: ${r.status}`);
      return r.json() as Promise<BrainManifest>;
    }),
  ]);
  return { scene: gltf.scene, points: new Float32Array(bin), manifest };
}

/** The asset, loaded once. A failed load is not kept, so that the next call tries again. */
export function loadBrainAsset(base = "/brain/"): Promise<BrainAsset> {
  if (!cached) {
    cached = load(base).catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}
