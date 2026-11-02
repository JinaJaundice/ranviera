// Finds the type of an image from its first bytes. The file name and the declared type play no part, because a
// picture saved under a text extension must still be read as a picture. Only the five inline types are named.
// A PNG is not checked for CRC errors, since a truncated body is caught later when the image is decoded.

export type ImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/bmp";

/** The number of leading bytes that the sniffer needs from a file. */
export const SNIFF_BYTES = 4100;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BMP_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

const ascii = (b: Uint8Array, at: number, length: number): string => String.fromCharCode(...b.subarray(at, at + length));
const u32le = (b: Uint8Array, at: number): number => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const u32be = (b: Uint8Array, at: number): number => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** True for a PNG whose chunks announce an animation before the first image data chunk. */
function isAnimatedPng(b: Uint8Array): boolean {
  let at = 8;
  while (at + 8 <= b.length) {
    const length = u32be(b, at);
    const kind = ascii(b, at + 4, 4);
    if (kind === "acTL") return true;
    if (kind === "IDAT") return false;
    at += 12 + length;
  }
  return false;
}

export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const b = bytes.length > SNIFF_BYTES ? bytes.subarray(0, SNIFF_BYTES) : bytes;
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // the marker F7 starts the lossless JPEG variant, which no inline decoder reads
    return b[3] === 0xf7 ? null : "image/jpeg";
  }
  if (b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v)) {
    if (b.length < 33 || u32be(b, 8) !== 13 || ascii(b, 12, 4) !== "IHDR") return null;
    return isAnimatedPng(b) ? null : "image/png";
  }
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const dib = u32le(b, 14);
    const dataOffset = u32le(b, 10);
    if (BMP_HEADER_SIZES.has(dib) && dataOffset >= 14 + dib && dataOffset <= bytes.length) return "image/bmp";
  }
  return null;
}

/** The most pixels that are decoded. A small file can claim far more, and a decode allocates four bytes for each pixel. */
export const MAX_IMAGE_PIXELS = 40_000_000;

const u16le = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u16be = (b: Uint8Array, at: number): number => (b[at] << 8) | b[at + 1];

/**
 * The width and height that a picture declares in its header, read without decoding. The signature decides, not
 * the declared type, so that a bomb saved under a wrong type is still measured. Returns null when the header is
 * absent or is not one of the five known formats.
 */
export function imageDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (b.length >= 24 && PNG_SIGNATURE.every((v, i) => b[i] === v) && ascii(b, 12, 4) === "IHDR") return { width: u32be(b, 16), height: u32be(b, 20) };
  if (b.length >= 10 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return { width: u16le(b, 6), height: u16le(b, 8) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1];
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      const length = u16be(b, at + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return at + 9 <= b.length ? { width: u16be(b, at + 7), height: u16be(b, at + 5) } : null;
      if (length < 2) return null;
      at += 2 + length;
    }
    return null;
  }
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const kind = ascii(b, 12, 4);
    if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (kind === "VP8L" && b[20] === 0x2f) return { width: 1 + (b[21] | ((b[22] & 0x3f) << 8)), height: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) };
    return null;
  }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    if (u32le(b, 14) === 12) return { width: u16le(b, 18), height: u16le(b, 20) };
    const w = u32le(b, 18) | 0;
    const h = u32le(b, 22) | 0;
    return { width: Math.abs(w), height: Math.abs(h) };
  }
  return null;
}

/** True when the header declares more pixels than MAX_IMAGE_PIXELS. */
export function exceedsPixelLimit(bytes: Uint8Array): boolean {
  const d = imageDimensions(bytes);
  return d !== null && d.width * d.height > MAX_IMAGE_PIXELS;
}
