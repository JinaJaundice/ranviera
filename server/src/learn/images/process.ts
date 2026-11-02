// The one function by which an image reaches a model: the read tool, a rendered PDF page and a pasted image all
// call processImage. It never throws for bad image content. It returns the failure form, whose message is written
// for the model to read in place of the picture (docs/learning/jobs.md, "Images").
import { decodeOriented, loadPhoton, type ResizeOptions } from "./resize-core.ts";
import { resizeImage, type ResizeSettings, type ResizeVia } from "./resize.ts";
import { exceedsPixelLimit } from "./sniff.ts";

export type ProcessedImage = { ok: true; data: string; mimeType: string; hints: string[]; via?: ResizeVia } | { ok: false; message: string };

export interface ProcessImageOptions {
  /** the limits of the model, each field optional */
  resize?: ResizeOptions;
  /** false returns the normalised bytes without a resize */
  autoResize?: boolean;
  /** false keeps the work in this process */
  worker?: boolean;
  workerUrl?: ResizeSettings["workerUrl"];
}

/** The largest file that is read into memory for an image. */
export const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024;

const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const OMIT_RESIZE = "[Image omitted: the picture stayed over the inline size limit after every resize attempt.]";
const OMIT_CONVERT = "[Image omitted: no supported inline format could be produced from this file.]";
const OMIT_LARGE = "[Image omitted: the file is larger than 25 MiB.]";
const OMIT_PIXELS = "[Image omitted: the picture holds more than 40 million pixels.]";

/** The declared type cut at a semicolon, trimmed and lower cased, with jpg written as jpeg. */
export function normaliseMime(declared: string): string {
  const base = declared.split(";")[0].trim().toLowerCase();
  return base === "image/jpg" ? "image/jpeg" : base;
}

export async function processImage(bytes: Uint8Array, declaredType: string, options: ProcessImageOptions = {}): Promise<ProcessedImage> {
  if (bytes.length > MAX_IMAGE_FILE_BYTES) return { ok: false, message: OMIT_LARGE };
  // checked from the header before any decode, in the worker or in this process
  if (exceedsPixelLimit(bytes)) return { ok: false, message: OMIT_PIXELS };
  let mime = normaliseMime(declaredType);
  let data = bytes;
  const original = mime;
  const hints: string[] = [];
  if (!INLINE.has(mime)) {
    // a type that models do not take inline is decoded and written again as a PNG
    const photon = loadPhoton();
    const image = decodeOriented(photon, bytes);
    if (!image) return { ok: false, message: OMIT_CONVERT };
    try {
      data = image.get_bytes();
    } catch {
      return { ok: false, message: OMIT_CONVERT };
    } finally {
      image.free();
    }
    mime = "image/png";
    hints.push(`[Image converted from ${original || "an unknown type"} to ${mime}.]`);
  }
  if (options.autoResize === false) return { ok: true, data: Buffer.from(data).toString("base64"), mimeType: mime, hints };
  const run = await resizeImage(data, mime, options.resize ?? {}, { worker: options.worker, workerUrl: options.workerUrl });
  if (!run.result) return { ok: false, message: OMIT_RESIZE };
  const r = run.result;
  if (r.wasResized) {
    const scale = (r.originalWidth / r.width).toFixed(2);
    hints.push(`[Image: original ${r.originalWidth}x${r.originalHeight}, displayed at ${r.width}x${r.height}. Multiply coordinates by ${scale} to map to original image.]`);
  }
  return { ok: true, data: r.data, mimeType: r.mimeType, hints, via: run.via };
}
