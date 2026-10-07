// Typed calls to the Cortex server. The routes are fixed in docs/CONTRACTS.md.
import type {
  Activation,
  InferredFact,
  InferredRule,
  SavedQuery,
  SparqlResult,
  RegisterDay,
  CortexEvent,
  ClaudeState,
  HooksState,
  SetupState,
  GraphEdge,
  GraphFile,
  GraphNode,
  HealthFile,
  LexiconHit,
  LexiconScheme,
  Mission,
  Plan,
  ServerStatus,
  Sensitivity,
} from "@shared/types";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((body: { error?: string }) => body.error ?? "")
      .catch(() => res.statusText);
    // the server writes its errors as plain sentences, so the status code is shown only when there is no sentence
    throw new Error(detail || `The server answered with status ${res.status}.`);
  }
  return (await res.json()) as T;
}

export interface NodeDetail {
  node: GraphNode;
  out: GraphEdge[];
  in: GraphEdge[];
  neighbours: GraphNode[];
  events: CortexEvent[];
}

export const api = {
  graph: (max: Sensitivity = "client-confidential") => call<GraphFile>(`/api/graph?max=${max}`),
  node: (id: string) => call<NodeDetail>(`/api/node/${encodeURIComponent(id)}`),
  health: () => call<HealthFile>("/api/health"),
  lexicon: () => call<{ schemes: LexiconScheme[] }>("/api/lexicon"),
  lexiconCheck: (text: string) =>
    call<{ hits: LexiconHit[] }>("/api/lexicon/check", { method: "POST", body: JSON.stringify({ text }) }),
  ratify: (concept: string) =>
    call<{ ok: true }>("/api/lexicon/ratify", { method: "POST", body: JSON.stringify({ concept }) }),
  activity: (since?: string) =>
    call<{ events: CortexEvent[] }>(`/api/activity${since ? `?since=${encodeURIComponent(since)}` : ""}`),
  /** past events with the spread computed, for the replay in the Graph window */
  replay: (since: string, until?: string) =>
    call<{ items: { event: CortexEvent; activation: Activation[] }[] }>(
      `/api/activity?with_activation=1&since=${encodeURIComponent(since)}${until ? `&until=${encodeURIComponent(until)}` : ""}`,
    ),
  register: (days = 30) => call<{ days: RegisterDay[] }>(`/api/register?days=${days}`),
  status: () => call<ServerStatus>("/api/status"),
  compile: () => call<{ ok: boolean; stats: GraphFile["stats"]; health: GraphFile["health"] }>("/api/compile", { method: "POST" }),
  plan: (prompt: string) => call<Plan>("/api/plan", { method: "POST", body: JSON.stringify({ prompt }) }),
  missions: () => call<{ missions: Mission[] }>("/api/missions"),
  mission: (id: string) => call<Mission>(`/api/missions/${encodeURIComponent(id)}`),
  startMission: (prompt: string, plan?: Plan) =>
    call<{ id: string }>("/api/missions", { method: "POST", body: JSON.stringify({ prompt, plan }) }),
  stopMission: (id: string) =>
    call<{ ok: true }>(`/api/missions/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  sparql: (query: string) => call<SparqlResult>("/api/sparql", { method: "POST", body: JSON.stringify({ query }) }),
  queries: () => call<{ queries: SavedQuery[] }>("/api/queries"),
  inferred: (node?: string, kind?: string) =>
    call<{ rules: InferredRule[]; facts: InferredFact[] }>(
      `/api/inferred?${new URLSearchParams({ ...(node ? { node } : {}), ...(kind ? { kind } : {}) }).toString()}`,
    ),
  open: (path: string) => call<{ ok: true }>("/api/open", { method: "POST", body: JSON.stringify({ path }) }),
  // The public product (docs/CONTRACTS.md, 6 October 2026)
  setup: () => call<SetupState>("/api/setup"),
  acceptSetup: () => call<SetupState>("/api/setup/accept", { method: "POST", body: "{}" }),
  readSetup: (projects_root: string | null) =>
    call<SetupState>("/api/setup/read", { method: "POST", body: JSON.stringify({ projects_root }) }),
  missionsConsent: () => call<SetupState>("/api/setup/missions-consent", { method: "POST", body: "{}" }),
  hooks: () => call<HooksState>("/api/hooks"),
  installHooks: () => call<{ installed: true; backup: string }>("/api/hooks/install", { method: "POST", body: "{}" }),
  uninstallHooks: () =>
    call<{ installed: false; removed: number; backup: string }>("/api/hooks/uninstall", { method: "POST", body: "{}" }),
  claude: () => call<ClaudeState>("/api/claude"),
  claudeLogin: () =>
    call<{ started: boolean; terminal: string; message: string }>("/api/claude/login", { method: "POST", body: "{}" }),
};
