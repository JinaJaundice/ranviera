// Canonical PNG. A renderer may split the compressed pixel stream over many data chunks, and one provider decoder
// rejected such files. This merges the chunks into one, rewrites the chunk checks and leaves the stream itself
// untouched. Input that is not a PNG, is truncated or holds fewer than two data chunks is returned as it is.
import { crc32 } from "node:zlib";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Chunk {
  kind: string;
  body: Buffer;
}

function chunkBytes(kind: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(kind, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

export function canonicalPng(input: Uint8Array): Uint8Array {
  if (input.length < 20 || !SIGNATURE.every((v, i) => input[i] === v)) return input;
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const chunks: Chunk[] = [];
  let at = 8;
  let ended = false;
  while (at + 12 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const kind = buf.toString("latin1", at + 4, at + 8);
    if (at + 12 + length > buf.length) return input;
    chunks.push({ kind, body: buf.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
    if (kind === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || chunks.filter((c) => c.kind === "IDAT").length < 2) return input;
  const merged = Buffer.concat(chunks.filter((c) => c.kind === "IDAT").map((c) => c.body));
  const parts: Buffer[] = [Buffer.from(SIGNATURE)];
  let placed = false;
  for (const c of chunks) {
    if (c.kind !== "IDAT") parts.push(chunkBytes(c.kind, c.body));
    else if (!placed) {
      parts.push(chunkBytes("IDAT", merged));
      placed = true;
    }
  }
  return new Uint8Array(Buffer.concat(parts));
}
