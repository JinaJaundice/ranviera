// The drawing of the traced path (docs/BRAIN.md, "Revision of 13 October 2026: the traced path"). The line is Line2 of three.js,
// whose width is in pixels and does not change with zoom, with the arc length of each piece added so that one uniform clips
// the line at the head. A casing of the colour of the background is drawn first, so that the line stays distinct from the
// neurons in both themes. Branches, stubs and the previous path are lines of their own, and the knots and the head are sprites.
// The geometry and the head come from path.ts, and the scene (BrainEngine) decides when to draw what.
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedBufferAttribute,
  Points,
  SRGBColorSpace,
  ShaderMaterial,
  Vector2,
  Vector4,
} from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { REGION_IDS, type RegionId } from "@shared/brain";
import type { Rgb } from "../palette";
import { shade } from "../palette";
import {
  BRANCH_KNOT_PX,
  KNOT_PX,
  PATH_BRANCH_OPACITY,
  PATH_BRANCH_PX,
  PATH_CASING_EXTRA_PX,
  PATH_CASING_OPACITY,
  PATH_COMET_UNITS,
  PATH_DASH_PX,
  PATH_DOT_PX,
  PATH_FAR_OPACITY,
  PATH_HEAD_PX,
  PATH_HEAD_SPRITE_PX,
  PATH_PREVIOUS_OPACITY,
  PATH_PREVIOUS_PX,
  PATH_TRAIL_OPACITY,
  PATH_TRAIL_PX,
  PATH_UNSELECTED_OPACITY,
  PATH_INNER_OPACITY,
} from "./look";
import type { PathGeometry, V3 } from "./path";
import { patchLineFragment, patchLineVertex, SPRITE_FRAGMENT, SPRITE_VERTEX } from "./shaders";

/** The colours that the path draws with, read from the tokens of the theme. */
export interface PathColours {
  regions: Record<RegionId, Rgb>;
  void: Rgb;
  faint: Rgb;
  block: Rgb;
  hold: Rgb;
  dark: boolean;
}

/** What the scene tells the layer in each frame. */
export interface PathFrame {
  /** the arc length of the head, and -1 before the first step */
  arc: number;
  /** the progress value (the step number plus the fraction of the step) */
  progress: number;
  /** the arc range of the selected step, or null */
  selected: { a: number; b: number } | null;
  /** the step whose branches are drawn in full: the one that plays or is selected */
  activeStep: number;
  /** the distance of the camera from the point that it looks at, for the far side of the brain */
  centre: number;
  /** scene units to a pixel on the screen at that distance, which sets the length of the dashes and dots of a segment */
  unit: number;
  /** the head: its place, its region, and whether it moves */
  head: { pos: V3 | null; region: RegionId | null; moving: boolean };
  /** the clock in milliseconds, for the ring of a head at rest */
  now: number;
  /** reduced motion draws no ring */
  reduced: boolean;
}

const linear = (rgb: Rgb): Color => new Color().setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);

interface LineOptions {
  width: number;
  colored: boolean;
  opacity: number;
  clip: boolean;
  /** how much wider the line grows under the head and on a selected step */
  wide: number;
  dashed?: boolean;
  trail?: number;
  dim?: number;
}

function lineMaterial(o: LineOptions): LineMaterial {
  const m = new LineMaterial({ linewidth: o.width, vertexColors: o.colored, transparent: true, opacity: o.opacity, depthTest: false, depthWrite: false, dashed: !!o.dashed, dashSize: 3, gapSize: 2.4 });
  m.vertexShader = patchLineVertex(m.vertexShader);
  m.fragmentShader = patchLineFragment(m.fragmentShader);
  const u = m.uniforms;
  u.uHead = { value: -1 };
  u.uComet = { value: PATH_COMET_UNITS };
  u.uWide = { value: o.wide };
  u.uSelA = { value: 0 };
  u.uSelB = { value: 0 };
  u.uSelOn = { value: 0 };
  u.uClip = { value: o.clip ? 1 : 0 };
  u.uTrail = { value: o.trail ?? PATH_TRAIL_OPACITY };
  u.uDim = { value: o.dim ?? PATH_UNSELECTED_OPACITY };
  u.uInner = { value: PATH_INNER_OPACITY };
  u.uFar = { value: PATH_FAR_OPACITY };
  u.uCentre = { value: 306 };
  u.uBoost = { value: 0 };
  u.uUnit = { value: 0.2 };
  u.uPattern = { value: new Vector4(PATH_DASH_PX.on, PATH_DASH_PX.period, PATH_DOT_PX.on, PATH_DOT_PX.period) };
  return m;
}

