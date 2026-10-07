// The imperative part of the graph canvas: one 3d-force-graph instance, one shared sphere geometry, one material
// for each node, and one animation loop for glows. NeuralGraph.tsx wires it to React and the bus.
import ForceGraph3D from "3d-force-graph";
import type { ForceGraph3DInstance } from "3d-force-graph";
import { BufferAttribute, BufferGeometry, Color, LineBasicMaterial, LineDashedMaterial, LineSegments, Mesh, MeshBasicMaterial, SRGBColorSpace, SphereGeometry, Vector2 } from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { Activation, Family, GraphFile, GraphNode } from "@shared/types";
import { token } from "../lib/theme";
import { GlowTracker, boost, orbitSpeed, planFiring, ringState, type Scheduled } from "./animate";
import {
  anchorForce,
  familyAnchors,
  filterEdges,
  filterNodes,
  nodeRadius,
  rememberPositions,
  restorePosition,
  type Vec3,
  type ViewFilter,
} from "./layout";
import { heatOfNode, readPalette, restingBrightness, shade, type Palette } from "./palette";

export interface EngineHooks {
  onSelect: (id: string | null) => void;
}

export interface EngineView extends ViewFilter {
  sizeBy: "heat" | "degree";
  /** draw the links that nobody has reviewed yet (provenance "proposed"); they are left out by default */
  showProposed?: boolean;
}

interface CNode {
  id: string;
  family: Family;
  gn: GraphNode;
  x?: number;
  y?: number;
  z?: number;
  [key: string]: unknown;
}

interface CLink {
  source: string | CNode;
  target: string | CNode;
  rel: string;
}

interface Mark {
  mesh: Mesh;
  mat: MeshBasicMaterial;
  radius: number;
  heat: number;
  label: HTMLDivElement | null;
}

interface Ring {
  mesh: Mesh;
  mat: MeshBasicMaterial;
  start: number;
}

interface Pending extends Scheduled {
  due: number;
}

const ORBIT_PAUSE_MS = 20_000;
const FOCUS_MS = 1200;
const DIM = 0.15;

// Landmarks carry a label at all times, so that the graph reads as a map: the task types that firing starts from,
// the rule files, the agents, the skills and the map file. With labels switched on in the Graph window, the reference
// files, guides, projects, clients and schemes are labelled too.
// Only the task types and agents are labelled at all times, because more labels overlap in the dense centre of the
// graph and cannot be read (seen at 1440 x 900 on 6 October 2026).
const LANDMARKS = new Set(["TaskType", "Agent"]);
const HUB_TYPES = LANDMARKS;
const MORE_LABELS = new Set(["RuleFile", "Skill", "MapFile", "OutputStyle", "ReferenceFile", "GuideFile", "Project", "Client", "ConceptScheme"]);

