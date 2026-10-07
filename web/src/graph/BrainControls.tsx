// The control bar of the brain view (docs/BRAIN.md, "Visibility and navigation"): a compact vertical bar of icons for zoom in,
// zoom out, reset, the four preset views (a small segmented control), auto-rotate, labels and settings. The Surface and Expand
// sliders open in a popover from the settings icon. The bar stands in the corner of the canvas that no window covers, clear of
// the thought trail, and every control has a tooltip and can be reached from the keyboard. The commands go to the engine
// through the window event cortex:brain-command, and the sliders and switches through the store.
import { useEffect, useRef, useState } from "react";
import { Eye, Layers, RotateCcw, SlidersHorizontal, Tags, Orbit, ZoomIn, ZoomOut } from "lucide-react";
import { setGraphView, useStore } from "../lib/store";
import type { BrainCommand } from "./brain/types";

const send = (cmd: BrainCommand) => window.dispatchEvent(new CustomEvent("cortex:brain-command", { detail: { cmd } }));

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal";
const ICON = `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-rule-strong bg-sunken text-ink-soft hover:bg-raised hover:text-ink ${FOCUS}`;
const SEGMENT = `h-6 min-w-0 flex-1 border border-rule-strong bg-sunken text-caption font-medium text-ink-soft hover:bg-raised hover:text-ink ${FOCUS}`;

const PRESETS: { cmd: BrainCommand; label: string; letter: string; key: string }[] = [
  { cmd: "view-left", label: "Left", letter: "L", key: "1" },
  { cmd: "view-right", label: "Right", letter: "R", key: "2" },
  { cmd: "view-top", label: "Top", letter: "T", key: "3" },
  { cmd: "view-front", label: "Front", letter: "F", key: "4" },
];

function IconButton({ icon: Icon, label, tip, onClick }: { icon: typeof Orbit; label: string; tip: string; onClick: () => void }) {
  return (
    <button type="button" className={ICON} aria-label={label} title={tip} onClick={onClick}>
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}

function Toggle({ icon: Icon, label, on, onChange }: { icon: typeof Orbit; label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={`${label}: ${on ? "on" : "off"}`}
      onClick={() => onChange(!on)}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${FOCUS} ${
        on ? "border-signal bg-raised text-ink" : "border-rule-strong bg-sunken text-ink-soft hover:bg-raised hover:text-ink"
      }`}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}

function Slider({ icon: Icon, label, value, onChange }: { icon: typeof Eye; label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-small text-ink-soft">
      <Icon size={14} aria-hidden="true" className="shrink-0" />
      <span className="w-14 shrink-0 text-ink">{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        aria-label={label}
        aria-valuetext={`${Math.round(value * 100)} per cent`}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-4 min-w-0 flex-1 accent-signal"
      />
      <span className="num w-8 shrink-0 text-right text-ink-soft">{Math.round(value * 100)}</span>
    </label>
  );
}

type Corner = "br" | "bl" | "tr" | "tl";
const CORNERS: Corner[] = ["br", "bl", "tr", "tl"];
const CORNER_CLASS: Record<Corner, string> = {
  br: "bottom-4 right-4",
  bl: "bottom-4 left-16",
  tr: "top-14 right-4",
  tl: "top-14 left-16",
};

function hits(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * The corner of the canvas that no window and no other panel covers, so that the group stays clear of the Graph window
 * (docs/BRAIN.md, "Visibility and navigation"). It prefers the bottom right and is hidden when every corner is covered.
 */
function useFreeCorner(self: React.RefObject<HTMLDivElement | null>): Corner | null {
  const [corner, setCorner] = useState<Corner | null>("br");
  useEffect(() => {
    const measure = () => {
      const el = self.current;
      const host = el?.offsetParent;
      if (!el || !host) return;
      const origin = host.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const covers = [...document.querySelectorAll("[role=region][aria-label]:not([data-brain-view]), [data-brain-block]")]
        .filter((o) => o !== el && !el.contains(o))
        .map((o) => o.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      const spot = (c: Corner): DOMRect => {
        const left = c === "br" || c === "tr" ? origin.right - 16 - w : origin.left + 64;
        const top = c === "br" || c === "bl" ? origin.bottom - 16 - h : origin.top + 56;
        return new DOMRect(left, top, w, h);
      };
      const free = CORNERS.find((c) => !covers.some((r) => hits(spot(c), r))) ?? null;
      setCorner((prev) => (prev === free ? prev : free));
    };
    const timer = window.setInterval(measure, 400);
    const first = window.setTimeout(measure, 0);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(first);
    };
  }, [self]);
  return corner;
}

export function BrainControls() {
  const view = useStore((s) => s.graphView);
  const ref = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const corner = useFreeCorner(ref);
  const [open, setOpen] = useState(false);
  const leftSide = corner === "bl" || corner === "tl";
  useEffect(() => {
    if (!open) return;
    const away = (ev: PointerEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    };
    const escape = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      setOpen(false);
      settingsRef.current?.focus();
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return (
    <div
      ref={ref}
      role="group"
      aria-label="Brain view controls"
      data-brain-block
      className={`absolute ${CORNER_CLASS[corner ?? "br"]} z-10 flex w-12 min-w-0 flex-col items-center gap-1 rounded-md border border-rule-strong bg-surface p-1 text-ink ${corner ? "" : "invisible"}`}
    >
      <IconButton icon={ZoomIn} label="Zoom in" tip="Zoom in (plus)" onClick={() => send("zoom-in")} />
      <IconButton icon={ZoomOut} label="Zoom out" tip="Zoom out (minus)" onClick={() => send("zoom-out")} />
      <IconButton icon={RotateCcw} label="Reset view" tip="Reset the view (0)" onClick={() => send("reset")} />
      <div className="grid w-full min-w-0 grid-cols-2 gap-px" role="group" aria-label="Preset views">
        {PRESETS.map((p, i) => (
          <button
            key={p.cmd}
            type="button"
            className={`${SEGMENT} ${i === 0 ? "rounded-tl-md" : i === 1 ? "rounded-tr-md" : i === 2 ? "rounded-bl-md" : "rounded-br-md"}`}
            aria-label={`${p.label} view`}
            title={`${p.label} view (${p.key})`}
            onClick={() => send(p.cmd)}
          >
            {p.letter}
          </button>
        ))}
      </div>
      <Toggle icon={Orbit} label="Auto-rotate" on={view.ambient} onChange={(ambient) => setGraphView({ ambient })} />
      <Toggle icon={Tags} label="Labels" on={view.captions} onChange={(captions) => setGraphView({ captions })} />
      <button
        ref={settingsRef}
        type="button"
        className={`${ICON} ${open ? "border-signal bg-raised text-ink" : ""}`}
        aria-label="Surface and Expand settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Surface and Expand settings"
        onClick={() => setOpen((o) => !o)}
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Surface and Expand settings"
          className={`absolute bottom-0 ${leftSide ? "left-full ml-2" : "right-full mr-2"} w-64 min-w-0 space-y-2 rounded-md border border-rule-strong bg-surface p-3`}
        >
          <Slider icon={Eye} label="Surface" value={view.surface} onChange={(surface) => setGraphView({ surface })} />
          <Slider icon={Layers} label="Expand" value={view.expand} onChange={(expand) => setGraphView({ expand })} />
          <p className="text-caption text-ink-faint">Arrow keys turn the brain, plus and minus zoom, 0 resets and 1 to 4 choose a view. Right drag pans.</p>
        </div>
      )}
    </div>
  );
}
