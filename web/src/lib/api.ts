// Typed calls to the Cortex server. The routes are fixed in docs/CONTRACTS.md.
import type {
  Activation,
  DecisionTrace,
  CoverageMatrix,
  InferredFact,
  InstructionDetail,
  InstructionSummary,
  MappingRecord,
  MonitoringReport,
  OversightStatus,
  PackResult,
  RunSummary,
  SampleRecord,
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

/** The person that the demonstration selector chose. Only a server in demonstration mode reads the header that carries it. */
let actingAs: string | null = null;
export function setActingAs(id: string | null): void {
  actingAs = id;
}

const oversight = <T>(path: string, init?: RequestInit) =>
  call<T>(`/api/oversight${path}`, { ...init, headers: actingAs ? { "x-ranviera-actor": actingAs } : undefined });
const send = <T>(path: string, body: unknown) => oversight<T>(path, { method: "POST", body: JSON.stringify(body) });
const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => Boolean(e[1])));
  return p.size ? `?${p.toString()}` : "";
};
const enc = encodeURIComponent;

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
  // The oversight views (docs/CONTRACTS.md, "Oversight routes")
  oversightStatus: () => oversight<OversightStatus>("/status"),
  oversightRuns: () => oversight<RunSummary[]>("/runs"),
  oversightTrace: (run: string) => oversight<DecisionTrace>(`/trace/${enc(run)}`),
  oversightCoverage: (agent?: string) => oversight<CoverageMatrix>(`/coverage${qs({ agent })}`),
  oversightMappings: (f: { status?: string; owner?: string; stale?: boolean } = {}) =>
    oversight<MappingRecord[]>(`/mappings${qs({ status: f.status, owner: f.owner, stale: f.stale ? "1" : undefined })}`),
  ratifyMapping: (id: string, note?: string) => send<MappingRecord>(`/mappings/${enc(id)}/ratify`, { note }),
  rejectMapping: (id: string, reason: string) => send<MappingRecord>(`/mappings/${enc(id)}/reject`, { reason }),
  reassignMapping: (id: string, owner: string) => send<MappingRecord>(`/mappings/${enc(id)}/reassign`, { owner }),
  oversightInstructions: () => oversight<InstructionSummary[]>("/instructions"),
  oversightInstruction: (id: string) => oversight<InstructionDetail>(`/instructions/${enc(id)}`),
  draftInstruction: (id: string, text: string) => send<InstructionDetail>(`/instructions/${enc(id)}/draft`, { text }),
  approveVersion: (id: string) => send<InstructionDetail>(`/versions/${enc(id)}/approve`, {}),
  oversightMonitoring: () => oversight<MonitoringReport>("/monitoring"),
  drawSample: (agent: string, size: number, seed?: number, risk_weighted?: boolean) =>
    send<SampleRecord>("/samples", { agent, size, seed, risk_weighted }),
  sampleVerdict: (sample: string, run: string, verdict: "agree" | "disagree", reason?: string) =>
    send<SampleRecord>(`/samples/${enc(sample)}/verdict`, { run, verdict, reason }),
  exportPack: (scope: string) => send<PackResult>("/pack", { scope }),
  packFile: (folder: string, file: "pack.html" | "pack.json" | "manifest.json") =>
    oversight<{ file: string; text: string }>(`/pack-file${qs({ folder, file })}`),
  claudeLogin: () =>
    call<{ started: boolean; terminal: string; message: string }>("/api/claude/login", { method: "POST", body: "{}" }),
};
