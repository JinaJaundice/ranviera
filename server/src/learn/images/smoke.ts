// A check that the image library and the worker file are present. A missing library would otherwise look like an
// ordinary omitted image, because the resize step answers null. Run it with `node server/src/learn/images/smoke.ts`.
import { fileURLToPath } from "node:url";
import { loadPhoton } from "./resize-core.ts";
import { processImage } from "./process.ts";

export interface SmokeResult {
  ok: boolean;
  worker: boolean;
  detail: string;
}

/** Builds a 64 by 32 picture, shrinks it to 16 pixels wide in the worker and in this process, and compares the two. */
export async function smokeImageRuntime(): Promise<SmokeResult> {
  try {
    const photon = loadPhoton();
    const pixels = new Uint8Array(64 * 32 * 4).fill(200);
    const image = new photon.PhotonImage(pixels, 64, 32);
    const png = image.get_bytes();
    image.free();
    const options = { resize: { maxWidth: 16, maxHeight: 16 } };
    const viaWorker = await processImage(png, "image/png", options);
    const inProcess = await processImage(png, "image/png", { ...options, worker: false });
    if (!viaWorker.ok || !inProcess.ok) return { ok: false, worker: false, detail: "The image library could not resize the test picture." };
    const worker = viaWorker.via === "worker";
    const same = viaWorker.data === inProcess.data;
    return { ok: same && worker, worker, detail: same ? (worker ? "The worker and the fallback agree." : "The worker did not start, and the fallback ran.") : "The worker and the fallback disagree." };
  } catch (e) {
    return { ok: false, worker: false, detail: e instanceof Error ? e.message : "The image runtime failed." };
  }
}

// inside the server bundle every module shares the bundle's address, so the file name is checked as well
if (process.argv[1] && /smoke\.[cm]?[jt]s$/.test(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await smokeImageRuntime();
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
