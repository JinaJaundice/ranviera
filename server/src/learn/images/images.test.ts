// Tests of the image pipeline: the sniffer, the orientation table, the limits at the limit and one over, the
// encoding search, the worker against the in process fallback, and the canonical PNG.
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { applyOrientation, readExifOrientation } from "./exif.ts";
import { canonicalPng } from "./png.ts";
import { processImage, MAX_IMAGE_FILE_BYTES } from "./process.ts";
import { base64Length, decodeOriented, loadPhoton, targetSize } from "./resize-core.ts";
import { imageDimensions, sniffImageType } from "./sniff.ts";
import { smokeImageRuntime } from "./smoke.ts";

const photon = loadPhoton();

function solid(w: number, h: number, rgb = [200, 40, 40]): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  const img = new photon.PhotonImage(px, w, h);
  const out = img.get_bytes();
  img.free();
  return out;
}

function noise(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  let s = 12345;
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      px[i * 4 + c] = s >> 16;
    }
    px[i * 4 + 3] = 255;
  }
  const img = new photon.PhotonImage(px, w, h);
  const out = img.get_bytes();
  img.free();
  return out;
}

function jpeg(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4).fill(180);
  const img = new photon.PhotonImage(px, w, h);
  const out = img.get_bytes_jpeg(90);
  img.free();
  return out;
}

/** Inserts an EXIF block with one orientation tag straight after the start marker of a JPEG. */
function withOrientation(bytes: Uint8Array, value: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, value, 0, 0, 0, 0, 0, 0];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const segment = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  return new Uint8Array([bytes[0], bytes[1], ...segment, ...bytes.subarray(2)]);
}

function dimsOf(base64: string): { w: number; h: number } {
  const img = photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64"));
  const out = { w: img.get_width(), h: img.get_height() };
  img.free();
  return out;
}

function bmp(w: number, h: number): Uint8Array {
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
  const b = Buffer.alloc(size);
  b.write("BM", 0, "latin1");
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.writeUIntBE(0x2060c0, 54 + y * row + x * 3, 3);
  return new Uint8Array(b);
}

const chunk = (kind: string, body: Buffer): Buffer => {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(kind, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
};

describe("sniffing", () => {
  it("names the five types from their first bytes and ignores everything else", () => {
    expect(sniffImageType(solid(2, 2))).toBe("image/png");
    expect(sniffImageType(jpeg(4, 4))).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "latin1"))).toBe("image/gif");
    expect(sniffImageType(Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "latin1"))).toBe("image/webp");
    expect(sniffImageType(bmp(2, 2))).toBe("image/bmp");
    expect(sniffImageType(Buffer.from("plain text, not a picture"))).toBeNull();
  });

  it("rejects JPEG LS, an animated PNG, a PNG with no header chunk and a malformed BMP", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xf7, 0, 0, 0, 0]))).toBeNull();
    const png = Buffer.from(solid(2, 2));
    const animated = Buffer.concat([png.subarray(0, 33), chunk("acTL", Buffer.alloc(8)), png.subarray(33)]);
    expect(sniffImageType(animated)).toBeNull();
    expect(sniffImageType(Buffer.from("89504e470d0a1a0a", "hex"))).toBeNull();
    const bad = Buffer.from(bmp(2, 2));
    bad.writeUInt32LE(7, 14);
    expect(sniffImageType(bad)).toBeNull();
  });
});

describe("orientation", () => {
  const red = (img: InstanceType<typeof photon.PhotonImage>): number[] => {
    const px = img.get_raw_pixels();
    const out: number[] = [];
    for (let i = 0; i < px.length; i += 4) out.push(px[i]);
    return out;
  };
  const expected: Record<number, number[]> = {
    1: [1, 2, 3, 4, 5, 6],
    2: [3, 2, 1, 6, 5, 4],
    3: [6, 5, 4, 3, 2, 1],
    4: [4, 5, 6, 1, 2, 3],
    5: [1, 4, 2, 5, 3, 6],
    6: [4, 1, 5, 2, 6, 3],
    7: [6, 3, 5, 2, 4, 1],
    8: [3, 6, 2, 5, 1, 4],
  };
  for (const value of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`places every pixel for orientation ${value}`, () => {
      const px = new Uint8Array(3 * 2 * 4);
      [1, 2, 3, 4, 5, 6].forEach((v, i) => px.set([v, 0, 0, 255], i * 4));
      const img = new photon.PhotonImage(px, 3, 2);
      const turned = applyOrientation(photon, img, value);
      expect(red(turned)).toEqual(expected[value]);
      expect([turned.get_width(), turned.get_height()]).toEqual(value >= 5 ? [2, 3] : [3, 2]);
    });
  }

  it("reads the tag from a JPEG and reads a damaged block as 1", () => {
    expect(readExifOrientation(withOrientation(jpeg(12, 8), 6))).toBe(6);
    expect(readExifOrientation(withOrientation(jpeg(12, 8), 9))).toBe(1);
    expect(readExifOrientation(jpeg(12, 8))).toBe(1);
    expect(readExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff]))).toBe(1);
  });

  it("reports the oriented size and applies it when a resize is needed", async () => {
    const tagged = withOrientation(jpeg(12, 8), 6);
    const fits = await processImage(tagged, "image/jpeg");
    // the picture fits, so the original bytes travel with their tag
    expect(fits).toMatchObject({ ok: true, mimeType: "image/jpeg", hints: [] });
    expect(fits.ok && fits.data).toBe(Buffer.from(tagged).toString("base64"));
    const small = await processImage(tagged, "image/jpeg", { resize: { maxWidth: 4, maxHeight: 100 } });
    expect(small.ok).toBe(true);
    if (small.ok) {
      expect(dimsOf(small.data)).toEqual({ w: 4, h: 6 });
      expect(small.hints[0]).toContain("original 8x12");
    }
  });
});

