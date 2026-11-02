// The 2D canvas of the Knowledge layer. Glow and gradients are allowed here and nowhere else in the window, as in the brain view.
// Pan and zoom are written with pointer events. A drag on a claim moves it and is committed through route 34 after 250 ms.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { RenderSettings } from "@shared/learn/knowledge";
import { parseCssColor, type Rgb } from "../palette";
import {
  arrowGeometry,
  boundsOf,
  fitCamera,
  labelAlpha,
  clusterAlpha,
  panBy,
  pickNode,
  toScreen,
  toWorld,
  zoomAt,
  zoomRatio,
  type Camera,
  type Pt,
} from "./geometry";
import { clusterOutlines, positionsOf, settleJunctions, type Scene } from "./scene";

export interface CanvasHandle {
  zoomBy: (factor: number) => void;
  fit: () => void;
  /** centres the claim, zooms in when the view is wide, and returns where it now is on the screen */
  focus: (id: string) => Pt | null;
  screenOf: (id: string) => Pt | null;
}

interface Props {
  scene: Scene;
  settings: RenderSettings;
  selectedId: string | null;
  /** the claims to keep bright, or null for all */
  bright: ReadonlySet<string> | null;
  onPick: (id: string | null, anchor: Pt | null) => void;
  /** a pan or a zoom, so that the card closes */
  onMove: () => void;
  onCommit: (positions: Record<string, Pt>) => void;
}

interface Colours {
  font: string;
  claim: Rgb;
  ink: Rgb;
  inkSoft: Rgb;
  signal: Rgb;
  ground: Rgb;
  clusters: Record<string, Rgb>;
}