function lineGeometry(ends: Float32Array, arcs: Float32Array, colours: Float32Array | null, dashed: boolean, styles?: Uint8Array, inner?: Uint8Array): LineSegmentsGeometry {
  const g = new LineSegmentsGeometry();
  g.setPositions(ends);
  if (colours) g.setColors(colours);
  g.setAttribute("instanceArc", new InstancedBufferAttribute(arcs, 2));
  // the style of each piece: 0 solid, 1 dashed, 2 dotted
  g.setAttribute("instanceStyle", new InstancedBufferAttribute(styles ? Float32Array.from(styles) : new Float32Array(arcs.length / 2), 1));
  // 1 where the piece joins 2 nodes of one step, which the fragment shader draws faint unless the step plays or is chosen
  g.setAttribute("instanceInner", new InstancedBufferAttribute(inner ? Float32Array.from(inner) : new Float32Array(arcs.length / 2), 1));
  g.instanceCount = arcs.length / 2;
  if (dashed) new LineSegments2(g).computeLineDistances();
  return g;
}

function spriteMaterial(ratio: number): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: SPRITE_VERTEX,
    fragmentShader: SPRITE_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: { uRatio: { value: ratio }, uProgress: { value: 0 }, uBloom: { value: 1 }, uEdge: { value: new Color(0, 0, 0) } },
  });
}

interface SpriteSet {
  pos: number[];
  col: number[];
  size: number[];
  alpha: number[];
  kind: number[];
  at: number[];
}

const emptySprites = (): SpriteSet => ({ pos: [], col: [], size: [], alpha: [], kind: [], at: [] });

function spriteGeometry(s: SpriteSet): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(Float32Array.from(s.pos), 3));
  g.setAttribute("aColor", new BufferAttribute(Float32Array.from(s.col), 3));
  g.setAttribute("aSize", new BufferAttribute(Float32Array.from(s.size), 1));
  g.setAttribute("aAlpha", new BufferAttribute(Float32Array.from(s.alpha), 1));
  g.setAttribute("aKind", new BufferAttribute(Float32Array.from(s.kind), 1));
  g.setAttribute("aAt", new BufferAttribute(Float32Array.from(s.at), 1));
  g.setDrawRange(0, s.size.length);
  return g;
}

export class PathLayer {
  readonly group = new Group();
  private colours: PathColours;
  private geo: PathGeometry | null = null;
  private previous: PathGeometry | null = null;
  private dashed = false;
  private res = new Vector2(1, 1);

  private casing: LineSegments2;
  private line: LineSegments2;
  private branches: LineSegments2;
  private stubs: LineSegments2;
  private prev: LineSegments2;
  private knots: Points;
  private prevDots: Points;
  private head: Points;
  private sprite: ShaderMaterial;
  private branchActive = -1;
  private stubOrder: number[] = [];