describe("limits", () => {
  it("returns a picture inside the limits unchanged and normalises the declared type", async () => {
    const png = solid(8, 8);
    const r = await processImage(png, " Image/PNG; charset=binary ");
    expect(r).toMatchObject({ ok: true, mimeType: "image/png", hints: [] });
    expect(r.ok && r.data).toBe(Buffer.from(png).toString("base64"));
    const j = await processImage(jpeg(8, 8), "image/jpg");
    expect(j).toMatchObject({ ok: true, mimeType: "image/jpeg" });
  });

  it("keeps a width of 2000 and shrinks a width of 2001", async () => {
    const at = await processImage(solid(2000, 1), "image/png");
    expect(at).toMatchObject({ ok: true, hints: [] });
    const over = await processImage(solid(2001, 1), "image/png");
    expect(over.ok).toBe(true);
    if (over.ok) {
      expect(dimsOf(over.data)).toEqual({ w: 2000, h: 1 });
      expect(over.hints[0]).toContain("original 2001x1");
      expect(over.hints[0]).toContain("Multiply coordinates by 1.00");
    }
    const tall = await processImage(solid(1, 2001), "image/png");
    expect(tall.ok && dimsOf(tall.data)).toEqual({ w: 1, h: 2000 });
  });

  it("measures the size cap on base64 with a strict comparison", async () => {
    const png = solid(32, 32);
    const length = base64Length(png.length);
    const equal = await processImage(png, "image/png", { resize: { maxBytes: length } });
    // at exactly the cap the unchanged path is not taken and the picture is written again
    expect(equal.ok).toBe(true);
    expect(equal.ok && equal.hints.some((h) => h.includes("displayed at"))).toBe(true);
    const above = await processImage(png, "image/png", { resize: { maxBytes: length + 1 } });
    expect(above).toMatchObject({ ok: true, hints: [] });
  });

  it("tries PNG first, then JPEG, then smaller sizes, and omits a picture that never fits", async () => {
    const flat = await processImage(solid(64, 64), "image/png", { resize: { maxWidth: 32, maxHeight: 32 } });
    expect(flat.ok && flat.mimeType).toBe("image/png");
    const grain = noise(120, 120);
    const jpegFirst = await processImage(grain, "image/png", { resize: { maxBytes: 30_000 } });
    expect(jpegFirst.ok).toBe(true);
    if (jpegFirst.ok) {
      expect(jpegFirst.data.length).toBeLessThan(30_000);
      expect(jpegFirst.mimeType).toBe("image/jpeg");
      expect(dimsOf(jpegFirst.data).w).toBe(120);
    }
    const smaller = await processImage(grain, "image/png", { resize: { maxBytes: 4_000 } });
    expect(smaller.ok && smaller.data.length).toBeLessThan(4_000);
    expect(smaller.ok && dimsOf(smaller.data).w).toBeLessThan(120);
    const none = await processImage(grain, "image/png", { resize: { maxBytes: 1 } });
    expect(none).toEqual({ ok: false, message: "[Image omitted: the picture stayed over the inline size limit after every resize attempt.]" });
  });

  it("computes the target size in two rounded steps", () => {
    expect(targetSize(301, 503, 101, 100)).toEqual({ width: 60, height: 100 });
    expect(targetSize(12000, 24, 2000, 2000)).toEqual({ width: 2000, height: 4 });
  });

  it("refuses a file over 25 MiB and a corrupt picture without sending raw bytes", async () => {
    const huge = await processImage(new Uint8Array(MAX_IMAGE_FILE_BYTES + 1), "image/png");
    expect(huge.ok).toBe(false);
    const cut = Buffer.from(solid(50, 50)).subarray(0, 60);
    const bad = await processImage(cut, "image/png", { resize: { maxWidth: 10 } });
    expect(bad).toMatchObject({ ok: false });
    expect(bad.ok === false && bad.message.startsWith("[Image omitted")).toBe(true);
  });

  it("converts a BMP to PNG with a hint and omits a BMP that cannot be decoded", async () => {
    const r = await processImage(bmp(4, 4), "image/bmp");
    expect(r).toMatchObject({ ok: true, mimeType: "image/png" });
    expect(r.ok && r.hints[0]).toBe("[Image converted from image/bmp to image/png.]");
    const bad = await processImage(new Uint8Array([1, 2, 3]), "image/bmp");
    expect(bad).toEqual({ ok: false, message: "[Image omitted: no supported inline format could be produced from this file.]" });
  });
});

