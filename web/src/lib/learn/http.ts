// One request function for the learning routes of the Sources window and the Knowledge layer. It sends JSON, reads the
// envelope of the server on a failure and raises the same LearnApiError as the models client.
import { LearnApiError } from "./models";

export async function learnRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/learn/${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) throw new LearnApiError(res.status, parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
  return parsed as T;
}

/** The sentence to show for any failure. */
export function failureText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}
