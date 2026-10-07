// The live graph canvas. It is the background of the whole app, so it renders a full-size div and keeps one
// engine for as long as it is mounted: the brain scene (the default) or the force layout (the Network layout).
import { useEffect, useRef } from "react";
import type { RegionId } from "@shared/brain";
import { bus } from "../lib/bus";
import { selectNode, useStore } from "../lib/store";
import { GraphEngine } from "./engine";
import { BrainEngine } from "./brain/BrainEngine";
import type { BrainCommand, BrainView, CanvasEngine, TrailStep } from "./brain/types";
import { BrainControls } from "./BrainControls";
import { ThoughtTrail } from "./ThoughtTrail";

export function NeuralGraph({ className }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<CanvasEngine | null>(null);
  const brain = useRef<BrainEngine | null>(null);
  const graph = useStore((s) => s.graph);
  const view = useStore((s) => s.graphView);
  const selected = useStore((s) => s.selected);
  const layout = view.layout;

  // Create the instance, and dispose of it, its materials and its listeners when the layout changes or on unmount.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const eng: CanvasEngine =
      layout === "brain"
        ? new BrainEngine(el, {
            onSelect: selectNode,
            onRegion: (id: RegionId) => {
              window.dispatchEvent(new CustomEvent("cortex:region", { detail: { id } }));
              bus.emit("region", { id });
            },
          })
        : new GraphEngine(el, { onSelect: selectNode });
    engine.current = eng;
    brain.current = eng instanceof BrainEngine ? eng : null;
    // The smoke test reaches the engine through this handle, which exists only in a development build.
    if (import.meta.env.DEV && new URLSearchParams(location.search).has("smoke")) (window as unknown as { __cortexGraph?: CanvasEngine }).__cortexGraph = eng;

    const offs = [
      // In the brain layout the thought trail plays each step through cortex:play-step, so it is not drawn twice here.
      bus.on("fire", (p) => {
        if (!(eng instanceof BrainEngine)) eng.fire(p.activation, false);
      }),
      bus.on("preview", (p) => eng.fire(p.activation, true)),
      bus.on("highlight", (p) => eng.setHighlight(p.ids)),
      bus.on("focus", (p) => eng.focus(p.id)),
    ];
    // A window can play a step of the thought trail, or turn to a region, through these two window events.
    const onStep = (ev: Event) => brain.current?.playStep((ev as CustomEvent<TrailStep>).detail);
    const onRegion = (ev: Event) => brain.current?.focusRegion((ev as CustomEvent<{ id: RegionId }>).detail.id);
    window.addEventListener("cortex:play-step", onStep);
    window.addEventListener("cortex:focus-region", onRegion);
    // The thought trail tells the scene how much of the left edge it covers.
    const onInset = (ev: Event) => brain.current?.setLeftInset((ev as CustomEvent<{ px: number }>).detail.px);
    window.addEventListener("cortex:view-inset", onInset);
    // the control group sends its zoom, reset and preset commands through this window event
    const onCommand = (ev: Event) => brain.current?.command((ev as CustomEvent<{ cmd: BrainCommand }>).detail.cmd);
    window.addEventListener("cortex:brain-command", onCommand);
    const theme = new MutationObserver(() => eng.refreshTheme());
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      offs.forEach((off) => off());
      window.removeEventListener("cortex:play-step", onStep);
      window.removeEventListener("cortex:focus-region", onRegion);
      window.removeEventListener("cortex:view-inset", onInset);
      window.removeEventListener("cortex:brain-command", onCommand);
      theme.disconnect();
      eng.dispose();
      engine.current = null;
      brain.current = null;
    };
  }, [layout]);

  // A reload of the graph arrives through the store, so the "graph" bus message needs no handler of its own.
  useEffect(() => {
    if (graph) engine.current?.setData(graph, view as BrainView);
  }, [graph, view, layout]);

  useEffect(() => {
    engine.current?.setSizeBy(view.sizeBy);
    engine.current?.setAmbient(view.ambient);
    engine.current?.setMoreLabels(view.labels);
    brain.current?.setSurface(view.surface);
    brain.current?.setExpand(view.expand);
    brain.current?.setCaptions(view.captions);
  }, [view.sizeBy, view.ambient, view.labels, view.surface, view.expand, view.captions, layout]);

  useEffect(() => {
    engine.current?.setSelected(selected);
  }, [selected, layout]);

  return (
    <>
      <div ref={host} className={className ?? "h-full w-full"} />
      {layout === "brain" ? <ThoughtTrail /> : null}
      {layout === "brain" ? <BrainControls /> : null}
    </>
  );
}
