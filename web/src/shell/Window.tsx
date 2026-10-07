import { Suspense, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import { APP_BY_ID } from "../apps/registry";
import { IconButton } from "../components/IconButton";
import { rectOf, windowStore, type Viewport, type WinState } from "./windows";

type Edge = "right" | "bottom" | "corner";

export function Window({ win, vp, focused }: { win: WinState; vp: Viewport; focused: boolean }) {
  const def = APP_BY_ID.get(win.app);
  const drag = useRef<{ px: number; py: number; x: number; y: number; w: number; h: number; edge: Edge | "move" } | null>(null);
  if (!def) return null;
  const Icon = def.icon;
  const App = def.component;
  const r = rectOf(win, vp);

  const begin = (e: ReactPointerEvent<HTMLElement>, edge: Edge | "move") => {
    if (win.maximised) return;
    if (edge === "move" && (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, x: win.x, y: win.y, w: win.w, h: win.h, edge };
  };

  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (d.edge === "move") windowStore.setRect(win.app, { x: d.x + dx, y: d.y + dy, w: d.w, h: d.h });
    else {
      const w = d.edge === "bottom" ? d.w : d.w + dx;
      const h = d.edge === "right" ? d.h : d.h + dy;
      windowStore.setRect(win.app, { x: d.x, y: d.y, w, h });
    }
  };

  const end = (e: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const handle = (edge: Edge, cls: string) => (
    <div
      aria-hidden="true"
      onPointerDown={(e) => begin(e, edge)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      className={`absolute ${cls}`}
    />
  );

  return (
    <section
      role="region"
      aria-label={def.title}
      onPointerDownCapture={() => {
        if (!focused) windowStore.focus(win.app);
      }}
      style={{ left: r.x, top: r.y, width: r.w, height: r.h, zIndex: win.z }}
      className={`pointer-events-auto absolute flex flex-col overflow-hidden rounded-lg border bg-surface ${
        focused ? "border-rule-strong" : "border-rule"
      } ${win.minimised ? "hidden" : ""}`}
    >
      <header
        onPointerDown={(e) => begin(e, "move")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => windowStore.toggleMaximise(win.app)}
        className="flex h-8 shrink-0 cursor-default select-none items-center gap-2 border-b border-rule bg-raised pl-3 pr-1"
      >
        <Icon size={14} className="shrink-0 text-ink-soft" aria-hidden="true" />
        <h2 className={`min-w-0 flex-1 truncate text-small font-medium ${focused ? "text-ink" : "text-ink-soft"}`}>{def.title}</h2>
        <IconButton icon={Minus} label="Minimise" size={14} className="h-6 w-6" onClick={() => windowStore.minimise(win.app)} />
        <IconButton
          icon={win.maximised ? Minimize2 : Maximize2}
          label={win.maximised ? "Restore" : "Maximise"}
          size={14}
          className="h-6 w-6"
          onClick={() => windowStore.toggleMaximise(win.app)}
        />
        <IconButton icon={X} label="Close" size={14} className="h-6 w-6" onClick={() => windowStore.close(win.app)} />
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Suspense fallback={<p className="p-4 text-body text-ink-faint">Loading {def.title}</p>}>
          <App params={win.params} />
        </Suspense>
      </div>
      {win.maximised ? null : (
        <>
          {handle("right", "right-0 top-8 bottom-3 w-1.5 cursor-ew-resize")}
          {handle("bottom", "bottom-0 left-0 right-3 h-1.5 cursor-ns-resize")}
          {handle("corner", "bottom-0 right-0 h-3 w-3 cursor-nwse-resize")}
        </>
      )}
    </section>
  );
}