const rgba = (c: Rgb, a: number) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`;

function readColours(): Colours {
  const root = getComputedStyle(document.documentElement);
  const get = (t: string) => parseCssColor(root.getPropertyValue(t));
  const clusters: Record<string, Rgb> = {};
  for (const t of ["instruction", "machinery", "record", "work", "world", "language"]) clusters[`--color-fam-${t}`] = get(`--color-fam-${t}`);
  return {
    font: getComputedStyle(document.body).fontFamily || "sans-serif",
    claim: get("--color-fam-knowledge"),
    ink: get("--color-ink"),
    inkSoft: get("--color-ink-soft"),
    signal: get("--color-signal"),
    ground: get("--color-sunken"),
    clusters,
  };
}

const DRAG_THRESHOLD = 4;
const COMMIT_DELAY = 250;

export const KnowledgeCanvas = forwardRef<CanvasHandle, Props>(function KnowledgeCanvas({ scene, settings, selectedId, bright, onPick, onMove, onCommit }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cam = useRef<Camera>({ x: 0, y: 0, k: 1 });
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const fitted = useRef(false);
  const fitK = useRef(1);
  const hover = useRef<string | null>(null);
  const colours = useRef<Colours | null>(null);
  const frame = useRef(0);
  const live = useRef({ scene, settings, selectedId, bright, onPick, onMove, onCommit });
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const draw = useRef(() => {});
  const dirty = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      draw.current();
    });
  };

  const refit = (resetCamera: boolean) => {
    const { w, h } = size.current;
    const fit = fitCamera(boundsOf(live.current.scene.nodes), w, h);
    fitK.current = fit.k;
    if (resetCamera) cam.current = fit;
  };

  useEffect(() => {
    live.current = { scene, settings, selectedId, bright, onPick, onMove, onCommit };
    if (size.current.w > 0 && scene.nodes.length) {
      refit(!fitted.current);
      fitted.current = true;
    }
    dirty();
  });

  useImperativeHandle(ref, () => ({
    zoomBy: (f) => {
      const { w, h } = size.current;
      cam.current = zoomAt(cam.current, f, { x: w / 2, y: h / 2 }, fitK.current * 0.6);
      live.current.onMove();
      dirty();
    },
    fit: () => {
      refit(true);
      live.current.onMove();
      dirty();
    },
    focus: (id) => {
      const n = live.current.scene.byId.get(id);
      if (!n) return null;
      const { w, h } = size.current;
      const k = Math.max(cam.current.k, fitK.current * 2.5);
      cam.current = { k, x: w / 2 - n.x * k, y: h / 2 - n.y * k };
      dirty();
      return toScreen(cam.current, n);
    },
    screenOf: (id) => {
      const n = live.current.scene.byId.get(id);
      return n ? toScreen(cam.current, n) : null;
    },
  }));

  useEffect(() => {
    const el = box.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    colours.current = readColours();

    draw.current = () => {
      const ctx = cv.getContext("2d");
      const col = colours.current;
      if (!ctx || !col) return;
      const { w, h, dpr } = size.current;
      const { scene: sc, settings: st, selectedId: sel, bright: lit } = live.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = rgba(col.ground, 1);
      ctx.fillRect(0, 0, w, h);
      const c = cam.current;
      const ratio = zoomRatio(c, fitK.current);
      const nodeA = labelAlpha(ratio, st.labelZoom);
      const clusterA = st.clusterLabels ? clusterAlpha(ratio, st.labelZoom) : 0;
      const S = (n: Pt) => toScreen(c, n);
      const dim = (id: string) => (lit && !lit.has(id) ? 0.22 : 1);

      // clusters: a tint behind the claims and the name at low zoom
      if (st.regions.enabled) {
        const outlines = clusterOutlines(sc, st.regions.dilation * 0.5);
        for (const o of outlines) {
          const colour = col.clusters[o.cluster.token] ?? col.inkSoft;
          ctx.beginPath();
          o.hull.forEach((p, i) => {
            const s = S(p);
            if (i === 0) ctx.moveTo(s.x, s.y);
            else ctx.lineTo(s.x, s.y);
          });
          ctx.closePath();
          ctx.fillStyle = rgba(colour, 0.05 + st.regions.edgeAlpha * 0.2);
          ctx.fill();
          ctx.lineJoin = "round";
          ctx.lineWidth = 1;
          ctx.strokeStyle = rgba(colour, 0.35);
          ctx.stroke();
        }
        if (clusterA > 0.02) {
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = `500 ${Math.max(11, st.clusterLabelSize)}px ${col.font}`;
          for (const o of outlines) {
            const s = S(o.centre);
            ctx.fillStyle = rgba(col.inkSoft, clusterA * 0.95);
            ctx.fillText(clip(ctx, o.cluster.label, 220), s.x, s.y);
          }
        }
      }

      // links, then the arrow heads
      const lineW = Math.min(1.75, Math.max(0.75, st.edgeWidth * c.k * 0.5));
      for (const l of sc.links) {
        const a = sc.byId.get(l.from);
        const b = sc.byId.get(l.to);
        if (!a || !b) continue;
        const alpha = Math.min(dim(l.from), dim(l.to));
        ctx.strokeStyle = rgba(col.inkSoft, 0.55 * alpha);
        ctx.fillStyle = rgba(col.inkSoft, 0.8 * alpha);
        ctx.lineWidth = lineW;
        if (l.arrow) {
          const head = Math.max(5, st.arrowLength * c.k * 0.8);
          const g = arrowGeometry(S(a), S(b), a.r * c.k, b.r * c.k, head);
          if (!g) continue;
          ctx.beginPath();
          ctx.moveTo(g.tail.x, g.tail.y);
          ctx.lineTo((g.left.x + g.right.x) / 2, (g.left.y + g.right.y) / 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(g.tip.x, g.tip.y);
          ctx.lineTo(g.left.x, g.left.y);
          ctx.lineTo(g.right.x, g.right.y);
          ctx.closePath();
          ctx.fill();
        } else {
          const sa = S(a);
          const sb = S(b);
          ctx.beginPath();
          ctx.moveTo(sa.x, sa.y);
          ctx.lineTo(sb.x, sb.y);
          ctx.stroke();
        }
      }

      // junctions are rings and are never labelled
      for (const n of sc.nodes) {
        if (n.kind !== "junction") continue;
        const s = S(n);
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.max(3, n.r * c.k), 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = rgba(col.inkSoft, 0.9 * dim(n.id));
        ctx.stroke();
      }

      // claims
      const hot = hover.current;
      for (const n of sc.nodes) {
        if (n.kind !== "proposition") continue;
        const s = S(n);
        const r = Math.max(2.5, n.r * c.k);
        const a = dim(n.id);
        if (n.id === hot && a === 1) {
          const halo = ctx.createRadialGradient(s.x, s.y, r * 0.6, s.x, s.y, r * 1.7);
          halo.addColorStop(0, rgba(col.claim, 0.3));
          halo.addColorStop(1, rgba(col.claim, 0));
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(s.x, s.y, r * 1.7, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fillStyle = rgba(col.claim, a);
        ctx.fill();
        if (n.id === sel) {
          ctx.beginPath();
          ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2);
          ctx.lineWidth = 2;
          ctx.strokeStyle = rgba(col.signal, 1);
          ctx.stroke();
        }
      }

      // claim labels fade in as the cluster names fade out
      if (nodeA > 0.02) {
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.font = `400 ${Math.max(11, Math.min(13, st.labelSize * c.k * 0.9))}px ${col.font}`;
        for (const n of sc.nodes) {
          if (n.kind !== "proposition") continue;
          const s = S(n);
          if (s.x < -80 || s.y < -40 || s.x > w + 80 || s.y > h + 40) continue;
          const on = n.id === sel || n.id === hover.current;
          ctx.fillStyle = on ? rgba(col.signal, nodeA) : rgba(col.ink, nodeA * 0.9 * dim(n.id));
          ctx.fillText(clip(ctx, n.name, 140), s.x, s.y + Math.max(2.5, n.r * c.k) + 4);
        }
      }
    };

    const resize = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: Math.max(0, Math.floor(r.width)), h: Math.max(0, Math.floor(r.height)), dpr };
      cv.width = Math.max(1, Math.floor(r.width * dpr));
      cv.height = Math.max(1, Math.floor(r.height * dpr));
      cv.style.width = `${r.width}px`;
      cv.style.height = `${r.height}px`;
      if (live.current.scene.nodes.length && size.current.w > 0) {
        refit(!fitted.current);
        fitted.current = true;
      }
      dirty();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const recolour = () => {
      colours.current = readColours();
      dirty();
    };
    const mo = new MutationObserver(recolour);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", recolour);

    // pointer handling
    let mode: "none" | "pan" | "node" = "none";
    let startPt: Pt = { x: 0, y: 0 };
    let last: Pt = { x: 0, y: 0 };
    let moved = false;
    let grabbed: string | null = null;
    const local = (e: PointerEvent | WheelEvent): Pt => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const hit = (p: Pt) => pickNode(live.current.scene.nodes, toWorld(cam.current, p), 8 / cam.current.k);
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      cv.setPointerCapture(e.pointerId);
      startPt = last = local(e);
      moved = false;
      grabbed = hit(startPt);
      mode = grabbed ? "node" : "pan";
    };
    const move = (e: PointerEvent) => {
      const p = local(e);
      if (mode === "none") {
        const id = hit(p);
        if (id !== hover.current) {
          hover.current = id;
          cv.style.cursor = id ? "pointer" : "grab";
          dirty();
        }
        return;
      }
      if (!moved && Math.hypot(p.x - startPt.x, p.y - startPt.y) < DRAG_THRESHOLD) return;
      if (!moved) {
        moved = true;
        live.current.onMove();
      }
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      last = p;
      if (mode === "pan") {
        cam.current = panBy(cam.current, dx, dy);
        cv.style.cursor = "grabbing";
      } else if (grabbed) {
        const n = live.current.scene.byId.get(grabbed);
        if (n) {
          n.x += dx / cam.current.k;
          n.y += dy / cam.current.k;
          settleJunctions(live.current.scene);
        }
      }
      dirty();
    };
    const up = (e: PointerEvent) => {
      if (mode === "none") return;
      if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
      const wasNode = mode === "node";
      const id = grabbed;
      mode = "none";
      grabbed = null;
      cv.style.cursor = hover.current ? "pointer" : "grab";
      if (!moved) {
        const p = local(e);
        live.current.onPick(id, id ? toScreen(cam.current, live.current.scene.byId.get(id) ?? p) : null);
        return;
      }
      if (wasNode && id) {
        if (commitTimer.current) clearTimeout(commitTimer.current);
        commitTimer.current = setTimeout(() => live.current.onCommit(positionsOf(live.current.scene)), COMMIT_DELAY);
      }
    };
    const leave = () => {
      if (mode === "none" && hover.current) {
        hover.current = null;
        dirty();
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
      cam.current = zoomAt(cam.current, f, local(e), fitK.current * 0.6);
      live.current.onMove();
      dirty();
    };
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("pointerleave", leave);
    cv.addEventListener("wheel", wheel, { passive: false });
    cv.style.cursor = "grab";
    return () => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener("change", recolour);
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
      cv.removeEventListener("pointerleave", leave);
      cv.removeEventListener("wheel", wheel);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      if (commitTimer.current) clearTimeout(commitTimer.current);
    };
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    const { w, h } = size.current;
    const step = 40;
    let used = true;
    if (e.key === "+" || e.key === "=") cam.current = zoomAt(cam.current, 1.25, { x: w / 2, y: h / 2 }, fitK.current * 0.6);
    else if (e.key === "-") cam.current = zoomAt(cam.current, 0.8, { x: w / 2, y: h / 2 }, fitK.current * 0.6);
    else if (e.key === "0") refit(true);
    else if (e.key === "ArrowLeft") cam.current = panBy(cam.current, step, 0);
    else if (e.key === "ArrowRight") cam.current = panBy(cam.current, -step, 0);
    else if (e.key === "ArrowUp") cam.current = panBy(cam.current, 0, step);
    else if (e.key === "ArrowDown") cam.current = panBy(cam.current, 0, -step);
    else used = false;
    if (used) {
      e.preventDefault();
      live.current.onMove();
      dirty();
    }
  };

  return (
    <div ref={box} className="relative h-full min-h-0 min-w-0 overflow-hidden bg-sunken">
      <canvas
        ref={canvas}
        tabIndex={0}
        role="img"
        aria-label="Map of claims and the arguments that join them. Plus and minus zoom, the arrow keys pan and 0 fits the view. The chain table lists the same claims."
        onKeyDown={onKey}
        className="absolute inset-0 touch-none"
      />
    </div>
  );
});

function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}