describe("worker", () => {
  it("gives the same result in a worker thread and in process, and falls back when the worker file is missing", async () => {
    const png = noise(90, 90);
    const options = { resize: { maxWidth: 40, maxHeight: 40 } };
    const a = await processImage(png, "image/png", options);
    const b = await processImage(png, "image/png", { ...options, worker: false });
    const c = await processImage(png, "image/png", { ...options, workerUrl: new URL("file:///no/such/worker.ts") });
    expect(a.ok && a.via).toBe("worker");
    expect(b.ok && b.via).toBe("process");
    expect(c.ok && c.via).toBe("process");
    expect(a.ok && b.ok && c.ok && [a.data, b.data, c.data]).toEqual([b.ok && b.data, b.ok && b.data, b.ok && b.data]);
  });

  it("leaves the buffer of the caller intact", async () => {
    const png = solid(30, 30);
    const copy = new Uint8Array(png);
    await processImage(png, "image/png", { resize: { maxWidth: 10 } });
    expect(png).toEqual(copy);
  });

  it("passes the smoke check in Node", async () => {
    const s = await smokeImageRuntime();
    expect(s).toMatchObject({ ok: true, worker: true });
  });
});

describe("canonical PNG", () => {
  it("merges split data chunks into one and keeps the pixels", () => {
    const png = Buffer.from(noise(40, 40));
    // find the single IDAT chunk and cut it in two
    let at = 8;
    const parts: Buffer[] = [png.subarray(0, 8)];
    while (at < png.length) {
      const len = png.readUInt32BE(at);
      const kind = png.toString("latin1", at + 4, at + 8);
      const body = png.subarray(at + 8, at + 8 + len);
      if (kind === "IDAT") {
        const half = Math.floor(len / 2);
        parts.push(chunk("IDAT", body.subarray(0, half)), chunk("IDAT", body.subarray(half)));
      } else parts.push(png.subarray(at, at + 12 + len));
      at += 12 + len;
    }
    const split = Buffer.concat(parts);
    const merged = Buffer.from(canonicalPng(split));
    expect(merged.toString("latin1").split("IDAT").length - 1).toBe(1);
    expect(merged.equals(png)).toBe(true);
  });

  it("returns a single data chunk file, a non PNG and a truncated file as they are", () => {
    const png = solid(10, 10);
    expect(canonicalPng(png)).toBe(png);
    const text = new Uint8Array(Buffer.from("not a png, just some bytes here"));
    expect(canonicalPng(text)).toBe(text);
    const cut = png.subarray(0, png.length - 20);
    expect(canonicalPng(cut)).toBe(cut);
  });
});

describe("pixel limit", () => {
  const header = (w: number, h: number): Buffer => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr.set([1, 0, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]);
  };

  it("reads the size from the header of each format without decoding", () => {
    expect(imageDimensions(header(16000, 9000))).toEqual({ width: 16000, height: 9000 });
    expect(imageDimensions(bmp(5, 3))).toEqual({ width: 5, height: 3 });
    expect(imageDimensions(jpeg(30, 20))).toEqual({ width: 30, height: 20 });
    expect(imageDimensions(Buffer.from("GIF89a\x07\x00\x09\x00\x00\x00\x00\x00\x00\x00", "latin1"))).toEqual({ width: 7, height: 9 });
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("refuses a picture of more than 40 million pixels before any decode, at the limit and one over", async () => {
    // 16000 x 16000 is a 31 KB file that decodes to 1 GB
    const bomb = await processImage(header(16000, 16000), "image/png", { worker: false });
    expect(bomb).toEqual({ ok: false, message: "[Image omitted: the picture holds more than 40 million pixels.]" });
    // a bomb saved under another declared type, which would have been decoded in this process
    expect(await processImage(header(16000, 16000), "image/bmp")).toMatchObject({ ok: false, message: expect.stringContaining("40 million pixels") });
    expect(await processImage(header(8000, 5001), "image/png", { worker: false })).toMatchObject({ message: expect.stringContaining("40 million pixels") });
    const atLimit = await processImage(header(8000, 5000), "image/png", { worker: false });
    expect(atLimit.ok === false && atLimit.message).not.toContain("40 million");
    expect(decodeOriented(photon, header(16000, 16000))).toBeNull();
  });
});