function shortLabel(gn: GraphNode): string {
  const raw = gn.type === "RuleFile" || gn.type === "MapFile" || gn.type === "OutputStyle" || gn.type === "ReferenceFile" || gn.type === "GuideFile"
    ? (gn.path ?? gn.label).split("/").pop() ?? gn.label
    : gn.label;
  return raw.length > 30 ? `${raw.slice(0, 29)}…` : raw;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface OrbitLike {
  autoRotate: boolean;
  autoRotateSpeed: number;
  target: { set: (x: number, y: number, z: number) => void };
}

export class GraphEngine {
  private graph: ForceGraph3DInstance;
  private geometry = new SphereGeometry(1, 10, 8);
  private marks = new Map<string, Mark>();
  private nodeObjs = new Map<string, CNode>();
  private positions = new Map<string, Vec3>();
  private linkIndex = new Map<string, CLink>();
  private current: CNode[] = [];
  private pairs: { a: CNode; b: CNode }[] = [];
  private lines: LineSegments;
  // Proposed links are dashed and fainter, so they are a second object with their own pairs.
  private proposedLines: LineSegments;
  private proposedPairs: { a: CNode; b: CNode }[] = [];
  private palette: Palette;
  private tracker = new GlowTracker();
  private pending: Pending[] = [];
  private rings: Ring[] = [];
  private raf = 0;
  private last = 0;
  private hiddenAt = 0;
  private highlight: Set<string> | null = null;
  private selected: string | null = null;
  private selRing: Mesh;
  private sizeBy: "heat" | "degree" = "heat";
  private ambient = true;
  private orbitPausedUntil = 0;
  private orbitTimer = 0;
  private bloom: UnrealBloomPass | null = null;
  private output: OutputPass | null = null;
  private resize: ResizeObserver;
  private disposed = false;
  private dataKey = "";
  private labels: CSS2DRenderer;
  private moreLabels = false;

  constructor(
    private container: HTMLElement,
    private hooks: EngineHooks,
  ) {
    this.palette = this.readTheme();
    this.labels = new CSS2DRenderer();
    this.labels.domElement.style.pointerEvents = "none";
    const g = new ForceGraph3D(container, { controlType: "orbit", extraRenderers: [this.labels as never] });
    this.graph = g;
    g.showNavInfo(false)
      .nodeLabel((n: object) => this.labelFor(n as CNode))
      .nodeThreeObject((n: object) => this.markFor(n as CNode).mesh)
      .nodeThreeObjectExtend(false)
      // The links are drawn by one LineSegments object of this class, because 5,000 separate line objects cost
      // about 5,000 draw calls. The library keeps the link objects, which the particles need.
      .linkVisibility(false)
      .linkOpacity(0.3)
      .linkDirectionalParticles(0)
      .linkDirectionalParticleWidth(1.6)
      .linkDirectionalParticleSpeed(0.012)
      .linkDirectionalParticleColor(() => this.css(this.palette.signal))
      .warmupTicks(80)
      .cooldownTicks(300)
      .enableNodeDrag(false)
      .onNodeClick((n: object) => {
        const id = (n as CNode).id;
        this.hooks.onSelect(id);
        this.focus(id);
      })
      .onBackgroundClick(() => this.hooks.onSelect(null))
      .onNodeHover((n: object | null) => {
        container.style.cursor = n ? "pointer" : "";
      })
      .onEngineTick(() => {
        this.syncLines();
        this.syncSelection();
      })
      .onEngineStop(() => {
        this.syncLines();
        rememberPositions(this.positions, this.current);
      });

    // The d3 forces: a weak charge for a graph of this size, and a pull towards the anchor of each family.
    const charge = g.d3Force("charge") as {
      strength?: (v: number | ((n: object) => number)) => unknown;
      distanceMax?: (v: number) => unknown;
    } | undefined;
    // The labelled hubs (task types and agents) repel more strongly, so that they spread apart and their labels can be
    // read; every other node keeps the weak charge that suits a graph of this size.
    charge?.strength?.((n: object) => (HUB_TYPES.has((n as CNode).gn?.type) ? -160 : -14));
    charge?.distanceMax?.(220);
    const link = g.d3Force("link") as { distance?: (v: number) => unknown } | undefined;
    link?.distance?.(26);
    g.d3Force("anchor", anchorForce(familyAnchors()) as never);

    this.lines = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: this.palette.dark ? 0.3 : 0.6, depthWrite: false }),
    );
    this.lines.frustumCulled = false;
    this.lines.renderOrder = -1;
    g.scene().add(this.lines);
    this.proposedLines = new LineSegments(
      new BufferGeometry(),
      new LineDashedMaterial({ vertexColors: true, transparent: true, opacity: this.palette.dark ? 0.2 : 0.4, depthWrite: false, dashSize: 1.2, gapSize: 1 }),
    );
    this.proposedLines.frustumCulled = false;
    this.proposedLines.renderOrder = -1;
    g.scene().add(this.proposedLines);

    // Selection ring, drawn only while a node is selected.
    this.selRing = new Mesh(
      this.geometry,
      new MeshBasicMaterial({ color: this.css(this.palette.signal), wireframe: true, transparent: true, opacity: 0.85 }),
    );
    this.selRing.visible = false;
    g.scene().add(this.selRing);

    const controls = g.controls() as OrbitLike;
    controls.autoRotateSpeed = orbitSpeed();
    this.applyOrbit();
    container.addEventListener("pointermove", this.onPointer);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.applyBloom();
    this.applyBackground();
  }

  // ------------------------------------------------------------------ theme

  private readTheme(): Palette {
    return readPalette(token, document.documentElement.dataset.theme !== "light");
  }

  private css(rgb: [number, number, number]): string {
    const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    return `rgb(${c(rgb[0])}, ${c(rgb[1])}, ${c(rgb[2])})`;
  }

  /** The background is the void token. A scene background is set in the working colour space, so the bloom and output passes show it unchanged. */
  private applyBackground(): void {
    this.graph.scene().background = new Color().setRGB(...this.palette.void, SRGBColorSpace);
  }

  /** Read the tokens again after a theme change and repaint every mark. */
  refreshTheme(): void {
    this.palette = this.readTheme();
    (this.lines.material as LineBasicMaterial).opacity = this.palette.dark ? 0.3 : 0.6;
    (this.proposedLines.material as LineDashedMaterial).opacity = this.palette.dark ? 0.2 : 0.4;
    this.graph.linkDirectionalParticleColor(() => this.css(this.palette.signal));
    (this.selRing.material as MeshBasicMaterial).color.setRGB(...this.palette.signal);
    this.applyBloom();
    this.applyBackground();
    this.paintAll();
    this.paintLines();
  }

  private applyBloom(): void {
    const dark = this.palette.dark;
    const composer = this.graph.postProcessingComposer();
    if (dark && !this.bloom) {
      const size = new Vector2(this.container.clientWidth || 1, this.container.clientHeight || 1);
      // The threshold lets a node used often and recently glow softly at rest (its resting brightness rises with its
      // base-level heat), while a firing node, whose brightness is boosted, blooms strongly.
      this.bloom = new UnrealBloomPass(size, 1.15, 0.6, 0.5);
      this.output = new OutputPass();
      composer.addPass(this.bloom);
      composer.addPass(this.output);
    }
    if (this.bloom) this.bloom.enabled = dark;
    if (this.output) this.output.enabled = dark;
  }

  // ------------------------------------------------------------------- data

  /** Replace the data. Nodes keep their objects, and so their positions, when the same id comes back. */
  setData(graph: GraphFile, view: EngineView): void {
    this.sizeBy = view.sizeBy;
    const key = `${graph.built}|${graph.nodes.length}|${graph.edges.length}|${view.cap}|${view.showProposed ? "p" : "-"}|${Object.entries(view.families).filter(([, v]) => v).map(([k]) => k).join(",")}`;
    if (key === this.dataKey) {
      this.paintAll();
      return;
    }
    this.dataKey = key;
    rememberPositions(this.positions, this.current);

    const all = new Set(graph.nodes.map((n) => n.id));
    for (const [id, m] of this.marks) {
      if (!all.has(id)) {
        m.mat.dispose();
        this.marks.delete(id);
        this.nodeObjs.delete(id);
        this.positions.delete(id);
      }
    }

    const shownNodes = filterNodes(graph.nodes, view);
    const shown = new Set(shownNodes.map((n) => n.id));
    const edges = filterEdges(graph.edges, shown).filter((e) => view.showProposed || e.provenance !== "proposed");

    this.current = shownNodes.map((gn) => {
      let c = this.nodeObjs.get(gn.id);
      if (!c) {
        c = { id: gn.id, family: gn.family, gn };
        restorePosition(this.positions, gn.id, c);
        this.nodeObjs.set(gn.id, c);
      } else {
        c.gn = gn;
        c.family = gn.family;
      }
      this.markFor(c);
      return c;
    });

    this.linkIndex.clear();
    this.pairs = [];
    this.proposedPairs = [];
    const links: CLink[] = edges.map((e) => {
      const l: CLink = { source: e.s, target: e.t, rel: e.r };
      this.linkIndex.set(`${e.s}|${e.t}`, l);
      if (!this.linkIndex.has(`${e.t}|${e.s}`)) this.linkIndex.set(`${e.t}|${e.s}`, l);
      (e.provenance === "proposed" ? this.proposedPairs : this.pairs).push({ a: this.nodeObjs.get(e.s)!, b: this.nodeObjs.get(e.t)! });
      return l;
    });
    this.graph.graphData({ nodes: this.current, links } as never);
    this.buildLines();
    this.syncSelection();
  }

  setSizeBy(sizeBy: "heat" | "degree"): void {
    if (sizeBy === this.sizeBy) return;
    this.sizeBy = sizeBy;
    for (const c of this.current) this.markFor(c);
    this.paintAll();
  }

  private markFor(c: CNode): Mark {
    const radius = nodeRadius(c.gn, this.sizeBy);
    const heat = heatOfNode(c.gn);
    let m = this.marks.get(c.id);
    if (!m) {
      const mat = new MeshBasicMaterial();
      const mesh = new Mesh(this.geometry, mat);
      m = { mesh, mat, radius, heat, label: null };
      this.marks.set(c.id, m);
      this.paint(c.id, m, c.family);
    } else {
      m.radius = radius;
      m.heat = heat;
    }
    this.syncLabel(c, m);
    return m;
  }

  /** Add or remove the label of a node, as its class and the labels setting require. */
  private syncLabel(c: CNode, m: Mark): void {
    const want = LANDMARKS.has(c.gn.type) || (this.moreLabels && MORE_LABELS.has(c.gn.type));
    if (want && !m.label) {
      const el = document.createElement("div");
      el.className = "cx-node-label";
      el.textContent = shortLabel(c.gn);
      const obj = new CSS2DObject(el);
      obj.position.set(0, 1.9, 0);
      m.mesh.add(obj);
      m.label = el;
    } else if (!want && m.label) {
      const obj = m.mesh.children.find((ch) => ch instanceof CSS2DObject);
      if (obj) m.mesh.remove(obj);
      m.label.remove();
      m.label = null;
    }
  }

  /** Label the reference files, guides, projects, clients and schemes as well as the landmarks. */
  setMoreLabels(on: boolean): void {
    if (on === this.moreLabels) return;
    this.moreLabels = on;
    for (const c of this.current) {
      const m = this.marks.get(c.id);
      if (m) this.syncLabel(c, m);
    }
  }

  private paint(id: string, m: Mark, family: Family): void {
    const g = this.tracker.glow(id);
    const reduced = reducedMotion();
    const f = boost(g);
    const dim = this.highlight && !this.highlight.has(id) ? DIM : 1;
    const level = restingBrightness(m.heat) * f * dim;
    m.mat.color.setRGB(...shade(this.palette.families[family], this.palette.void, level));
    m.mesh.scale.setScalar(m.radius * (reduced ? 1 : f));
    if (m.label) {
      m.label.dataset.glow = g > 0.05 ? "on" : "off";
      m.label.style.opacity = String(dim < 1 ? 0.2 : 0.62 + 0.38 * Math.min(1, g));
    }
  }

  private paintAll(): void {
    for (const c of this.current) {
      const m = this.marks.get(c.id);
      if (m) this.paint(c.id, m, c.family);
    }
  }

  /** One vertex pair for each link, with vertex colours that dim a link unless both ends are highlighted. */
  private buildLines(): void {
    for (const [lines, pairs] of this.lineSets()) {
      const n = pairs.length;
      const geo = new BufferGeometry();
      geo.setAttribute("position", new BufferAttribute(new Float32Array(n * 6), 3));
      geo.setAttribute("color", new BufferAttribute(new Float32Array(n * 6), 3));
      lines.geometry.dispose();
      lines.geometry = geo;
    }
    this.syncLines();
    this.paintLines();
  }

  private lineSets(): [LineSegments, { a: CNode; b: CNode }[]][] {
    return [
      [this.lines, this.pairs],
      [this.proposedLines, this.proposedPairs],
    ];
  }

  private syncLines(): void {
    for (const [lines, pairs] of this.lineSets()) {
      const attr = lines.geometry.getAttribute("position") as BufferAttribute | undefined;
      if (!attr) continue;
      const a = attr.array as Float32Array;
      let i = 0;
      for (const { a: p, b: q } of pairs) {
        a[i++] = p.x ?? 0;
        a[i++] = p.y ?? 0;
        a[i++] = p.z ?? 0;
        a[i++] = q.x ?? 0;
        a[i++] = q.y ?? 0;
        a[i++] = q.z ?? 0;
      }
      attr.needsUpdate = true;
      if (lines === this.proposedLines && pairs.length) lines.computeLineDistances();
    }
  }

  private paintLines(): void {
    const rule = new Color().setRGB(...this.palette.ruleStrong, SRGBColorSpace);
    const off = new Color().setRGB(...this.palette.void, SRGBColorSpace);
    for (const [lines, pairs] of this.lineSets()) {
      const attr = lines.geometry.getAttribute("color") as BufferAttribute | undefined;
      if (!attr) continue;
      const a = attr.array as Float32Array;
      let i = 0;
      for (const { a: p, b: q } of pairs) {
        const on = !this.highlight || (this.highlight.has(p.id) && this.highlight.has(q.id));
        const c = on ? rule : off;
        for (let k = 0; k < 2; k += 1) {
          a[i++] = c.r;
          a[i++] = c.g;
          a[i++] = c.b;
        }
      }
      attr.needsUpdate = true;
    }
  }

  private labelFor(n: CNode): string {
    const gn = n.gn;
    const style = "color:var(--color-ink);font:13px/20px var(--font-sans)";
    return `<div style="${style}"><div style="font-weight:600">${escapeHtml(gn.label)}</div><div>${escapeHtml(gn.type)}</div><div style="font:12px/18px var(--font-mono)">${escapeHtml(gn.id)}</div></div>`;
  }

  // ----------------------------------------------------------------- firing

  /** Schedule the glows, particles and rings of one firing or preview. */
  fire(activation: Activation[], preview: boolean): void {
    if (this.disposed || document.hidden) return;
    const now = performance.now();
    for (const s of planFiring(activation, preview)) {
      if (this.marks.has(s.id)) this.pending.push({ ...s, due: now + s.at });
    }
    this.ensureLoop();
  }

  private ensureLoop(): void {
    if (this.raf || this.disposed || document.hidden) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.raf = 0;
    if (this.disposed || document.hidden) return;
    const dt = Math.min(100, Math.max(0, now - this.last));
    this.last = now;
    const reduced = reducedMotion();

    // start the entries that are due
    if (this.pending.length) {
      const rest: Pending[] = [];
      for (const p of this.pending) {
        if (p.due > now) {
          rest.push(p);
          continue;
        }
        this.tracker.add(p.id, p.a, p.halfLife);
        if (!reduced) {
          if (p.via) this.emitParticle(p.via, p.id);
          if (p.hop === 0) this.spawnRing(p.id, now);
        }
      }
      this.pending = rest;
    }

    // advance the glows and repaint only the nodes that glow, and those that just stopped
    const { active, ended } = this.tracker.step(dt);
    for (const id of active) this.repaint(id);
    for (const id of ended) this.repaint(id);

    this.stepRings(now);
    this.syncSelection();

    if (this.tracker.size > 0 || this.pending.length > 0 || this.rings.length > 0) {
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  private repaint(id: string): void {
    const c = this.nodeObjs.get(id);
    const m = this.marks.get(id);
    if (c && m) this.paint(id, m, c.family);
  }

  private emitParticle(via: string, id: string): void {
    const link = this.linkIndex.get(`${via}|${id}`);
    if (link) this.graph.emitParticle(link as never);
  }

  private spawnRing(id: string, now: number): void {
    const c = this.nodeObjs.get(id);
    if (!c || c.x === undefined) return;
    const mat = new MeshBasicMaterial({ color: this.css(this.palette.signal), transparent: true, opacity: 0.8, depthWrite: false });
    const mesh = new Mesh(this.geometry, mat);
    mesh.position.set(c.x, c.y ?? 0, c.z ?? 0);
    const base = this.marks.get(id)?.radius ?? 2;
    mesh.scale.setScalar(base);
    mesh.userData.base = base;
    this.graph.scene().add(mesh);
    this.rings.push({ mesh, mat, start: now });
  }

  private stepRings(now: number): void {
    if (!this.rings.length) return;
    this.rings = this.rings.filter((r) => {
      const s = ringState(now - r.start);
      if (!s) {
        this.graph.scene().remove(r.mesh);
        r.mat.dispose();
        return false;
      }
      const base = r.mesh.userData.base as number;
      r.mesh.scale.setScalar(base * s.scale);
      r.mat.opacity = s.opacity;
      return true;
    });
  }

  // -------------------------------------------------------------- selection

  setSelected(id: string | null): void {
    this.selected = id;
    this.syncSelection();
    if (id) this.pauseOrbit();
    this.applyOrbit();
  }

  private syncSelection(): void {
    const c = this.selected ? this.nodeObjs.get(this.selected) : undefined;
    if (!c || c.x === undefined || !this.current.includes(c)) {
      this.selRing.visible = false;
      return;
    }
    this.selRing.visible = true;
    this.selRing.position.set(c.x, c.y ?? 0, c.z ?? 0);
    this.selRing.scale.setScalar((this.marks.get(c.id)?.radius ?? 2) * 1.9);
  }

  /** Dim every node outside the list to 15 %, until the list is empty. */
  setHighlight(ids: string[]): void {
    this.highlight = ids.length ? new Set(ids) : null;
    this.paintLines();
    this.paintAll();
  }

  focus(id: string): void {
    const c = this.nodeObjs.get(id);
    if (!c || c.x === undefined || !this.current.includes(c)) return;
    const x = c.x;
    const y = c.y ?? 0;
    const z = c.z ?? 0;
    const len = Math.hypot(x, y, z) || 1;
    const k = 1 + 110 / len;
    this.graph.cameraPosition({ x: x * k, y: y * k, z: z * k }, { x, y, z }, FOCUS_MS);
    this.pauseOrbit();
  }

  // ------------------------------------------------------------------ orbit

  setAmbient(on: boolean): void {
    this.ambient = on;
    this.applyOrbit();
  }

  private applyOrbit(): void {
    const controls = this.graph.controls() as OrbitLike;
    controls.autoRotate = this.ambient && !this.selected && !reducedMotion() && performance.now() >= this.orbitPausedUntil;
  }

  private pauseOrbit(): void {
    this.orbitPausedUntil = performance.now() + ORBIT_PAUSE_MS;
    (this.graph.controls() as OrbitLike).autoRotate = false;
    window.clearTimeout(this.orbitTimer);
    this.orbitTimer = window.setTimeout(() => this.applyOrbit(), ORBIT_PAUSE_MS + 50);
  }

  private onPointer = (): void => {
    // Throttled by the check: the timer is reset at most once a second.
    const now = performance.now();
    if (this.orbitPausedUntil - now > ORBIT_PAUSE_MS - 1000) return;
    this.pauseOrbit();
  };

  // ----------------------------------------------------------- housekeeping

  private fit(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w > 0 && h > 0) {
      this.graph.width(w).height(h);
      this.bloom?.setSize(w, h);
      this.labels.setSize(w, h);
    }
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      this.hiddenAt = performance.now();
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.graph.pauseAnimation();
    } else {
      const gap = performance.now() - this.hiddenAt;
      for (const p of this.pending) p.due += gap;
      this.graph.resumeAnimation();
      if (this.tracker.size > 0 || this.pending.length > 0 || this.rings.length > 0) this.ensureLoop();
    }
  };

  /** The frame rate of the canvas, measured over a given time. Used by the performance check only. */
  measureFps(ms: number): Promise<number> {
    return new Promise((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      const tick = (t: number) => {
        frames += 1;
        if (t - t0 >= ms) resolve((frames * 1000) / (t - t0));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  get shownCount(): { nodes: number; links: number } {
    return { nodes: this.current.length, links: this.linkIndex.size / 2 };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    window.clearTimeout(this.orbitTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.container.removeEventListener("pointermove", this.onPointer);
    this.resize.disconnect();
    for (const r of this.rings) {
      this.graph.scene().remove(r.mesh);
      r.mat.dispose();
    }
    this.rings = [];
    for (const m of this.marks.values()) {
      m.mat.dispose();
      m.label?.remove();
    }
    this.marks.clear();
    this.labels.domElement.remove();
    this.geometry.dispose();
    this.lines.geometry.dispose();
    (this.lines.material as LineBasicMaterial).dispose();
    this.proposedLines.geometry.dispose();
    (this.proposedLines.material as LineDashedMaterial).dispose();
    (this.selRing.material as MeshBasicMaterial).dispose();
    this.bloom?.dispose();
    this.output?.dispose();
    const renderer = this.graph.renderer();
    this.graph._destructor();
    renderer.dispose();
    this.container.replaceChildren();
  }
}
