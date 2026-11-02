// Page fetching for the researcher. web_fetch reads an address and returns Markdown with a source line. web_fetch_pdf
// downloads a PDF into the folder of the job. Both refuse any scheme other than http and https, and by default any
// loopback or private address, so that a page cannot steer the researcher at the local server or the home network.
// The tools never throw into the loop: every failure comes back as a sentence that the model can act on.
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export const FETCH_TIMEOUT_MS = 30_000;
export const FETCH_MAX_BYTES = 5 * 1024 * 1024;
export const FETCH_MAX_CHARS = 40_000;
export const FETCH_MIN_READABLE = 200;
export const PDF_FETCH_TIMEOUT_MS = 60_000;
export const PDF_FETCH_MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "Mozilla/5.0 (compatible; RanvieraResearcher/1.0; +https://github.com/JinaJaundice/ranviera)";

export interface FetchOptions {
  fetch?: typeof fetch;
  allowPrivateHosts?: boolean;
  /** the addresses of a host name, for the check that a public name does not point at a private address */
  resolveHost?: (host: string) => Promise<string[]>;
  signal?: AbortSignal;
}

const lookupAddresses = async (host: string): Promise<string[]> => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** The four bytes of an IPv4 address as a private-range test. */
function privateV4(a: number, b: number, c: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** The eight 16-bit groups of an IPv6 address, or null when the text is not one. A dotted IPv4 tail is accepted. */
function ipv6Groups(text: string): number[] | null {
  let h = text.split("%")[0];
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (dotted) {
    const o = dotted.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) return null;
    h = `${h.slice(0, dotted.index)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const side = (s: string): string[] => (s === "" ? [] : s.split(":"));
  const head = side(halves[0]);
  const tail = halves.length === 2 ? side(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

/** True for a host name or address that points at this machine or a private network. */
export function isPrivateHost(host: string): boolean {
  // URL.hostname keeps brackets on IPv6 and keeps a trailing dot on a name, so both are removed before any test
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (h === "" || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return privateV4(Number(v4[1]), Number(v4[2]), Number(v4[3]));
  if (h.includes(":")) {
    const g = ipv6Groups(h);
    // text that cannot be read as an address is refused, since it cannot be shown to be public
    if (!g) return true;
    const embedded = (hi: number, lo: number): boolean => privateV4(hi >> 8, hi & 255, lo >> 8);
    if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true;
    // IPv4 mapped (::ffff:a.b.c.d), IPv4 compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return embedded(g[6], g[7]);
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6], g[7]);
    if (g[0] === 0x2002) return embedded(g[1], g[2]);
    // unique local fc00::/7, link local fe80::/10, site local fec0::/10, multicast ff00::/8, Teredo and documentation ranges
    if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00) return true;
    if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0x0db8)) return true;
  }
  return false;
}

/** Parses an address and returns the refusal sentence when it may not be fetched. */
export function checkUrl(raw: string, allowPrivate: boolean): { url: URL } | { refusal: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { refusal: `"${raw.slice(0, 120)}" is not a valid address. Give a full address that starts with http:// or https://.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { refusal: `Only http and https addresses can be fetched, and this one uses ${url.protocol.replace(":", "")}.` };
  if (!allowPrivate && isPrivateHost(url.hostname)) return { refusal: "That address points at this machine or a private network, so it is not fetched." };
  return { url };
}

/** Refuses a host name that resolves to a private address. A literal address was already judged by its text. */
async function checkResolved(url: URL, options: FetchOptions): Promise<{ refusal: string } | null> {
  if (options.allowPrivateHosts === true) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.includes(":") || /^[\d.]+$/.test(host)) return null;
  let addresses: string[];
  try {
    addresses = await (options.resolveHost ?? lookupAddresses)(host.replace(/\.+$/, ""));
  } catch {
    return { refusal: "The address could not be fetched, because its host name did not resolve." };
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateHost(a))) return { refusal: "That host name points at this machine or a private network, so it is not fetched." };
  return null;
}

interface Got {
  res: Response;
  finalUrl: string;
}

/** Fetches with redirects followed by hand, so that every hop passes the host check. */
async function get(raw: string, timeoutMs: number, options: FetchOptions): Promise<Got | { refusal: string }> {
  const f = options.fetch ?? fetch;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = checkUrl(current, options.allowPrivateHosts === true);
    if ("refusal" in checked) return checked;
    // the name is resolved on the first request and on every redirect, since a redirect can name any host
    const unsafe = await checkResolved(checked.url, options);
    if (unsafe) return unsafe;
    const res = await f(checked.url, { redirect: "manual", signal, headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(String(res.headers.get("location")), checked.url).toString();
      await res.body?.cancel().catch(() => undefined);
      continue;
    }
    return { res, finalUrl: checked.url.toString() };
  }
  return { refusal: "The address redirected too many times." };
}