  constructor(colours: PathColours, ratio: number) {
    this.colours = colours;
    this.sprite = spriteMaterial(ratio);
    const empty = () => new LineSegmentsGeometry();
    this.casing = new LineSegments2(empty(), lineMaterial({ width: PATH_TRAIL_PX + PATH_CASING_EXTRA_PX, colored: false, opacity: PATH_CASING_OPACITY, clip: true, wide: (PATH_HEAD_PX + PATH_CASING_EXTRA_PX) / (PATH_TRAIL_PX + PATH_CASING_EXTRA_PX), trail: 1, dim: 0.6 }));
    this.line = new LineSegments2(empty(), lineMaterial({ width: PATH_TRAIL_PX, colored: true, opacity: 1, clip: true, wide: PATH_HEAD_PX / PATH_TRAIL_PX }));
    this.branches = new LineSegments2(empty(), lineMaterial({ width: PATH_BRANCH_PX, colored: true, opacity: PATH_BRANCH_OPACITY, clip: false, wide: 1, trail: 1 }));
    this.stubs = new LineSegments2(empty(), lineMaterial({ width: 2, colored: true, opacity: 0.9, clip: false, wide: 1, trail: 1, dashed: true }));
    this.prev = new LineSegments2(empty(), lineMaterial({ width: PATH_PREVIOUS_PX, colored: false, opacity: PATH_PREVIOUS_OPACITY, clip: false, wide: 1, trail: 1 }));
    this.knots = new Points(new BufferGeometry(), this.sprite);
    this.prevDots = new Points(new BufferGeometry(), this.sprite);
    this.head = new Points(this.headGeometry(), this.sprite);
    const order: [LineSegments2 | Points, number][] = [
      [this.prev, 3.9],
      [this.casing, 4.0],
      [this.branches, 4.05],
      [this.line, 4.1],
      [this.stubs, 4.15],
      [this.prevDots, 4.2],
      [this.knots, 4.3],
      [this.head, 6],
    ];
    for (const [o, r] of order) {
      o.frustumCulled = false;
      o.renderOrder = r;
      o.visible = false;
      this.group.add(o);
    }
    this.applyColours();
  }

  private headGeometry(): BufferGeometry {
    const s = emptySprites();
    for (const kind of [0, 2]) {
      s.pos.push(0, 0, 0);
      s.col.push(1, 1, 1);
      s.size.push(PATH_HEAD_SPRITE_PX);
      s.alpha.push(0);
      s.kind.push(kind);
      s.at.push(0);
    }
    const g = spriteGeometry(s);
    for (const name of ["position", "aColor", "aSize", "aAlpha"]) (g.getAttribute(name) as BufferAttribute).setUsage(35048);
    return g;
  }

  setResolution(w: number, h: number, ratio: number): void {
    this.res.set(w, h);
    for (const l of [this.casing, this.line, this.branches, this.stubs, this.prev]) (l.material as LineMaterial).resolution.set(w, h);
    this.sprite.uniforms.uRatio.value = ratio;
  }

  setColours(c: PathColours): void {
    this.colours = c;
    this.applyColours();
    if (this.geo) this.build();
    if (this.previous) this.buildPrevious();
  }

  private applyColours(): void {
    const c = this.colours;
    (this.casing.material as LineMaterial).color.copy(linear(c.void));
    (this.prev.material as LineMaterial).color.copy(linear(c.faint));
    (this.sprite.uniforms.uEdge.value as Color).copy(linear(c.void));
    this.sprite.uniforms.uBloom.value = c.dark ? 1 : 0;
    for (const l of [this.line, this.branches, this.stubs]) (l.material as LineMaterial).uniforms.uBoost.value = l === this.line && c.dark ? 1.1 : 0;
  }

  /** Replace the path that is drawn. A null path hides the layer. `dashed` draws a plan, which is a prediction, with a dashed line. */
  setGeometry(geo: PathGeometry | null, dashed = false): void {
    this.geo = geo;
    this.dashed = dashed;
    (this.line.material as LineMaterial).dashed = dashed;
    this.branchActive = -1;
    this.build();
  }

  setPrevious(geo: PathGeometry | null): void {
    this.previous = geo;
    this.buildPrevious();
  }

