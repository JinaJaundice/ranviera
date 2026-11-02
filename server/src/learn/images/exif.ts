// EXIF orientation. The value is read from the encoded bytes of a JPEG or a WebP picture, because the decoder does
// not apply it. PNG, GIF and BMP carry no orientation here. Any structural fault reads as the normal orientation 1.
import type * as Photon from "@silvia-odwyer/photon-node";

type PhotonModule = typeof Photon;

const ascii = (b: Uint8Array, at: number, length: number): string => String.fromCharCode(...b.subarray(at, at + length));

/** Reads tag 0x0112 from the first directory of a TIFF block that starts at `start`. */
function orientationFromTiff(b: Uint8Array, start: number): number {
  if (start + 8 > b.length) return 1;
  const little = b[start] === 0x49 && b[start + 1] === 0x49;
  const u16 = (at: number): number => (little ? b[at] | (b[at + 1] << 8) : (b[at] << 8) | b[at + 1]);
  const u32 = (at: number): number =>
    little ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0 : ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
  const dir = start + u32(start + 4);
  if (dir + 2 > b.length) return 1;
  const count = u16(dir);
  for (let i = 0; i < count; i++) {
    const entry = dir + 2 + i * 12;
    if (entry + 12 > b.length) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function fromJpeg(b: Uint8Array): number {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return 1;
    while (b[at] === 0xff && at + 1 < b.length) at += 1;
    const marker = b[at];
    at += 1;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0xda || marker === 0xd9) return 1;
    if (at + 2 > b.length) return 1;
    const length = (b[at] << 8) | b[at + 1];
    if (length < 2) return 1;
    if (marker === 0xe1 && ascii(b, at + 2, 4) === "Exif" && b[at + 6] === 0 && b[at + 7] === 0) {
      return orientationFromTiff(b, at + 8);
    }
    at += length;
  }
  return 1;
}

function fromWebp(b: Uint8Array): number {
  let at = 12;
  while (at + 8 <= b.length) {
    const kind = ascii(b, at, 4);
    const size = (b[at + 4] | (b[at + 5] << 8) | (b[at + 6] << 16) | (b[at + 7] << 24)) >>> 0;
    const body = at + 8;
    if (kind === "EXIF") {
      if (body + size > b.length) return 1;
      return orientationFromTiff(b, ascii(b, body, 4) === "Exif" ? body + 6 : body);
    }
    at = body + size + (size % 2);
  }
  return 1;
}

/** The orientation 1 to 8 of an encoded image. */
export function readExifOrientation(bytes: Uint8Array): number {
  try {
    if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return fromJpeg(bytes);
    if (bytes.length > 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return fromWebp(bytes);
  } catch {
    // a fault reads as the normal orientation
  }
  return 1;
}

/** Turns a picture by 90 degrees. The library has no rotation, so the pixels are copied. */
function rotate(photon: PhotonModule, image: Photon.PhotonImage, clockwise: boolean): Photon.PhotonImage {
  const w = image.get_width();
  const h = image.get_height();
  const from = image.get_raw_pixels();
  const to = new Uint8Array(from.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = clockwise ? h - 1 - y : y;
      const ny = clockwise ? x : w - 1 - x;
      const src = (y * w + x) * 4;
      const dst = (ny * h + nx) * 4;
      to[dst] = from[src];
      to[dst + 1] = from[src + 1];
      to[dst + 2] = from[src + 2];
      to[dst + 3] = from[src + 3];
    }
  }
  return new photon.PhotonImage(to, h, w);
}

/**
 * Applies an orientation to the pixels. The result may be the same object, after an in place flip, or a new image
 * when the width and height swap. The caller frees the old image only when the objects differ.
 */
export function applyOrientation(photon: PhotonModule, image: Photon.PhotonImage, orientation: number): Photon.PhotonImage {
  switch (orientation) {
    case 2:
      photon.fliph(image);
      return image;
    case 3:
      photon.fliph(image);
      photon.flipv(image);
      return image;
    case 4:
      photon.flipv(image);
      return image;
    case 5: {
      const turned = rotate(photon, image, true);
      photon.fliph(turned);
      return turned;
    }
    case 6:
      return rotate(photon, image, true);
    case 7: {
      const turned = rotate(photon, image, false);
      photon.fliph(turned);
      return turned;
    }
    case 8:
      return rotate(photon, image, false);
    default:
      return image;
  }
}
