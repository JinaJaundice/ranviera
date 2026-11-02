// Web search for the researcher, through a Tavily or a Brave key from the keys store. The engine resolves on each
// call: no key means no search and no default, one key is enough, both keys prefer Tavily, and a pin wins when its
// key is present. A pin whose key is missing never falls back to the other engine. Every failure is a string.
import { BRAVE_KEY_NAME, TAVILY_KEY_NAME } from "../../models/keys.ts";
import type { JobKeys } from "../types.ts";

export type SearchPin = "tavily" | "brave";

export interface SearchProvider {
  engine: SearchPin;
  key: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export const SEARCH_DEFAULT_COUNT = 5;
export const SEARCH_MAX_COUNT = 10;
export const SEARCH_MAX_RESULTS = 20;
export const SNIPPET_LIMIT = 500;
export const SEARCH_TIMEOUT_MS = 30_000;

export const TAVILY_ENDPOINT = "https://api.tavily.com/search";
export const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export const NO_SEARCH_TEXT =
  "Web search is not available, because no Tavily or Brave key is saved. Say so in the brief, and use web_fetch on any address the question supplies.";

/** The provider for this call, or null when the person has saved no usable key. */
export function resolveSearchProvider(keys: JobKeys, pin?: SearchPin): SearchProvider | null {
  const tavily = keys.effective(TAVILY_KEY_NAME)?.value;
  const brave = keys.effective(BRAVE_KEY_NAME)?.value;
  if (pin === "tavily") return tavily ? { engine: "tavily", key: tavily } : null;
  if (pin === "brave") return brave ? { engine: "brave", key: brave } : null;
  if (tavily) return { engine: "tavily", key: tavily };
  if (brave) return { engine: "brave", key: brave };
  return null;
}

const cut = (s: unknown, n: number): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

export interface SearchOptions {
  fetch?: typeof fetch;
  endpoints?: { tavily?: string; brave?: string };
  signal?: AbortSignal;
}

/** Runs one search. Throws an Error whose message is meant for the model. */
export async function searchWeb(provider: SearchProvider, query: string, count: number, options: SearchOptions = {}): Promise<SearchHit[]> {
  const f = options.fetch ?? fetch;
  const n = Math.max(1, Math.min(SEARCH_MAX_COUNT, Math.floor(count)));
  const signals = [AbortSignal.timeout(SEARCH_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])];
  const signal = AbortSignal.any(signals);
  if (provider.engine === "tavily") {
    const res = await f(options.endpoints?.tavily ?? TAVILY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${provider.key}` },
      body: JSON.stringify({ query, max_results: n }),
      signal,
    });
    const body = (await res.json().catch(() => null)) as { results?: { title?: string; url?: string; content?: string }[]; detail?: unknown; error?: unknown } | null;
    if (!res.ok) {
      const detail = typeof body?.error === "string" ? body.error : typeof (body?.detail as { error?: unknown } | undefined)?.error === "string" ? String((body?.detail as { error: string }).error) : "";
      throw new Error(`Tavily answered with status ${res.status}${detail ? `: ${cut(detail, 200)}` : ""}.`);
    }
    return (body?.results ?? [])
      .filter((r) => typeof r.url === "string")
      .slice(0, SEARCH_MAX_RESULTS)
      .map((r) => ({ title: cut(r.title, 200) || String(r.url), url: String(r.url), snippet: cut(r.content, SNIPPET_LIMIT) }));
  }
  const url = new URL(options.endpoints?.brave ?? BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(n));
  const res = await f(url, { headers: { accept: "application/json", "x-subscription-token": provider.key }, signal });
  const body = (await res.json().catch(() => null)) as { web?: { results?: { title?: string; url?: string; description?: string }[] } } | null;
  if (!res.ok) throw new Error(`Brave answered with status ${res.status}.`);
  return (body?.web?.results ?? [])
    .filter((r) => typeof r.url === "string")
    .slice(0, SEARCH_MAX_RESULTS)
    .map((r) => ({ title: cut(r.title, 200) || String(r.url), url: String(r.url), snippet: cut(r.description, SNIPPET_LIMIT) }));
}

/** The results as text for the model. */
export function formatHits(query: string, hits: SearchHit[]): string {
  if (!hits.length) return `The search for "${query}" returned no results. Try other words.`;
  return hits.map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`).join("\n\n");
}