  private build(): void {
    const g = this.geo;
    const show = !!g && g.line.count + g.waypoints.length > 0;
    for (const o of [this.casing, this.line, this.branches, this.stubs, this.knots, this.head]) o.visible = show;
    if (!g || !show) return;
    const c = this.colours;
    const n = g.line.count;
    const cols = new Float32Array(n * 6);
    const rgb = REGION_IDS.map((id) => linear(c.regions[id]));
    for (let i = 0; i < n; i += 1) {
      const idx = g.line.region[i];
      const col = idx === 255 ? rgb[0] : rgb[idx];
      cols[i * 6] = cols[i * 6 + 3] = col.r;
      cols[i * 6 + 1] = cols[i * 6 + 4] = col.g;
      cols[i * 6 + 2] = cols[i * 6 + 5] = col.b;
    }
    this.swap(this.line, n ? lineGeometry(g.line.ends, g.line.arcs, cols, this.dashed, g.line.style, g.line.inner) : new LineSegmentsGeometry());
    this.swap(this.casing, n ? lineGeometry(g.line.ends, g.line.arcs, null, this.dashed, g.line.style, g.line.inner) : new LineSegmentsGeometry());
    for (const l of [this.casing, this.line]) l.visible = n > 0;

    // branches: each branch is a short curve of several pieces, ordered by the progress at which it starts to grow
    const bs = g.branches;
    const per = bs[0] ? bs[0].points.length - 1 : 0;
    const ends = new Float32Array(bs.length * per * 6);
    const arcs = new Float32Array(bs.length * per * 2);
    bs.forEach((b, i) => {
      for (let j = 0; j < per; j += 1) {
        const a = b.points[j];
        const z = b.points[j + 1];
        ends.set([a.x, a.y, a.z, z.x, z.y, z.z], (i * per + j) * 6);
      }
    });
    this.swap(this.branches, bs.length ? lineGeometry(ends, arcs, new Float32Array(bs.length * per * 6), false) : new LineSegmentsGeometry());
    this.branches.visible = bs.length > 0;
    this.paintBranches(0);

    // stubs of a missing link, one piece each, in the order of the progress at which they appear
    const order = g.stubs.map((_, i) => i).sort((p, q) => g.stubs[p].at - g.stubs[q].at);
    this.stubOrder = order;
    const sEnds = new Float32Array(order.length * 6);
    const sCols = new Float32Array(order.length * 6);
    order.forEach((idx, i) => {
      const s = g.stubs[idx];
      sEnds.set([s.from.x, s.from.y, s.from.z, s.to.x, s.to.y, s.to.z], i * 6);
      const col = linear(s.tone === "hold" ? c.hold : c.block);
      sCols.set([col.r, col.g, col.b, col.r, col.g, col.b], i * 6);
    });
    this.swap(this.stubs, order.length ? lineGeometry(sEnds, new Float32Array(order.length * 2), sCols, true) : new LineSegmentsGeometry());
    this.stubs.visible = order.length > 0;

    // knots: the further nodes of hop 0, the ends of the branches and the hollow ends of the stubs
    const sp = emptySprites();
    const put = (p: V3, col: Color, size: number, kind: number, at: number) => {
      sp.pos.push(p.x, p.y, p.z);
      sp.col.push(col.r, col.g, col.b);
      sp.size.push(size);
      sp.alpha.push(1);
      sp.kind.push(kind);
      sp.at.push(at);
    };
    for (const k of g.knots) put(k.pos, rgb[REGION_IDS.indexOf(k.region)], KNOT_PX, 1, k.at);
    for (const b of g.branches) put(b.tip, rgb[REGION_IDS.indexOf(b.region)], b.crowded ? BRANCH_KNOT_PX - 1 : BRANCH_KNOT_PX, 1, b.at + 0.2 / 4);
    for (const s of g.stubs) put(s.to, linear(s.tone === "hold" ? c.hold : c.block), KNOT_PX + 2, 3, s.at);
    this.knots.geometry.dispose();
    this.knots.geometry = spriteGeometry(sp);
  }

  private buildPrevious(): void {
    const g = this.previous;
    const show = !!g && g.line.count > 0;
    this.prev.visible = show;
    this.prevDots.visible = !!g;
    if (!g) return;
    if (show) this.swap(this.prev, lineGeometry(g.line.ends, g.line.arcs, null, false));
    const sp = emptySprites();
    const col = linear(this.colours.faint);
    for (const w of g.waypoints) {
      sp.pos.push(w.pos.x, w.pos.y, w.pos.z);
      sp.col.push(col.r, col.g, col.b);
      sp.size.push(5);
      sp.alpha.push(0.5);
      sp.kind.push(1);
      sp.at.push(0);
    }
    this.prevDots.geometry.dispose();
    this.prevDots.geometry = spriteGeometry(sp);
  }

  private swap(l: LineSegments2, g: LineSegmentsGeometry): void {
    l.geometry.dispose();
    l.geometry = g;
  }

