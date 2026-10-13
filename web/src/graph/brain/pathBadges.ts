// The waypoint badges and the finding markers of the traced path (docs/BRAIN.md, "Waypoints and branches" and "Findings on the
// path"). They are HTML over the canvas, in a pool of elements, so that a path of 2,000 steps costs at most BADGE_MAX elements.
// Badges that lie closer than 22 pixels on screen merge into one capsule that lists the step numbers.
import { REGIONS, type RegionId } from "@shared/brain";
import { BADGE_MAX, BADGE_MERGE_PX, BADGE_PX, SUB_BADGE_PX } from "./look";
import { hopLine, mergeBadges, stepsLabel, type PathGeometry, type PathSub, type V3 } from "./path";
import { estimateWidth, layoutCapsules, type Bounds, type Box } from "./pathboxes";
import type { PathMarker } from "./types";

export interface MarkerSpot {
  step: number;
  pos: V3;
  marker: PathMarker;
}

export interface BadgeInput {
  geo: PathGeometry | null;
  /** the progress value: a badge shows once the head has reached its waypoint */
  progress: number;
  /** the selected step, which has a ring in the colour of the signal */
  selected: number | null;
  /** the step that plays */
  active: number;
  markers: MarkerSpot[];
  /** the hops of the chains to draw as sub-steps (9a, 9b): all of them while the whole path is shown, those of the selected step otherwise */
  subs?: PathSub[];
  project: (p: V3) => { x: number; y: number } | null;
  /** whether the number on the badge of a region is drawn in the colour of the background or of the text */
  ink: (region: RegionId | null) => "void" | "ink";
  sentences: (step: number) => string;
  /** boxes that the window covers over the canvas, which a badge keeps clear of */
  blocked?: Box[];
  bounds?: Bounds | null;
}

export interface BadgeHooks {
  pick: (step: number) => void;
  hover: (step: number | null) => void;
}

export interface PlacedBadge {
  steps: number[];
  /** the centre of the box */
  x: number;
  y: number;
  left: number;
  top: number;
  w: number;
  h: number;
  /** the node that the badge names, where it is not on it: the engine draws a leader line to it */
  moved: boolean;
  ax: number;
  ay: number;
  /** a finding marker and not a badge */
  pin: boolean;
  /** the badge of a hop of a chain (9a) and not of a step */
  sub?: boolean;
}

const PIN_PX = 22;

const TRIANGLE =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

interface Badge {
  el: HTMLDivElement;
  used: boolean;
  text: string;
  transform: string;
  style: string;
}

export class PathBadges {
  private badges: Badge[] = [];
  private pins: Badge[] = [];
  private subBadges: Badge[] = [];
  /** the badges drawn in the last frame, for the labels to keep clear of */
  placed: PlacedBadge[] = [];
  private widths = new Map<string, number>();
  private ruler: HTMLDivElement | null = null;

  constructor(
    private host: HTMLElement,
    private hooks: BadgeHooks,
  ) {}

