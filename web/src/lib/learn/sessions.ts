// Typed calls to routes 16 to 29 of docs/CONTRACTS.md ("Routes") for the Learn window, and the small pure helpers that
// the session list uses. The per turn stream and the input post are driven by the session model in
// web/src/apps/learn/model.ts, which takes an injected fetch, so this file only builds their addresses.
import type { ActivityItem, CreateSession, SessionDetail, SessionRecord, SessionSummary, ThinkingLevel } from "@shared/learn/sessions";
import type { ModelRef } from "@shared/learn/models";
import { learnRequest } from "./http";

export type DeletionMode = "preserve-graph" | "delete-nodes";

const enc = encodeURIComponent;

export const sessionPath = {
  detail: (id: string) => `/api/learn/sessions/${enc(id)}`,
  input: (id: string) => `/api/learn/sessions/${enc(id)}/input`,
  stream: (id: string) => `/api/learn/sessions/${enc(id)}/stream`,
  steer: (id: string) => `/api/learn/sessions/${enc(id)}/steer`,
  dismiss: (id: string) => `/api/learn/sessions/${enc(id)}/dismiss`,
  markdown: (id: string) => `/api/learn/sessions/${enc(id)}/markdown`,
  jobs: (id: string) => `/api/learn/jobs?sessionId=${enc(id)}`,
  abort: "/api/learn/activity/abort",
};

export const learnSessions = {
  list: async () => (await learnRequest<{ sessions: SessionSummary[] }>("GET", "sessions")).sessions,
  create: async (body: CreateSession) => (await learnRequest<{ session: SessionRecord }>("POST", "sessions", body)).session,
  detail: (id: string) => learnRequest<SessionDetail>("GET", `sessions/${enc(id)}`),
  rename: (id: string, title: string) => learnRequest<unknown>("PUT", `sessions/${enc(id)}`, { title }),
  remove: (id: string, mode: DeletionMode) => learnRequest<unknown>("DELETE", `sessions/${enc(id)}?mode=${mode}`),
  settings: (id: string, body: { model?: ModelRef; thinkingLevel?: ThinkingLevel }) => learnRequest<unknown>("PUT", `sessions/${enc(id)}/settings`, body),
  activity: async () => (await learnRequest<{ items: ActivityItem[] }>("GET", "activity")).items,
  abort: (id: string) => learnRequest<unknown>("POST", "activity/abort", { kind: "turn", id }),
  extract: (sessionId: string) => learnRequest<unknown>("POST", "graph/extract", { sessionId }),
};

/** The age of a session as a phrase: minutes, hours and days, then a date. A clock that runs ahead reads as just now. */
export function relativeAge(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Not dated";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "Just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? "1 minute ago" : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : `${h} hours ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return d === 1 ? "1 day ago" : `${d} days ago`;
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** The second line of a sidebar row. A state that needs the reader outranks the age, and compaction outranks a waiting question. */
export function sessionMeta(s: Pick<SessionSummary, "busy" | "compacting" | "pendingQuestion" | "kind" | "updatedAt">, now: number, problemWaiting = false): string {
  if (s.compacting) return "Compacting context";
  if (s.busy) return "Working";
  if (s.pendingQuestion) return s.kind === "practice" ? "Problem waiting" : "Waiting for your answer";
  if (problemWaiting) return "Problem waiting";
  return relativeAge(s.updatedAt, now);
}

export type KindFilter = "teach" | "all" | "practice";

export function filterByKind(list: SessionSummary[], kind: KindFilter): SessionSummary[] {
  return kind === "all" ? list : list.filter((s) => s.kind === kind);
}