/** Reads a body up to a byte limit. */
async function readLimited(res: Response, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      truncated = true;
      chunks.push(value.subarray(0, value.length - (size - limit)));
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { bytes: new Uint8Array(Buffer.concat(chunks)), truncated };
}

const REFUSED_TYPES = /^(image|audio|video)\/|application\/(zip|octet-stream|gzip|x-tar|x-7z|vnd\.)/i;

function markdownOf(html: string, url: string): string {
  const { document } = parseHTML(html);
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  turndown.remove(["script", "style", "noscript"]);
  try {
    // Readability reads a document, and linkedom gives one that matches the parts it needs
    const article = new Readability(document as never, { charThreshold: 100 }).parse();
    const text = article?.content ? turndown.turndown(article.content).trim() : "";
    if (text.length >= FETCH_MIN_READABLE) return `${article?.title ? `# ${article.title}\n\n` : ""}${text}`;
  } catch {
    // the whole page below is the fallback
  }
  void url;
  const { document: whole } = parseHTML(html);
  const body = whole.body?.innerHTML ?? "";
  return turndown.turndown(body).trim();
}

/** The text of web_fetch for one address. */
export async function webFetch(raw: string, options: FetchOptions = {}): Promise<string> {
  try {
    const got = await get(raw, FETCH_TIMEOUT_MS, options);
    if ("refusal" in got) return got.refusal;
    const { res, finalUrl } = got;
    // an error page is not a source, so it never carries the source line that the tool uses to record sources
    if (res.status >= 400) {
      await res.body?.cancel().catch(() => undefined);
      return `${finalUrl} answered with HTTP ${res.status}, so nothing was read from it and it is not a source.`;
    }
    const source = `Source: ${finalUrl} (HTTP ${res.status})`;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > FETCH_MAX_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      return `${source}\nThe page declares ${declared} bytes, which is over the limit of 5 MiB, so it was not read.`;
    }
    if (type.includes("application/pdf") || /\.pdf($|\?)/i.test(finalUrl)) {
      await res.body?.cancel().catch(() => undefined);
      return `${source}\nThis address is a PDF. Use web_fetch_pdf with the same address, then read it with pdf_info, pdf_extract and pdf_search.`;
    }
    if (REFUSED_TYPES.test(type)) {
      await res.body?.cancel().catch(() => undefined);
      return `${source}\nThe content type ${type.split(";")[0]} is not text, so it was not read.`;
    }
    const { bytes, truncated } = await readLimited(res, FETCH_MAX_BYTES);
    const raw8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    let body: string;
    if (type.includes("html") || type.includes("xml") || /^\s*<(!doctype|html)/i.test(raw8)) {
      body = markdownOf(raw8, finalUrl);
      if (body.length < FETCH_MIN_READABLE) {
        return `${source}\nNo readable text of at least ${FETCH_MIN_READABLE} characters could be taken from this page. It may need a browser to build its content. Try another source.`;
      }
    } else body = raw8.trim();
    const note = truncated ? "\n\n[The page is larger than 5 MiB and was read only in part.]" : "";
    const over = body.length > FETCH_MAX_CHARS ? `\n\n[Output cut at ${FETCH_MAX_CHARS.toLocaleString("en-GB")} characters.]` : "";
    return `${source}\n\n${body.slice(0, FETCH_MAX_CHARS)}${over}${note}`;
  } catch (e) {
    return fetchFailure(e);
  }
}

function fetchFailure(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError") return "The address did not answer in time.";
  if (name === "AbortError") return "The fetch was stopped.";
  return `The address could not be fetched${e instanceof Error && e.message ? `: ${e.message}` : "."}`;
}

export type PdfDownload = { ok: true; file: string; bytes: number } | { ok: false; message: string };

/** Downloads a PDF into a folder. The file is checked by its first bytes and removed when it is not a PDF. */
export async function downloadPdf(raw: string, dir: string, options: FetchOptions = {}): Promise<PdfDownload> {
  try {
    const got = await get(raw, PDF_FETCH_TIMEOUT_MS, options);
    if ("refusal" in got) return { ok: false, message: got.refusal };
    const { res, finalUrl } = got;
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, message: `${finalUrl} answered with HTTP ${res.status}, so nothing was downloaded.` };
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > PDF_FETCH_MAX_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, message: "The PDF is larger than 25 MiB, so it was not downloaded." };
    }
    const { bytes, truncated } = await readLimited(res, PDF_FETCH_MAX_BYTES);
    if (truncated) return { ok: false, message: "The PDF is larger than 25 MiB, so it was not downloaded." };
    if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") {
      return { ok: false, message: "The address did not return a PDF. Use web_fetch if it is a web page." };
    }
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `download-${fs.readdirSync(dir).length + 1}.pdf`);
    fs.writeFileSync(file, bytes);
    return { ok: true, file, bytes: bytes.length };
  } catch (e) {
    return { ok: false, message: fetchFailure(e) };
  }
}