  private make(pin: boolean, sub = false): Badge {
    const el = document.createElement("div");
    el.className = "text-caption num";
    el.style.cssText = `position:absolute;left:0;top:0;display:flex;align-items:center;justify-content:center;box-sizing:border-box;height:${BADGE_PX}px;min-width:${BADGE_PX}px;padding:0 5px;border-radius:${BADGE_PX / 2}px;font-weight:600;line-height:1;white-space:nowrap;will-change:transform;pointer-events:auto;cursor:pointer;opacity:0`;
    if (sub) {
      el.style.height = `${SUB_BADGE_PX}px`;
      el.style.minWidth = `${SUB_BADGE_PX}px`;
      el.style.borderRadius = `${SUB_BADGE_PX / 2}px`;
      el.style.padding = "0 4px";
      el.style.fontWeight = "500";
    }
    if (pin) {
      el.style.width = "22px";
      el.style.height = "22px";
      el.style.padding = "0";
      el.style.borderRadius = "11px";
      el.style.background = "var(--color-surface)";
    }
    this.host.appendChild(el);
    const b: Badge = { el, used: false, text: "", transform: "", style: "" };
    if (!pin) {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const first = Number(el.dataset.first);
        if (first) this.hooks.pick(first);
      });
      el.addEventListener("mouseenter", () => this.hooks.hover(Number(el.dataset.first) || null));
      el.addEventListener("mouseleave", () => this.hooks.hover(null));
    } else {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const first = Number(el.dataset.first);
        if (first) this.hooks.pick(first);
      });
    }
    return b;
  }

  private take(pool: Badge[], i: number, pin: boolean, sub = false): Badge {
    while (pool.length <= i) pool.push(this.make(pin, sub));
    return pool[i];
  }

  /** The width of a capsule with this text: measured once on the element, and estimated until then. */
  private widthOf(text: string): number {
    const known = this.widths.get(text);
    if (known) return known;
    if (!this.ruler) {
      const el = document.createElement("div");
      el.className = "text-caption num";
      el.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;padding:0 5px;font-weight:600;white-space:nowrap;min-width:${BADGE_PX}px`;
      this.host.appendChild(el);
      this.ruler = el;
    }
    this.ruler.textContent = text;
    const w = this.ruler.offsetWidth;
    if (this.widths.size > 600) this.widths.clear();
    if (w > 0) this.widths.set(text, w);
    return w > 0 ? w : estimateWidth(text, BADGE_PX);
  }

  /** Place the badges and the markers for the frame. Writes to the elements only where something changed. */
  update(inp: BadgeInput): void {
    for (const b of this.badges) b.used = false;
    for (const b of this.pins) b.used = false;
    for (const b of this.subBadges) b.used = false;
    this.placed = [];
    const g = inp.geo;
    // the finding markers stand up and to the right of their node and keep their place, so the badges move round them
    const spots: { m: MarkerSpot; x: number; y: number }[] = [];
    for (const m of inp.markers) {
      const w = g?.waypoints[m.step - 1];
      if (!w || w.at > inp.progress + 1e-9) continue;
      const s = inp.project(m.pos);
      if (s) spots.push({ m, x: s.x, y: s.y });
    }
    const pinBoxes: Box[] = spots.map((p) => ({ left: Math.round(p.x + 8), top: Math.round(p.y - 34), w: PIN_PX, h: PIN_PX }));
    if (g) {
      const pts: { step: number; x: number; y: number }[] = [];
      for (const w of g.waypoints) {
        if (w.at > inp.progress + 1e-9) continue;
        const s = inp.project(w.pos);
        if (s) pts.push({ step: w.step, x: s.x, y: s.y });
      }
      const merged = mergeBadges(pts, BADGE_MERGE_PX, BADGE_MAX).map((c) => {
        const steps = c.steps.slice().sort((p, q) => p - q);
        return { steps, x: c.x, y: c.y, h: BADGE_PX, w: this.widthOf(stepsLabel(steps)) };
      });
      const layout = layoutCapsules(merged, [...pinBoxes, ...(inp.blocked ?? [])], inp.bounds ?? null);
      layout.placed.forEach((c, i) => {
        const b = this.take(this.badges, i, false);
        b.used = true;
        const w = g.waypoints[c.steps[0] - 1];
        const region = w.region;
        const fill = region ? `var(--color-region-${region})` : "var(--color-ink-faint)";
        const hollow = c.steps.length === 1 && w.hollow;
        const chosen = inp.selected !== null && c.steps.includes(inp.selected);
        const now = c.steps.includes(inp.active);
        const text = stepsLabel(c.steps);
        const ink = inp.ink(region) === "void" ? "var(--color-void)" : "var(--color-ink)";
        const look = [hollow ? "var(--color-surface)" : fill, hollow ? "var(--color-ink)" : ink, hollow ? `2px dashed ${fill}` : "1px solid var(--color-void)", chosen ? "0 0 0 3px var(--color-signal)" : now ? `0 0 0 2px ${fill}` : "none"];
        const style = look.join("|");
        if (b.style !== style) {
          b.el.style.background = look[0];
          b.el.style.color = look[1];
          b.el.style.border = look[2];
          b.el.style.boxShadow = look[3];
          b.style = style;
        }
        if (b.text !== text) {
          b.el.textContent = text;
          b.text = text;
          b.el.title = c.steps.length === 1 ? inp.sentences(c.steps[0]) : c.steps.map((n) => `${n}. ${inp.sentences(n)}`).slice(0, 6).join("\n");
        }
        b.el.dataset.first = String(c.steps[0]);
        b.el.dataset.steps = c.steps.join(",");
        const tf = `translate3d(${c.left}px,${c.top}px,0)`;
        if (b.transform !== tf) {
          b.el.style.transform = tf;
          b.transform = tf;
        }
        b.el.style.opacity = "1";
        this.placed.push({ steps: c.steps, x: c.left + c.w / 2, y: c.top + c.h / 2, left: c.left, top: c.top, w: c.w, h: c.h, moved: c.moved, ax: c.ax, ay: c.ay, pin: false });
      });
    }
    if (inp.subs?.length) this.updateSubs(inp, pinBoxes);
    spots.forEach((p, k) => {
      const m = p.m;
      const b = this.take(this.pins, k, true);
      b.used = true;
      const colour = m.marker.severity === "violation" ? "var(--color-block)" : m.marker.severity === "warning" ? "var(--color-hold)" : "var(--color-ink-soft)";
      if (b.style !== colour) {
        b.el.style.color = colour;
        b.el.style.border = `2px solid ${colour}`;
        b.style = colour;
        b.el.innerHTML = TRIANGLE;
      }
      b.el.title = m.marker.title;
      b.el.dataset.first = String(m.step);
      const box = pinBoxes[k];
      const tf = `translate3d(${box.left}px,${box.top}px,0)`;
      if (b.transform !== tf) {
        b.el.style.transform = tf;
        b.transform = tf;
      }
      b.el.style.opacity = "1";
      this.placed.push({ steps: [m.step], x: box.left + PIN_PX / 2, y: box.top + PIN_PX / 2, left: box.left, top: box.top, w: PIN_PX, h: PIN_PX, moved: false, ax: p.x, ay: p.y, pin: true });
    });
    for (const b of [...this.badges, ...this.pins, ...this.subBadges]) if (!b.used) b.el.style.opacity = "0";
    // an unused element takes no clicks
    for (const b of [...this.badges, ...this.pins, ...this.subBadges]) b.el.style.pointerEvents = b.used ? "auto" : "none";
  }

  /** The hops of the chains, one small badge for each node, placed after the step badges and clear of them. A node that two chains share shows both. */
  private updateSubs(inp: BadgeInput, pinBoxes: Box[]): void {
    const by = new Map<string, PathSub[]>();
    for (const s of inp.subs ?? []) {
      if (s.at > inp.progress + 1e-9) continue;
      by.set(s.id, [...(by.get(s.id) ?? []), s]);
    }
    const caps: { steps: number[]; x: number; y: number; w: number; h: number; items: PathSub[] }[] = [];
    for (const items of by.values()) {
      const at = inp.project(items[0].pos);
      if (!at) continue;
      items.sort((p, q) => p.step - q.step);
      const text = subText(items);
      caps.push({ steps: [items[0].step], x: at.x, y: at.y, w: this.widthOf(text), h: SUB_BADGE_PX, items });
    }
    caps.sort((p, q) => p.steps[0] - q.steps[0] || p.items[0].letter.localeCompare(q.items[0].letter));
    const main = this.placed.map((b) => ({ left: b.left, top: b.top, w: b.w, h: b.h }));
    const layout = layoutCapsules(caps, [...pinBoxes, ...main, ...(inp.blocked ?? [])], inp.bounds ?? null);
    layout.placed.forEach((c, i) => {
      const items = (c as unknown as { items: PathSub[] }).items;
      const b = this.take(this.subBadges, i, false, true);
      b.used = true;
      const fill = `var(--color-region-${items[0].region})`;
      const proposed = items.every((s) => s.hop.status === "proposed");
      const style = `${fill}|${proposed}`;
      if (b.style !== style) {
        b.el.style.background = "var(--color-surface)";
        b.el.style.color = "var(--color-ink)";
        b.el.style.border = `2px ${proposed ? "dashed" : "solid"} ${fill}`;
        b.style = style;
      }
      const text = subText(items);
      if (b.text !== text) {
        b.el.textContent = text;
        b.text = text;
        b.el.title = items.map((s) => hopLine(s.step, s.hop)).join("\n");
      }
      b.el.dataset.first = String(items[0].step);
      b.el.dataset.sub = items.map((s) => `${s.step}${s.letter}`).join(",");
      const tf = `translate3d(${c.left}px,${c.top}px,0)`;
      if (b.transform !== tf) {
        b.el.style.transform = tf;
        b.transform = tf;
      }
      b.el.style.opacity = "1";
      this.placed.push({ steps: items.map((s) => s.step), x: c.left + c.w / 2, y: c.top + c.h / 2, left: c.left, top: c.top, w: c.w, h: c.h, moved: c.moved, ax: c.ax, ay: c.ay, pin: false, sub: true });
    });
  }

  clear(): void {
    this.placed = [];
    for (const b of [...this.badges, ...this.pins, ...this.subBadges]) {
      b.el.style.opacity = "0";
      b.el.style.pointerEvents = "none";
    }
  }

  dispose(): void {
    this.ruler?.remove();
    this.ruler = null;
    for (const b of [...this.badges, ...this.pins, ...this.subBadges]) b.el.remove();
    this.badges = [];
    this.pins = [];
    this.subBadges = [];
  }
}

/** The text of the badge of a node that chains reach: "9a", or "9a 10a 14a" and at most 3 with the number of the rest ("9a 10a 11a +2"). */
export function subText(items: { step: number; letter: string }[]): string {
  const own = items.slice(0, 3).map((s) => `${s.step}${s.letter}`);
  return items.length > 3 ? `${own.join(" ")} +${items.length - 3}` : own.join(" ");
}

/** The plain name of a region for a title, in the words of the legend. */
export function regionName(id: RegionId): string {
  return REGIONS.find((r) => r.id === id)?.label ?? id;
}
