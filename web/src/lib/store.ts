// The app's shared state, read with useStore(selector). Fast-changing activation is not kept here: the graph
// canvas takes it from the bus. The store connects to the server stream once, from main.tsx.
import { setBrainDomains } from "../graph/brain/trail";
import { useSyncExternalStore } from "react";
import type {
  CortexEvent,
  Family,
  Sensitivity,
  GraphFile,
  GraphNode,
  HealthFile,
  Mission,
  ServerStatus,
  StreamMessage,
} from "@shared/types";
import type { RegionId } from "@shared/brain";
import { api } from "./api";
import { bus } from "./bus";

/** How the background graph is drawn. The Graph window edits this; the canvas reads it. */
export interface GraphView {
  families: Record<Family, boolean>;
  cap: Sensitivity;
  sizeBy: "heat" | "degree";
  labels: boolean;
  ambient: boolean; // slow rotation when nothing is selected
  showProposed: boolean; // draw the links that nobody has reviewed yet (provenance "proposed")
  layout: "brain" | "network"; // the brain scene of docs/BRAIN.md, or the force layout
  hiddenRegions: RegionId[]; // the brain regions switched off in the legend
  surface: number; // the opacity of the brain silhouette, from 0 (hidden) to 1 (solid); 0.25 by default
  expand: number; // how far the regions move outwards from the centre of the brain, from 0 (together) to 1 (apart); 0 by default
  captions: boolean; // the captions of the regions and the labels of the clusters; on by default
}

export interface CortexState {
  graphView: GraphView;
  graph: GraphFile | null;
  byId: Map<string, GraphNode>;
  graphError: string | null;
  events: CortexEvent[]; // newest first, at most 500
  missions: Mission[];
  status: ServerStatus | null;
  health: HealthFile | null;
  connected: boolean;
  selected: string | null;
}

let state: CortexState = {
  graphView: {
    families: { instruction: true, machinery: true, record: true, work: true, world: true, language: true },
    cap: "client-confidential",
    sizeBy: "heat",
    labels: false,
    ambient: true,
    showProposed: false,
    layout: "brain",
    hiddenRegions: [],
    surface: 0.25,
    expand: 0,
    captions: true,
  },
  graph: null,
  byId: new Map(),
  graphError: null,
  events: [],
  missions: [],
  status: null,
  health: null,
  connected: false,
  selected: null,
};

const listeners = new Set<() => void>();

export function getState(): CortexState {
  return state;
}

export function setState(patch: Partial<CortexState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: CortexState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

export async function loadGraph(): Promise<void> {
  try {
    const graph = await api.graph();
    setState({ graph, byId: new Map(graph.nodes.map((n) => [n.id, n])), graphError: null });
  } catch (err) {
    setState({ graphError: err instanceof Error ? err.message : String(err) });
  }
}

export async function loadSideData(): Promise<void> {
  const [status, health, missions, activity] = await Promise.allSettled([
    api.status(),
    api.health(),
    api.missions(),
    api.activity(),
  ]);
  if (status.status === "fulfilled") setBrainDomains(status.value.brain_domains);
  setState({
    status: status.status === "fulfilled" ? status.value : state.status,
    health: health.status === "fulfilled" ? health.value : state.health,
    missions: missions.status === "fulfilled" ? missions.value.missions : state.missions,
    events: activity.status === "fulfilled" ? [...activity.value.events].reverse().slice(0, 500) : state.events,
  });
}

export function setGraphView(patch: Partial<GraphView>): void {
  setState({ graphView: { ...state.graphView, ...patch } });
}

export function selectNode(id: string | null): void {
  setState({ selected: id });
  bus.emit("select", { id });
}

let source: EventSource | null = null;

/** Connect to the server stream. Reconnection is handled by EventSource itself. */
export function connectStream(): void {
  if (source) return;
  source = new EventSource("/api/stream");
  source.onopen = () => setState({ connected: true });
  source.onerror = () => setState({ connected: false });
  const handle = (raw: MessageEvent<string>) => {
    let msg: StreamMessage;
    try {
      msg = JSON.parse(raw.data) as StreamMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello":
        setState({ connected: true });
        break;
      case "fire":
        setState({ events: [msg.event, ...state.events].slice(0, 500) });
        bus.emit("fire", { event: msg.event, activation: msg.activation });
        break;
      case "graph":
        bus.emit("graph", { built: msg.built });
        void loadGraph();
        void loadSideData();
        break;
      case "mission":
        bus.emit("mission", { id: msg.id, state: msg.state, step: msg.step, line: msg.line });
        void api.missions().then((r) => setState({ missions: r.missions })).catch(() => undefined);
        break;
      case "heartbeat":
        break;
    }
  };
  for (const type of ["hello", "fire", "graph", "mission", "heartbeat"]) {
    source.addEventListener(type, handle as EventListener);
  }
  source.onmessage = handle;
}
