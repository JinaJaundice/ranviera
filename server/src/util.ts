// Small helpers shared by the server modules.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolves a path and writes it with forward slashes, as the graph does. */
export function norm(p: string): string {
  return path.resolve(expandHome(p)).replace(/\\/g, "/");
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function sha(text: string, length = 16): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

export function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The months from the start to the end of a window, as YYYY-MM keys. */
export function monthsBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  const endY = to.getUTCFullYear();
  const endM = to.getUTCMonth();
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

/** A set that forgets its oldest entry once it holds max keys. */
export class Lru {
  private map = new Map<string, true>();
  private max: number;
  constructor(max: number) {
    this.max = max;
  }
  /** Returns true when the key was already present. */
  seen(key: string): boolean {
    if (this.map.has(key)) {
      this.map.delete(key);
      this.map.set(key, true);
      return true;
    }
    this.map.set(key, true);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return false;
  }
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `localhost:${port}` || h === `127.0.0.1:${port}`;
}

/** A missing Origin is allowed. A present Origin must name the host that was asked. */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!host) return false;
  return origin.toLowerCase() === `http://${host.toLowerCase()}`;
}

export function isUnder(file: string, root: string): boolean {
  const f = path.resolve(file).replace(/\\/g, "/");
  const r = path.resolve(root).replace(/\\/g, "/").replace(/\/+$/, "");
  const fl = process.platform === "win32" ? f.toLowerCase() : f;
  const rl = process.platform === "win32" ? r.toLowerCase() : r;
  return fl === rl || fl.startsWith(rl + "/");
}

export function readBody(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > max) {
        failed = true;
        reject(new HttpError(413, "The request body is larger than 1 MB."));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => {
      if (!failed) reject(e);
    });
  });
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // falls through to the error below
  }
  throw new HttpError(400, "The request body must be a JSON object.");
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