  /** Draw the branches of one step in full and the others at half strength, by mixing their colour towards the background. */
  private paintBranches(active: number): void {
    const g = this.geo;
    if (!g || !g.branches.length) return;
    this.branchActive = active;
    const per = g.branches[0].points.length - 1;
    const cols = new Float32Array(g.branches.length * per * 6);
    g.branches.forEach((b, i) => {
      const full = linear(this.colours.regions[b.region]);
      // the branches of a crowded step are fainter, so that the main line stays the clearest thing on the canvas
      const quiet = linear(shade(this.colours.regions[b.region], this.colours.void, b.crowded ? 0.3 : 0.5));
      const faint = linear(shade(this.colours.regions[b.region], this.colours.void, 0.45));
      const col = b.step === active ? (b.crowded ? faint : full) : quiet;
      for (let j = 0; j < per; j += 1) cols.set([col.r, col.g, col.b, col.r, col.g, col.b], (i * per + j) * 6);
    });
    this.branches.geometry.setColors(cols);
    this.branches.geometry.instanceCount = 0;
  }

  /** Update the uniforms, the head and the number of branches and stubs shown. Called once a frame, and allocates nothing. */
  update(f: PathFrame): void {
    const g = this.geo;
    if (!g) return;
    for (const l of [this.casing, this.line]) {
      const u = (l.material as LineMaterial).uniforms;
      u.uHead.value = f.arc;
      u.uCentre.value = f.centre;
      u.uUnit.value = f.unit;
      u.uSelOn.value = f.selected ? 1 : 0;
      if (f.selected) {
        u.uSelA.value = f.selected.a;
        u.uSelB.value = f.selected.b;
      }
    }
    for (const l of [this.branches, this.stubs]) (l.material as LineMaterial).uniforms.uCentre.value = f.centre;
    this.sprite.uniforms.uProgress.value = f.progress;
    if (f.activeStep !== this.branchActive) this.paintBranches(f.activeStep);
    // the branches that have started to grow, and the stubs that have appeared, are a prefix of the instances
    const per = g.branches[0] ? g.branches[0].points.length - 1 : 0;
    let b = 0;
    while (b < g.branches.length && g.branches[b].at <= f.progress + 1e-9) b += 1;
    if (this.branches.geometry.instanceCount !== b * per) this.branches.geometry.instanceCount = b * per;
    let s = 0;
    while (s < this.stubOrder.length && g.stubs[this.stubOrder[s]].at <= f.progress + 1e-9) s += 1;
    if (this.stubs.geometry.instanceCount !== s) this.stubs.geometry.instanceCount = s;

    // the head and its ring
    const geo = this.head.geometry;
    const pos = (geo.getAttribute("position") as BufferAttribute).array as Float32Array;
    const col = (geo.getAttribute("aColor") as BufferAttribute).array as Float32Array;
    const size = (geo.getAttribute("aSize") as BufferAttribute).array as Float32Array;
    const alpha = (geo.getAttribute("aAlpha") as BufferAttribute).array as Float32Array;
    const h = f.head;
    if (h.pos && h.region) {
      const c = linear(this.colours.regions[h.region]);
      for (let k = 0; k < 2; k += 1) {
        pos[k * 3] = h.pos.x;
        pos[k * 3 + 1] = h.pos.y;
        pos[k * 3 + 2] = h.pos.z;
        col[k * 3] = c.r;
        col[k * 3 + 1] = c.g;
        col[k * 3 + 2] = c.b;
      }
      alpha[0] = 1;
      size[0] = PATH_HEAD_SPRITE_PX;
      // a head at rest has a slow ring, and reduced motion draws none
      const phase = (f.now % 1800) / 1800;
      alpha[1] = h.moving || f.reduced ? 0 : 0.85 * (1 - phase);
      size[1] = PATH_HEAD_SPRITE_PX * (1.3 + 1.6 * phase);
    } else {
      alpha[0] = 0;
      alpha[1] = 0;
    }
    for (const name of ["position", "aColor", "aSize", "aAlpha"]) (geo.getAttribute(name) as BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    for (const l of [this.casing, this.line, this.branches, this.stubs, this.prev]) {
      l.geometry.dispose();
      (l.material as LineMaterial).dispose();
    }
    for (const p of [this.knots, this.prevDots, this.head]) p.geometry.dispose();
    this.sprite.dispose();
  }
}
