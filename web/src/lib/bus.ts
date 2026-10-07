// A small typed event bus. The graph canvas listens here directly, so a firing does not re-render React.
import type { Activation, CortexEvent, MissionLine, MissionState } from "@shared/types";
import type { RegionId } from "@shared/brain";
import type { TrailStep } from "../graph/brain/types";

export interface BusEvents {
  /** a real event from the server, with the spread already computed */
  fire: { event: CortexEvent; activation: Activation[] };
  /** a preview from a window, eg the nodes a plan will fire; not recorded anywhere */
  preview: { activation: Activation[]; label: string };
  /** highlight these nodes until cleared with an empty list */
  highlight: { ids: string[] };
  /** move the camera to a node and select it */
  focus: { id: string };
  /** a node was selected in any window */
  select: { id: string | null };
  /** open a window by its app id */
  open: { app: string; params?: Record<string, string> };
  mission: { id: string; state: MissionState; step?: number; line?: MissionLine };
  graph: { built: string };
  /** the thought trail played a step, observed or predicted (docs/BRAIN.md) */
  step: { step: TrailStep };
  /** a region caption was clicked on the canvas, so the Graph window lists its hottest nodes */
  region: { id: RegionId };
}

type Handler<T> = (payload: T) => void;

class Bus {
  private handlers = new Map<keyof BusEvents, Set<Handler<unknown>>>();

  on<K extends keyof BusEvents>(type: K, fn: Handler<BusEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn as Handler<unknown>);
    return () => set!.delete(fn as Handler<unknown>);
  }

  emit<K extends keyof BusEvents>(type: K, payload: BusEvents[K]): void {
    this.handlers.get(type)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error(`bus handler for ${String(type)} failed`, err);
      }
    });
  }
}

export const bus = new Bus();
