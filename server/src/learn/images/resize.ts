// Runs the resize step off the main thread. A fresh worker handles each image and is ended afterwards. When the
// worker cannot start or fails, the same step runs in this process, so a broken build still works, only more slowly.
// The worker file is found from the location of this module and not from the working directory.
import { Worker } from "node:worker_threads";
import { resizeImageInProcess, type ResizeOptions, type ResizedImage } from "./resize-core.ts";

const REPLY = "cortex:image-resize-response";
const WORKER_URL = new URL("./resize-worker.ts", import.meta.url);

export type ResizeVia = "worker" | "process";

export interface ResizeRun {
  result: ResizedImage | null;
  via: ResizeVia;
}

export interface ResizeSettings {
  /** false skips the worker */
  worker?: boolean;
  /** replaces the worker file, for a test of the fallback */
  workerUrl?: URL;
}

function inWorker(url: URL, bytes: Uint8Array, mimeType: string, options: ResizeOptions): Promise<ResizedImage | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(url);
    let replied = false;
    const end = () => void worker.terminate().catch(() => undefined);
    // a copy travels, so the buffer of the caller stays whole
    const copy = new Uint8Array(bytes);
    worker.on("message", (m: { type?: string; result?: ResizedImage | null; error?: string }) => {
      if (!m || m.type !== REPLY) return;
      replied = true;
      end();
      if (m.error) reject(new Error(m.error));
      else resolve(m.result ?? null);
    });
    worker.on("error", (e) => {
      end();
      reject(e);
    });
    worker.on("exit", (code) => {
      if (!replied) reject(new Error(`The image resize worker exited with code ${code}.`));
    });
    worker.postMessage({ inputBytes: copy, mimeType, options }, [copy.buffer]);
  });
}

/** Resizes in a worker thread and falls back to this process. The result says which one did the work. */
export async function resizeImage(bytes: Uint8Array, mimeType: string, options: ResizeOptions = {}, settings: ResizeSettings = {}): Promise<ResizeRun> {
  if (settings.worker !== false) {
    try {
      return { result: await inWorker(settings.workerUrl ?? WORKER_URL, bytes, mimeType, options), via: "worker" };
    } catch {
      // the fallback below does the same work
    }
  }
  return { result: resizeImageInProcess(bytes, mimeType, options), via: "process" };
}
