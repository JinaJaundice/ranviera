// The plan map: a frozen snapshot in the transcript, and the popup that shows the live position. The layout is Cortex's own
// (planLayout.ts). A status is told apart by its stroke and a word, never by colour alone, and nothing glows.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Maximize, X, ZoomIn, ZoomOut } from "lucide-react";
import type { NodeStatus, PlanBlockDetails } from "@shared/learn/sessions";
import { IconButton } from "../../components/IconButton";
import { pushEscape } from "../../lib/learn/escape";
import { fitView, fitZoomFor, layoutPlan, zoomedView, type Layout, type View } from "./planLayout";

const LINE_HEIGHT = 13;

export function PlanSvg({ layout, statuses, label }: { layout: Layout; statuses?: Record<string, NodeStatus>; label: string }) {
  const marker = useId();
  return (
    <svg role="img" aria-label={label} width="100%" viewBox={`0 0 ${layout.width} ${layout.height}`} className="block overflow-visible" style={{ maxWidth: layout.width }}>
      <defs>
        <marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" className="fill-rule-strong" />
        </marker>
      </defs>
      {layout.edges.map((e) => (
        <path key={`${e.from}-${e.to}`} d={e.d} className="fill-none stroke-rule-strong" strokeWidth={1} markerEnd={`url(#${marker})`} />
      ))}
      {layout.nodes.map((n) => {
        const status = statuses?.[n.id];
        const x = n.cx - n.w / 2;
        const stroke = status === "current" ? "stroke-signal" : status === "visited" ? "stroke-ink" : status === "upcoming" ? "stroke-rule-strong" : "stroke-ink-soft";
        const fill = status === "upcoming" ? "fill-sunken" : "fill-surface";
        const first = n.y + n.h / 2 - ((n.lines.length - 1) * LINE_HEIGHT) / 2 + 4;
        return (
          <g key={n.id} data-node={n.id} data-status={status ?? "plain"}>
            <rect x={x} y={n.y} width={n.w} height={n.h} rx={4} className={`${fill} ${stroke}`} strokeWidth={status === "current" ? 2 : 1} strokeDasharray={status === "upcoming" ? "4 3" : undefined} />
            {n.lines.map((line, i) => (
              <text key={i} x={n.cx} y={first + i * LINE_HEIGHT} textAnchor="middle" className="fill-ink text-caption">
                {line}
              </text>
            ))}
            {status === "visited" ? (
              <path d={`M ${x + n.w - 14} ${n.y + 6} l 3 3 l 6 -6`} className="fill-none stroke-ink" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
            ) : null}
            {status === "current" ? (
              <text x={n.cx} y={n.y + n.h + 12} textAnchor="middle" className="fill-signal text-caption">
                Current
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** The snapshot in the transcript. It carries no status, and a press opens the popup. */
export function PlanBlock({ details, onOpen }: { details: PlanBlockDetails; onOpen: () => void }) {
  const layout = useMemo(() => layoutPlan(details.nodes, details.edges), [details]);
  return (
    <button type="button" onClick={onOpen} aria-label={`Open the plan with ${details.nodes.length} nodes`} className="my-1 block w-full min-w-0 rounded-lg border border-rule bg-surface p-3 text-left hover:border-rule-strong">
      <PlanSvg layout={layout} label={`Plan with ${details.nodes.length} nodes`} />
    </button>
  );
}

const KEY: { status: NodeStatus; word: string }[] = [
  { status: "visited", word: "Visited" },
  { status: "current", word: "Current" },
  { status: "upcoming", word: "Upcoming" },
];

function PlanKey({ className }: { className: string }) {
  return (
    <ul className={`items-center gap-3 text-small text-ink-soft ${className}`} aria-label="Key">
      {KEY.map((k) => (
        <li key={k.status} className="flex items-center gap-1.5">
          <svg width="14" height="10" aria-hidden="true">
            <rect x="1" y="1" width="12" height="8" rx="2" className={k.status === "current" ? "fill-surface stroke-signal" : k.status === "visited" ? "fill-surface stroke-ink" : "fill-sunken stroke-rule-strong"} strokeWidth={k.status === "current" ? 2 : 1} strokeDasharray={k.status === "upcoming" ? "3 2" : undefined} />
          </svg>
          {k.word}
        </li>
      ))}
    </ul>
  );
}

/** The popup covers the transcript area below the session row. Drag pans, the wheel zooms at the pointer and Escape closes it. */
export function PlanPopup({ nodes, edges, statuses, onClose }: { nodes: PlanBlockDetails["nodes"]; edges: PlanBlockDetails["edges"]; statuses: Record<string, NodeStatus>; onClose: () => void }) {
  const layout = useMemo(() => layoutPlan(nodes, edges), [nodes, edges]);
  const box = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);
  const [adjusted, setAdjusted] = useState(false);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const size = { w: layout.width, h: layout.height };
  const floor = fitZoomFor(size, vp);
  const shown = view ?? fitView(size, vp, floor);
  const ready = vp.w > 0;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setVp({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const off = pushEscape(() => {
      closeRef.current();
    });
    return () => {
      ro.disconnect();
      off();
    };
  }, []);

  // the wheel listener is not passive, so that the page behind does not scroll
  const zoomAt = (factor: number, focus: { x: number; y: number }) => {
    const next = zoomedView(view ?? fitView(size, vp, floor), factor, floor, focus, size, vp);
    setView(next);
    setAdjusted(next.k > floor + 1e-6);
  };
  const zoomRef = useRef(zoomAt);
  useEffect(() => {
    zoomRef.current = zoomAt;
  });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomRef.current(e.deltaY < 0 ? 1.15 : 1 / 1.15, { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const fit = () => {
    setView(null);
    setAdjusted(false);
  };
  const centre = { x: vp.w / 2, y: vp.h / 2 };

  return (
    <div role="dialog" aria-label="Plan" className="absolute inset-0 z-10 flex min-w-0 flex-col border-t border-rule-strong bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-rule px-3">
        <h3 className="text-ui font-medium text-ink">Plan</h3>
        <PlanKey className="hidden min-w-0 flex-1 @min-[480px]:flex" />
        <span className="flex-1 @min-[480px]:hidden" />
        <IconButton icon={ZoomIn} label="Zoom in" size={14} className="h-6 w-6" onClick={() => zoomAt(1.3, centre)} />
        <IconButton icon={ZoomOut} label="Zoom out" size={14} className="h-6 w-6" onClick={() => zoomAt(1 / 1.3, centre)} />
        <IconButton icon={Maximize} label="Fit the plan" size={14} className="h-6 w-6" onClick={fit} />
        <IconButton icon={X} label="Close the plan" size={14} className="h-6 w-6" onClick={onClose} />
      </div>
      <PlanKey className="flex h-8 shrink-0 items-center border-b border-rule px-3 @min-[480px]:hidden" />
      <div
        ref={box}
        className={`relative min-h-0 flex-1 touch-none overflow-hidden ${adjusted ? "cursor-grab" : "cursor-default"}`}
        onPointerDown={(e) => {
          if (!adjusted) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, vx: shown.x, vy: shown.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setView({ k: shown.k, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y });
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <div style={{ opacity: ready ? 1 : 0, transform: `translate(${shown.x}px, ${shown.y}px) scale(${shown.k})`, transformOrigin: "0 0", width: layout.width }}>
          <PlanSvg layout={layout} statuses={statuses} label="The plan with the position of the lesson" />
        </div>
      </div>
    </div>
  );
}
