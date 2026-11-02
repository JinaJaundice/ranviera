// The one implementation of the resize step. The worker thread and the in process fallback both call it. It uses
// Photon (WebAssembly, no native binary). A Photon image lives in WebAssembly memory and is not collected, so every
// image that is created is freed. The file keeps to erasable TypeScript so that a worker can load it directly.
import { createRequire } from "node:module";
import type * as Photon from "@silvia-odwyer/photon-node";
import { applyOrientation, readExifOrientation } from "./exif.ts";
import { exceedsPixelLimit } from "./sniff.ts";

export interface ResizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  /** measured on the base64 text, not on the bytes */
  maxBytes?: number;
  jpegQuality?: number;
}

export interface ResizedImage {
  /** base64 without a prefix */
  data: string;
  mimeType: string;
  /** the size after the orientation was applied */
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
}

export const DEFAULT_MAX_WIDTH = 2000;
export const DEFAULT_MAX_HEIGHT = 2000;
/** 4.5 MiB of base64 text, which leaves room under a 5 MB provider limit */
export const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;
export const DEFAULT_JPEG_QUALITY = 80;
const FALLBACK_QUALITIES = [85, 70, 55, 40];
const LANCZOS3 = 5;

let photonModule: typeof Photon | null = null;
export function loadPhoton(): typeof Photon {
  if (!photonModule) {
    photonModule = createRequire(import.meta.url)("@silvia-odwyer/photon-node") as typeof Photon;
  }
  return photonModule;
}

/** The base64 length of a byte count, from the length alone. */
export const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Width first and then height, each rounded. One scale factor would give other sizes. */
export function targetSize(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  let w = width;
  let h = height;
  if (w > maxWidth) {
    h = Math.round((h * maxWidth) / w);
    w = maxWidth;
  }
  if (h > maxHeight) {
    w = Math.round((w * maxHeight) / h);
    h = maxHeight;
  }
  return { width: Math.max(1, w), height: Math.max(1, h) };
}

/** Decodes an image and applies its orientation. Returns null when the bytes cannot be decoded. */
export function decodeOriented(photon: typeof Photon, bytes: Uint8Array): Photon.PhotonImage | null {
  // the header is read first, because a decode allocates the full size before any other check can run
  if (exceedsPixelLimit(bytes)) return null;
  let raw: Photon.PhotonImage;
  try {
    raw = photon.PhotonImage.new_from_byteslice(bytes);
  } catch {
    return null;
  }
  try {
    const oriented = applyOrientation(photon, raw, readExifOrientation(bytes));
    if (oriented !== raw) raw.free();
    return oriented;
  } catch {
    raw.free();
    return null;
  }
}

export function resizeImageInProcess(bytes: Uint8Array, mimeType: string, options: ResizeOptions = {}): ResizedImage | null {
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const quality = options.jpegQuality ?? DEFAULT_JPEG_QUALITY;
  const photon = loadPhoton();
  const image = decodeOriented(photon, bytes);
  if (!image) return null;
  try {
    const originalWidth = image.get_width();
    const originalHeight = image.get_height();
    // the original bytes are kept when the picture already fits, even if an orientation tag is present
    if (originalWidth <= maxWidth && originalHeight <= maxHeight && base64Length(bytes.length) < maxBytes) {
      return { data: b64(bytes), mimeType, originalWidth, originalHeight, width: originalWidth, height: originalHeight, wasResized: false };
    }
    const qualities = [quality, ...FALLBACK_QUALITIES].filter((q, i, all) => all.indexOf(q) === i);
    let { width, height } = targetSize(originalWidth, originalHeight, maxWidth, maxHeight);
    for (;;) {
      const sized: Photon.PhotonImage = width === originalWidth && height === originalHeight ? image : photon.resize(image, width, height, LANCZOS3);
      try {
        const candidates: { mime: string; make: () => Uint8Array }[] = [
          { mime: "image/png", make: () => sized.get_bytes() },
          ...qualities.map((q) => ({ mime: "image/jpeg", make: () => sized.get_bytes_jpeg(q) })),
        ];
        for (const c of candidates) {
          const encoded = c.make();
          const data = b64(encoded);
          if (data.length < maxBytes) return { data, mimeType: c.mime, originalWidth, originalHeight, width, height, wasResized: true };
        }
      } finally {
        if (sized !== image) sized.free();
      }
      if (width === 1 && height === 1) return null;
      width = Math.max(1, Math.floor(width * 0.75));
      height = Math.max(1, Math.floor(height * 0.75));
    }
  } finally {
    image.free();
  }
}
