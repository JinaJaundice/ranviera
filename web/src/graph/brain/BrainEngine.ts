// The brain scene of the Graph window (docs/BRAIN.md). It has the public methods of GraphEngine, so that the bus events
// of the existing canvas light it, and adds focusRegion, setHiddenRegions, regionCounts and playStep.
//
// Everything is drawn by one WebGL renderer: one faint outer silhouette with a light tint for each region, one
// THREE.Points for all the neurons, one for the pulses and rings, and line segments for the links of the selected and
// hovered node. The labels are HTML over the canvas, placed by labelplace.ts: a caption for each region when the camera
// is far away, and the labels of the clusters of a region when the camera is close to it or the region is focused.
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  EqualDepth,
  FrontSide,
  LessEqualDepth,
  MOUSE,
  HalfFloatType,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Points,
  Quaternion,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  Spherical,
  Vector3,
  Vector2,
  WebGLRenderTarget,
  WebGLRenderer,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { Activation, GraphFile, GraphNode } from "@shared/types";
import { brainDomains } from "./trail";
import { REGIONS, REGION_IDS, clusterOf, regionOf, type RegionId } from "@shared/brain";
import { token } from "../../lib/theme";
import { GlowTracker, HALF_LIFE_MS, PREVIEW_HALF_LIFE_MS, orbitSpeed } from "../animate";
import { filterEdges, filterNodes, nodeRadius, type Vec3 } from "../layout";
import { heatOfNode, parseCssColor, readPalette, restingBrightness, shade, type Palette, type Rgb } from "../palette";
import { regionAnchors, type Anchor } from "./anchors";
import { loadBrainAsset, type BrainAsset } from "./asset";
import { EXPAND_ZOOM, expandKey, expandOffsets, type RegionCentre } from "./expand";
import { curvePoint, curveSegments } from "./curves";
import { convexHull, keepOutBoxes, layoutCallouts, layoutFocusCallout, type CalloutRequest, type PlacedCallout, type Pt } from "./callouts";
import { badgeInk, calloutRegions, FOCUS_FADE, PATH_HOVER_PLATES_MAX, HOP_PLATES_MAX, FOCUS_SHRINK, glowOf, PATH_BLOOM_MOVING, PATH_CALLOUT_VISITED, PATH_EASE_MS, PATH_END_EPS, PATH_FRAME_MARGIN, pathCalloutRegions, regionTint, STEP_LABELS_MAX } from "./look";
import { leaderEnd, placeLabels, type LabelRequest } from "./labelplace";
import { fitFocusFrame } from "./focusframe";
import { labelLevel, MAX_CLUSTER_LABELS, MAX_FOCUS_CLUSTER_LABELS, pickClusters } from "./lod";
import { placeNodes, type Placed } from "./placement";
import { MAX_NODE_LABELS, PULSE_MS, labelOrder, leadRegion, planStep, type Entry } from "./schedule";
import { FX_FRAGMENT, FX_VERTEX, NODE_FRAGMENT, NODE_VERTEX, SURFACE_FRAGMENT, SURFACE_VERTEX } from "./shaders";
import { anchorRegion, buildPath, orderPlatePicks, plateSentence, headArc, headRegion, hopLine, livePlatePicks, markerSpots, platePicks, pointAt, progressOf, routeRuns, stepOfProgress, volumeOf, type PathGeometry, type PathSub, type V3 } from "./path";
import { PathBadges, type MarkerSpot } from "./pathBadges";
import { fitPathCamera } from "./pathfit";
import { PathLayer, type PathColours } from "./pathLayer";
import { stepMs } from "./trail";
import { bus } from "../../lib/bus";
import type { BrainCommand, BrainHooks, BrainView, CanvasEngine, RegionEntry, TracePath, TrailStep } from "./types";

interface BNode {
  i: number;
  id: string;
  gn: GraphNode;
  region: RegionId;
  cluster: string;
  hemi: "L" | "R";
  /** where the model places the neuron, before Expand moves it */
  bx: number;
  by: number;
  bz: number;
  /** where it is drawn */
  x: number;
  y: number;
  z: number;
  radius: number;
  heat: number;
  visible: boolean;
}

interface Pending extends Entry {
  due: number;
  predicted: boolean;
}

interface Pulse {
  a: Vec3;
  b: Vec3;
  t0: number;
  region: RegionId;
  predicted: boolean;
}

interface Ring {
  at: Vec3;
  t0: number;
  base: number;
  region: RegionId;
  predicted: boolean;
}

interface Cluster {
  key: string;
  label: string;
  region: RegionId;
  count: number;
  /** the centre of its visible neurons */
  at: Vec3;
}

interface LabelRec {
  el: HTMLDivElement;
  w: number;
  h: number;
  used: boolean;
}

interface Tween {
  t0: number;
  dur: number;
  dir0: Vector3;
  dir1: Vector3;
  dist0: number;
  dist1: number;
  tgt0: Vector3;
  tgt1: Vector3;
}

// A neuron is a core of 5 to 16 pixels across at the default distance of the camera, by its size class and heat.
const NEURON_MIN_PX = 5;
const NEURON_MAX_PX = 16;
const REF_DISTANCE = 306;
// The farthest sample point of the model is 104 units from the centre, and the model reaches 100 units sideways and 92 up at most.
const BRAIN_RADIUS = 104;
const BRAIN_HALF_WIDTH = 100;
const BRAIN_HALF_HEIGHT = 92;
const FRAME_TOP = 44;
const FRAME_BOTTOM = 8;
/** the room beside the brain for a callout, past the width of its caption: the clearance and the leader line */
const CALLOUT_ROOM = 44;
const CALLOUT_FADE = 0.7;
const HOVER_GROW = 1.7;
const FAR_DIM = 0.55;
/** over a focus the tint of every other region falls to this share of its strength (the focused region to the second), and the neurons of the focused region grow */
const FOCUS_SURFACE = 0.6;
const FOCUS_OWN_SURFACE = 0.6;
const FOCUS_GROW = 1.25;
/** the nearest the camera comes to a focused region, and the room kept at the right edge for the control bar */
const FOCUS_MIN_DISTANCE = 80;
/** the clearance of the caption of a focused region from its neurons */
const FOCUS_CLEARANCE = 30;
/** In a focus a label keeps this far from the callout and its leader. */
const FOCUS_LABEL_CLEARANCE = 14;
const BAR_ROOM = 64;
const BLOOM_REST = 0.18;
const BLOOM_FIRING = 0.85;
const FX_MAX = 1400;
const LINK_SEGMENTS = 16;
const LINK_CAP = 700;
const RING_MS = 700;
const FOCUS_MS = 1100;
const ZOOM_MS = 380;
const MIN_DISTANCE = 80;
const MAX_DISTANCE = 820;
const TURN_STEP = (9 * Math.PI) / 180;
const EXPAND_MS = 260;
const ORBIT_PAUSE_MS = 20_000;
const STEP_LABEL_MS = 3600;
const START_POSITION = new Vector3(190, 95, 215);
// The distance of the camera for the four preset views and the direction that each looks from. The brain faces +Z, and its
// left hemisphere lies at +X (docs/BRAIN.md, "The brain model").
const PRESET_DISTANCE = 330;
const PRESETS: Record<string, Vector3> = {
  left: new Vector3(1, 0.04, 0),
  right: new Vector3(-1, 0.04, 0),
  top: new Vector3(0, 1, 0.02),
  front: new Vector3(0, 0.04, 1),
};
const LANDMARKS = new Set(["TaskType", "Agent", "MapFile", "RuleFile", "Skill", "OutputStyle", "ReferenceFile", "GuideFile", "Project", "Client", "ConceptScheme"]);


function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function shortLabel(gn: GraphNode): string {
  const file = gn.type === "RuleFile" || gn.type === "MapFile" || gn.type === "OutputStyle" || gn.type === "ReferenceFile" || gn.type === "GuideFile";
  const raw = file ? (gn.path ?? gn.label).split("/").pop() ?? gn.label : gn.label;
  return raw.length > 32 ? `${raw.slice(0, 31)}…` : raw;
}

function linear(rgb: Rgb): Color {
  return new Color().setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);
}

const ease = (u: number): number => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

export class BrainEngine implements CanvasEngine {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(38, 1, 1, 2400);
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private output: OutputPass;
  private overlay: HTMLDivElement;
  private svg: SVGSVGElement;
  private palette: Palette;
  private asset: BrainAsset | null = null;
  private pendingData: { graph: GraphFile; view: BrainView } | null = null;

  // the surfaces
  private surfaces = new Map<string, ShaderMaterial>();
  private surfaceMeshes: { mesh: Mesh; region: RegionId | "shell" }[] = [];
  private brainRoot: Object3D | null = null;

  // the nodes
  private nodes: BNode[] = [];
  private byId = new Map<string, BNode>();
  private placementKey = "";
  private placements = new Map<string, Placed>();
  private dataKey = "";
  private nodeGeo = new BufferGeometry();
  private nodeMat: ShaderMaterial;
  private nodePoints: Points;
  private clusters: Cluster[] = [];
  private anchors: Anchor[] = [];
  private focused: RegionId | null = null;
  private surface = 0.25;
  private expand = 0;
  private expandTarget = 0;
  private offsets = new Map<string, Vec3>();
  private centres: RegionCentre[] = [];
  private shifted: { node: Object3D; base: Vector3; key: string }[] = [];
  private captionsOn = true;
  private stepSet: Set<string> | null = null;
  private turnRest = { az: 0, pol: 0 };
  private pxPerUnit = 500;
  private screen = new Float32Array(0);
  private counts: Record<RegionId, number> = Object.fromEntries(REGION_IDS.map((r) => [r, 0])) as Record<RegionId, number>;
  private hidden = new Set<RegionId>();
  private sizeBy: "heat" | "degree" = "heat";
  private highlight: Set<string> | null = null;

  // the links of the selected and hovered node
  private adj = new Map<string, { s: string; t: string; proposed: boolean }[]>();
  private solid: LineSegments;
  private dashed: LineSegments;

  // firing
  private tracker = new GlowTracker();
  private regionGlow = new GlowTracker();
  private waiting: Pending[] = [];
  private pulses: Pulse[] = [];
  private rings: Ring[] = [];
  private fx: Points;
  private fxMat: ShaderMaterial;
  private markerMat: ShaderMaterial;
  private markers: Points;
  private stepLabels: { ids: string[]; until: number; region: RegionId | null } = { ids: [], until: 0, region: null };

  // the traced path (docs/BRAIN.md, 13 October 2026)
  private pathLayer: PathLayer;
  private pathBadges: PathBadges;
  private pathData: TracePath | null = null;
  private pathGeo: PathGeometry | null = null;
  private pathMarkers: MarkerSpot[] = [];
  private prevData: TracePath | null = null;
  private pathShowPrev = false;
  /** the step number plus the fraction of the step; 0 is before the first step and the number of steps plus 1 is the end */
  private pathProgress = 0;
  private pathAnim: { n: number; t0: number; ms: number } | null = null;
  private pathHeld = 0;
  private pathPlaying = true;
  private pathSpeed = 1;
  private pathFollow = true;
  private pathSelected: number | null = null;
  private pathWhole = false;
  private pathVisited = new Set<RegionId>();
  private pathVisitedArc = -2;
  private pathHead: RegionId | null = null;
  private pathHover: number | null = null;
  private pathMoving = false;
  private pathSent = { at: 0, key: "" };
  private pathInk = new Map<RegionId, "void" | "ink">();

  // interaction
  private selected: string | null = null;
  private hovered: string | null = null;
  private hoverRegion: RegionId | null = null;
  private pointer: { x: number; y: number; inside: boolean; dirty: boolean } = { x: 0, y: 0, inside: false, dirty: false };
  private down: { x: number; y: number; t: number } | null = null;
  private lastTouch = 0;
  private ambient = true;
  private orbitPausedUntil = 0;
  private moreLabels = false;
  private tween: Tween | null = null;

  // labels
  private labelPool = new Map<string, LabelRec>();
  private leaders: SVGLineElement[] = [];
  private calloutShapes = new Map<RegionId, { line: SVGPolylineElement; dot: SVGCircleElement }>();
  private hullSource: Float32Array | null = null;

  private raf = 0;
  private last = 0;
  private fxCount = 0;
  private resizeObserver: ResizeObserver;
  private disposed = false;
  private width = 1;
  private height = 1;

  constructor(
    private container: HTMLElement,
    private hooks: BrainHooks,
  ) {
    this.palette = this.readTheme();
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.touchAction = "none";
    container.style.position = container.style.position || "relative";
    container.appendChild(this.renderer.domElement);

    this.overlay = document.createElement("div");
    this.overlay.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none";
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.setAttribute("style", "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible");
    this.overlay.appendChild(this.svg);
    container.appendChild(this.overlay);
    // a caption has pointer events of its own, so the wheel over it is passed on to the canvas to keep the zoom working
    this.overlay.addEventListener("wheel", (e) => {
      if (e.target === this.overlay) return;
      e.preventDefault();
      this.renderer.domElement.dispatchEvent(new WheelEvent("wheel", e));
    }, { passive: false });

    this.camera.position.copy(START_POSITION);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // left drag turns the brain, right drag pans it and the wheel zooms towards the pointer
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.zoomSpeed = 0.9;
    this.controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
    this.controls.minDistance = MIN_DISTANCE;
    this.controls.maxDistance = MAX_DISTANCE;
    this.controls.rotateSpeed = 0.7;
    this.controls.autoRotateSpeed = orbitSpeed();
    this.controls.addEventListener("start", this.onControlStart);

    // The scene renders into a multisampled half-float target, so that the bloom sees values above 1 and edges stay smooth.
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // The threshold lets only firing nodes and pulses bloom: the resting colours stay below it.
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), BLOOM_REST, 0.55, 0.82);
    this.output = new OutputPass();
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);

    this.nodeMat = new ShaderMaterial({
      vertexShader: NODE_VERTEX,
      fragmentShader: NODE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uRatio: { value: this.renderer.getPixelRatio() },
        uRef: { value: REF_DISTANCE },
        uCentre: { value: REF_DISTANCE },
        uFar: { value: FAR_DIM },
        uBloom: { value: 1 },
        uOutline: { value: 0 },
      },
    });
    this.nodePoints = new Points(this.nodeGeo, this.nodeMat);
    this.nodePoints.frustumCulled = false;
    this.nodePoints.renderOrder = 3;
    this.scene.add(this.nodePoints);

    const lineOpacity = this.palette.dark ? 0.75 : 0.85;
    this.solid = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: lineOpacity, depthWrite: false, depthTest: false }));
    this.dashed = new LineSegments(new BufferGeometry(), new LineDashedMaterial({ vertexColors: true, transparent: true, opacity: lineOpacity * 0.8, depthWrite: false, depthTest: false, dashSize: 1.6, gapSize: 1.4 }));
    for (const l of [this.solid, this.dashed]) {
      l.frustumCulled = false;
      l.renderOrder = 2;
      this.scene.add(l);
    }

    this.fxMat = new ShaderMaterial({
      vertexShader: FX_VERTEX,
      fragmentShader: FX_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      uniforms: { uPx: { value: 500 }, uBloom: { value: 1 } },
    });
    this.fx = new Points(this.makeFxGeometry(FX_MAX), this.fxMat);
    this.fx.frustumCulled = false;
    this.fx.renderOrder = 4;
    this.scene.add(this.fx);
    // the rings of the selected and hovered node do not bloom, so that the node under them stays visible
    this.markerMat = this.fxMat.clone();
    this.markerMat.uniforms = { uPx: this.fxMat.uniforms.uPx, uBloom: { value: 0 } };
    this.markers = new Points(this.makeFxGeometry(2), this.markerMat);
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 5;
    this.markers.geometry.setDrawRange(0, 0);
    this.scene.add(this.markers);

    this.pathLayer = new PathLayer(this.pathColours(), this.renderer.getPixelRatio());
    this.scene.add(this.pathLayer.group);
    this.pathBadges = new PathBadges(this.overlay, {
      pick: (n) => window.dispatchEvent(new CustomEvent("cortex:path-pick", { detail: { n } })),
      hover: (n) => {
        this.pathHover = n;
      },
    });
    this.readInk();

    container.addEventListener("pointermove", this.onPointerMove);
    container.addEventListener("pointerleave", this.onPointerLeave);
    container.addEventListener("pointerdown", this.onPointerDown);
    container.addEventListener("pointerup", this.onPointerUp);
    container.addEventListener("dblclick", this.onDoubleClick);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("keydown", this.onKey);
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(container);
    this.applyTheme();
    this.fit();

    void loadBrainAsset()
      .then((asset) => {
        if (this.disposed) return;
        this.asset = asset;
        this.buildSurfaces(asset);
        if (this.pendingData) this.setData(this.pendingData.graph, this.pendingData.view);
      })
      .catch((err) => console.error("the brain asset did not load", err));
    this.start();
  }

  // ------------------------------------------------------------------ setup

  private makeFxGeometry(n: number): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(n * 3), 3).setUsage(35048));
    g.setAttribute("aColor", new BufferAttribute(new Float32Array(n * 3), 3).setUsage(35048));
    g.setAttribute("aSize", new BufferAttribute(new Float32Array(n), 1).setUsage(35048));
    g.setAttribute("aAlpha", new BufferAttribute(new Float32Array(n), 1).setUsage(35048));
    g.setAttribute("aKind", new BufferAttribute(new Float32Array(n), 1).setUsage(35048));
    g.setDrawRange(0, 0);
    return g;
  }

  private readTheme(): Palette {
    return readPalette(token, document.documentElement.dataset.theme !== "light");
  }

  /**
   * Surfaces: one outer silhouette (the shell, drawn on its front faces with a soft rim) and a light tint for each region.
   * The region meshes are drawn on their back faces and without a rim, so that the folds inside the brain no longer read as
   * layers of glass.
   */
  private buildSurfaces(asset: BrainAsset): void {
    const root = asset.scene.clone(true);
    this.brainRoot = root;
    const prepass: { parent: Object3D; pre: Mesh; region: RegionId }[] = [];
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const id = (mesh.userData.region ?? mesh.parent?.userData.region) as RegionId | "shell" | undefined;
      if (!id) return;
      if (!mesh.geometry.getAttribute("normal")) mesh.geometry.computeVertexNormals();
      let mat = this.surfaces.get(id);
      if (!mat) {
        mat = new ShaderMaterial({
          vertexShader: SURFACE_VERTEX,
          fragmentShader: SURFACE_FRAGMENT,
          transparent: true,
          depthWrite: false,
          side: FrontSide,
          depthFunc: id === "shell" ? LessEqualDepth : EqualDepth,
          uniforms: {
            uColor: { value: new Color() },
            uRimColor: { value: new Color() },
            uOpacity: { value: 0.1 },
            uRim: { value: 0.5 },
            uPower: { value: 2.4 },
            uGlow: { value: 0 },
            uSurface: { value: this.surface },
            uSolid: { value: id === "shell" ? 1 : 0.25 },
            uTint: { value: regionTint(id, null) },
            uNeutral: { value: new Color() },
            uNeutralOpacity: { value: 0.03 },
            uNeutralRim: { value: 0.55 },
          },
        });
        this.surfaces.set(id, mat);
      }
      mesh.material = mat;
      mesh.renderOrder = id === "shell" ? 0 : 1;
      mesh.frustumCulled = false;
      this.surfaceMeshes.push({ mesh, region: id });
      if (id !== "shell" && mesh.parent) {
        // A region is tinted once, on its nearest fold: a depth pass first, and the tint only where it equals that depth.
        const pre = new Mesh(mesh.geometry, this.depthOnly());
        pre.position.copy(mesh.position);
        pre.quaternion.copy(mesh.quaternion);
        pre.scale.copy(mesh.scale);
        pre.renderOrder = 0;
        pre.frustumCulled = false;
        pre.userData.region = id;
        prepass.push({ parent: mesh.parent, pre, region: id });
      }
    });
    for (const p of prepass) {
      p.parent.add(p.pre);
      this.surfaceMeshes.push({ mesh: p.pre, region: p.region });
    }
    // The group node of each region holds its meshes, so Expand moves the surface of a region by moving its group.
    const seenGroups = new Set<Object3D>();
    for (const m of this.surfaceMeshes) {
      const group = m.mesh.parent;
      if (!group || m.region === "shell" || seenGroups.has(group)) continue;
      seenGroups.add(group);
      this.shifted.push({ node: group, base: group.position.clone(), key: expandKey(m.region, (group.userData.hemisphere as "L" | "R" | undefined) ?? "L") });
    }
    // the centre of each region and hemisphere, from the manifest, give the direction in which Expand moves it
    this.centres = asset.manifest.regions
      .filter((e): e is typeof e & { id: RegionId; centroid: [number, number, number] } => e.id !== "shell" && !!e.centroid)
      .map((e) => ({ region: e.id, hemisphere: e.hemisphere, centre: { x: e.centroid[0], y: e.centroid[1], z: e.centroid[2] } }));
    this.scene.add(root);
    this.applyTheme();
    this.applyHidden();
    this.shiftNodes();
  }

  private depthMat: ShaderMaterial | null = null;

  /** A material that writes depth and no colour, with the vertex shader of the surfaces so that its depths match theirs exactly. */
  private depthOnly(): ShaderMaterial {
    if (!this.depthMat) {
      this.depthMat = new ShaderMaterial({ vertexShader: SURFACE_VERTEX, fragmentShader: "void main() { gl_FragColor = vec4(0.0); }", colorWrite: false, depthWrite: true });
    }
    return this.depthMat;
  }

  private applyTheme(): void {
    const dark = this.palette.dark;
    this.scene.background = linear(this.palette.void);
    this.bloom.enabled = dark;
    this.nodeMat.uniforms.uBloom.value = dark ? 1 : 0;
    // on the pale background each neuron gets a darker rim, so that its edge stays clear
    this.nodeMat.uniforms.uOutline.value = dark ? 0 : 1;
    this.fxMat.uniforms.uBloom.value = dark ? 1 : 0;
    for (const [id, mat] of this.surfaces) {
      const u = mat.uniforms;
      u.uSurface.value = this.surface;
      if (id === "shell") {
        // the silhouette: one faint outline and a veil, in the colour of the text
        (u.uColor.value as Color).copy(linear(this.palette.ink));
        (u.uRimColor.value as Color).copy(linear(this.palette.ink));
        u.uOpacity.value = dark ? 0.012 : 0.04;
        u.uRim.value = dark ? 0.3 : 0.7;
        // a wider rim in the light theme, so that the outline of the brain reads against the pale background
        u.uPower.value = dark ? 2.4 : 1.8;
      } else {
        // the tint of a region: a light wash with no rim of its own
        const rgb = this.palette.regions[id as RegionId];
        (u.uColor.value as Color).copy(linear(rgb));
        (u.uRimColor.value as Color).copy(linear(dark ? shade([1, 1, 1], rgb, 0.4) : rgb));
        u.uOpacity.value = dark ? 0.018 : 0.04;
        u.uRim.value = dark ? 0.06 : 0.1;
        // at rest every region draws in one neutral colour with a faint rim, so that the brain is a single silhouette
        (u.uNeutral.value as Color).copy(linear(this.palette.ink));
        u.uNeutralOpacity.value = dark ? 0.008 : 0.02;
        u.uNeutralRim.value = dark ? 0.17 : 0.32;
        u.uPower.value = dark ? 2.4 : 1.8;
      }
    }
    const lineOpacity = dark ? 0.75 : 0.85;
    (this.solid.material as LineBasicMaterial).opacity = lineOpacity;
    (this.dashed.material as LineDashedMaterial).opacity = lineOpacity * 0.8;
  }

  /** Set the opacity of the silhouette, from 0 (hidden) to 1 (solid). */
  setSurface(value: number | undefined): void {
    const v = Math.min(1, Math.max(0, typeof value === "number" && Number.isFinite(value) ? value : 0.25));
    if (v === this.surface) return;
    this.surface = v;
    this.applySurfaceLevels();
    // a more solid surface hides more of the far side, so the far neurons are dimmed more
    this.nodeMat.uniforms.uFar.value = FAR_DIM + 0.35 * Math.max(0, v - 0.25);
  }

  /**
   * Set Expand, from 0 to 1. The regions move outwards from the centre of the brain along the direction of their own
   * centres (expand.ts), smoothly, and the camera draws back so that the spread brain stays in view.
   */
  setExpand(value: number | undefined): void {
    this.expandTarget = Math.min(1, Math.max(0, typeof value === "number" && Number.isFinite(value) ? value : 0));
  }

  /** Show or hide the captions and labels of the regions and clusters. The label of a selected or hovered neuron stays. */
  setCaptions(on: boolean | undefined): void {
    this.captionsOn = on !== false;
  }

  /** Move the neurons and the surfaces of the regions to their model position plus the offset of Expand. */
  private shiftNodes(): void {
    this.offsets = expandOffsets(this.centres, this.expand);
    for (const b of this.nodes) {
      const o = this.offsets.get(expandKey(b.region, b.hemi));
      b.x = b.bx + (o?.x ?? 0);
      b.y = b.by + (o?.y ?? 0);
      b.z = b.bz + (o?.z ?? 0);
    }
    for (const sh of this.shifted) {
      const o = this.offsets.get(sh.key);
      sh.node.position.set(sh.base.x + (o?.x ?? 0), sh.base.y + (o?.y ?? 0), sh.base.z + (o?.z ?? 0));
    }
    const a = this.nodeGeo.getAttribute("position") as BufferAttribute | undefined;
    if (a && a.count === this.nodes.length) {
      const arr = a.array as Float32Array;
      for (const b of this.nodes) {
        arr[b.i * 3] = b.x;
        arr[b.i * 3 + 1] = b.y;
        arr[b.i * 3 + 2] = b.z;
      }
      a.needsUpdate = true;
    }
  }

  /** How far the camera stands back for the current Expand, as a multiple of its distance for the closed brain. */
  private draw(): number {
    return 1 + EXPAND_ZOOM * this.expand;
  }

  /** Move the current Expand towards its target, and everything that depends on the positions with it. */
  private stepExpand(dt: number): void {
    if (this.expand === this.expandTarget) return;
    const prev = this.expand;
    const gap = this.expandTarget - prev;
    this.expand = reducedMotion() || Math.abs(gap) < 0.004 ? this.expandTarget : prev + gap * (1 - Math.exp(-dt / (EXPAND_MS / 3)));
    this.shiftNodes();
    this.buildClusters();
    this.rebuildLinks();
    this.updateMarkers();
    this.rebuildPath();
    const ratio = (1 + EXPAND_ZOOM * this.expand) / (1 + EXPAND_ZOOM * prev);
    if (this.tween) {
      this.tween.dist0 *= ratio;
      this.tween.dist1 *= ratio;
    } else {
      const t = this.controls.target;
      this.camera.position.sub(t).multiplyScalar(ratio).add(t);
    }
  }

  /** Read the tokens again after a theme change and repaint everything that holds a colour. */
  refreshTheme(): void {
    this.palette = this.readTheme();
    this.applyTheme();
    this.paintAll();
    this.rebuildLinks();
    this.updateMarkers();
    this.pathLayer.setColours(this.pathColours());
    this.readInk();
  }

  private leftInset = 0;
  /** the widest region caption, in pixels, which sets how much room the framing leaves beside the brain */
  private calloutW = 190;

  /** Keep the left part of the canvas free for a panel: the scene is centred in the rest. */
  setLeftInset(px: number): void {
    this.leftInset = Math.max(0, px);
    this.fit();
    // a focus is framed again, because the room for its box and its caption changes with the panel
    if (this.focused) this.focusRegion(this.focused);
  }

  /** The zoom and the centre of the free area that fit the brain, with room beside it for the callouts. */
  private framing(w: number, h: number): { s: number; cx: number; cy: number } {
    const left = Math.min(this.leftInset, w * 0.7);
    const free = { w: w - left - BAR_ROOM, h: h - FRAME_TOP - FRAME_BOTTOM };
    const f = h / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    // pixels for one scene unit at the edge of the brain, at the distance of the camera at rest
    const unit = f / Math.sqrt(START_POSITION.lengthSq() - BRAIN_RADIUS * BRAIN_RADIUS);
    const fitX = (free.w / 2 - (this.calloutW + CALLOUT_ROOM) * (left > 0 ? 0.8 : 1)) / (BRAIN_HALF_WIDTH * unit);
    const fitY = (free.h / 2 - 8) / (BRAIN_HALF_HEIGHT * unit);
    return { s: Math.max(0.3, Math.min(fitX, fitY)), cx: left + free.w / 2, cy: FRAME_TOP + free.h / 2 };
  }

  private fit(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w < 1 || h < 1) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.camera.aspect = w / h;
    // The brain is fitted into the free area of the canvas: a sub view of a larger virtual view gives the zoom, and its
    // offset puts the centre of the brain at the centre of the free area (the canvas without the top bar and an open panel).
    const { s, cx, cy } = this.framing(w, h);
    this.camera.setViewOffset(w * s, h * s, (w * s) / 2 - cx, (h * s) / 2 - cy, w, h);
    this.camera.updateProjectionMatrix();
    const px = (s * h * this.renderer.getPixelRatio()) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.pxPerUnit = px;
    this.nodeMat.uniforms.uRatio.value = this.renderer.getPixelRatio();
    this.fxMat.uniforms.uPx.value = px;
    this.pathLayer.setResolution(w, h, this.renderer.getPixelRatio());
  }

  // ------------------------------------------------------------------- data

  /** Replace the data. Every node of the graph is placed once, so that filtering a family hides nodes and moves none. */
  setData(graph: GraphFile, view: BrainView): void {
    this.sizeBy = view.sizeBy;
    if (!this.asset) {
      this.pendingData = { graph, view };
      return;
    }
    this.pendingData = null;
    this.hidden = new Set(view.hiddenRegions);
    const key = `${graph.built}|${graph.nodes.length}|${graph.edges.length}|${view.cap}|${view.showProposed ? "p" : "-"}|${Object.entries(view.families)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(",")}`;
    if (key === this.dataKey) {
      this.applyHidden();
      this.paintAll();
      this.rebuildLinks();
      return;
    }
    this.dataKey = key;

    const placeKey = `${graph.built}|${graph.nodes.length}|${JSON.stringify(brainDomains())}`;
    if (placeKey !== this.placementKey) {
      this.placementKey = placeKey;
      // The nodes of one cluster (a file, a project, a type) are placed together, so that a cluster label can name them.
      const known = new Map(graph.nodes.map((n) => [n.id, n]));
      const lookup = (id: string) => known.get(id);
      const refs = graph.nodes.map((n) => clusterOf(n, lookup));
      const items = graph.nodes.map((n, i) => ({ id: n.id, region: regionOf(n, n.path, brainDomains()), group: refs[i].key }));
      this.placements = placeNodes(items, this.asset.points, this.asset.manifest.regions as RegionEntry[]).positions;
      this.regions = new Map(items.map((i) => [i.id, i.region]));
      this.clusterRefs = new Map(graph.nodes.map((n, i) => [n.id, refs[i]]));
    }

    const shown = new Set(filterNodes(graph.nodes, view).map((n) => n.id));
    this.nodes = [];
    this.byId.clear();
    for (const gn of graph.nodes) {
      const p = this.placements.get(gn.id);
      if (!p) continue;
      const node: BNode = {
        i: this.nodes.length,
        id: gn.id,
        gn,
        region: this.regions.get(gn.id) ?? "prefrontal",
        cluster: this.clusterRefs.get(gn.id)?.key ?? `self:${gn.id}`,
        hemi: p.hemisphere,
        bx: p.x,
        by: p.y,
        bz: p.z,
        x: p.x,
        y: p.y,
        z: p.z,
        radius: nodeRadius(gn, this.sizeBy),
        heat: heatOfNode(gn),
        visible: shown.has(gn.id),
      };
      this.nodes.push(node);
      this.byId.set(gn.id, node);
    }
    this.counts = Object.fromEntries(REGION_IDS.map((r) => [r, 0])) as Record<RegionId, number>;
    for (const n of this.nodes) if (n.visible) this.counts[n.region] += 1;
    this.shiftNodes();
    this.buildClusters();

    this.adj.clear();
    for (const e of filterEdges(graph.edges, shown)) {
      const proposed = e.provenance === "proposed";
      if (proposed && !view.showProposed) continue;
      const rec = { s: e.s, t: e.t, proposed };
      for (const id of [e.s, e.t]) {
        let list = this.adj.get(id);
        if (!list) this.adj.set(id, (list = []));
        list.push(rec);
      }
    }

    this.buildNodeGeometry();
    this.applyHidden();
    this.paintAll();
    this.rebuildLinks();
    this.updateMarkers();
    this.rebuildPath();
  }

  private regions = new Map<string, RegionId>();
  private clusterRefs = new Map<string, { key: string; label: string }>();

  /** The clusters of the shown neurons, each at the centre of its members, and the caption anchors of the regions. */
  private buildClusters(): void {
    const sums = new Map<string, { c: Cluster; x: number; y: number; z: number }>();
    for (const b of this.nodes) {
      if (!b.visible) continue;
      let s = sums.get(b.cluster);
      if (!s) {
        const ref = this.clusterRefs.get(b.id);
        sums.set(b.cluster, (s = { c: { key: b.cluster, label: ref?.label ?? b.gn.label, region: b.region, count: 0, at: { x: 0, y: 0, z: 0 } }, x: 0, y: 0, z: 0 }));
      }
      s.c.count += 1;
      s.x += b.x;
      s.y += b.y;
      s.z += b.z;
    }
    this.clusters = [...sums.values()].map(({ c, x, y, z }) => ({ ...c, at: { x: x / c.count, y: y / c.count, z: z / c.count } }));
    this.anchors = [];
    this.anchorDir = null;
  }

  private anchorDir: Vector3 | null = null;
  private reachPoints: Float32Array | null = null;

  /**
   * The caption anchors of the regions for the side of the brain that faces the camera: the centre of the neurons drawn
   * on that side, pushed outwards past the surface. They are taken again when the camera has turned by about 4 degrees.
   */
  private refreshAnchors(): void {
    if (!this.asset) return;
    const dir = this.camera.position.clone().normalize();
    if (this.anchorDir && this.anchors.length && this.anchorDir.dot(dir) > 0.998) return;
    this.anchorDir = dir;
    if (!this.reachPoints) {
      // every fourth sample point is enough to find where the surface lies
      const src = this.asset.points;
      const keep: number[] = [];
      for (let i = 0; i + 5 < src.length; i += 24) keep.push(src[i], src[i + 1], src[i + 2], src[i + 3], src[i + 4], src[i + 5]);
      this.reachPoints = Float32Array.from(keep);
    }
    const shown = this.nodes.filter((b) => b.visible).map((b) => ({ region: b.region, hemisphere: "L" as const, x: b.x, y: b.y, z: b.z, front: b.x * dir.x + b.y * dir.y + b.z * dir.z > 0 }));
    const facing = regionAnchors(shown.filter((n) => n.front), this.reachPoints).filter((a) => a.count >= 3);
    const have = new Set(facing.map((a) => a.region));
    this.anchors = [...facing, ...regionAnchors(shown.filter((n) => !have.has(n.region)), this.reachPoints)];
  }

  private buildNodeGeometry(): void {
    const n = this.nodes.length;
    this.nodeGeo.dispose();
    const g = new BufferGeometry();
    const pos = new Float32Array(n * 3);
    this.nodes.forEach((b, i) => {
      pos[i * 3] = b.x;
      pos[i * 3 + 1] = b.y;
      pos[i * 3 + 2] = b.z;
    });
    g.setAttribute("position", new BufferAttribute(pos, 3));
    g.setAttribute("aColor", new BufferAttribute(new Float32Array(n * 3), 3).setUsage(35048));
    g.setAttribute("aSize", new BufferAttribute(new Float32Array(n), 1).setUsage(35048));
    g.setAttribute("aGlow", new BufferAttribute(new Float32Array(n), 1).setUsage(35048));
    g.setAttribute("aAlpha", new BufferAttribute(new Float32Array(n), 1).setUsage(35048));
    this.nodeGeo = g;
    this.nodePoints.geometry = g;
    this.screen = new Float32Array(n * 3);
  }

  private attr(name: string): Float32Array {
    return (this.nodeGeo.getAttribute(name) as BufferAttribute).array as Float32Array;
  }

  private touch(name: string): void {
    const a = this.nodeGeo.getAttribute(name) as BufferAttribute | undefined;
    if (a) a.needsUpdate = true;
  }

  /** The diameter of the bright core of a neuron in CSS pixels at the default distance: 5 for the smallest, 16 for the hottest. */
  private neuronPx(b: BNode): number {
    const t = Math.min(1, Math.max(0, (nodeRadius(b.gn, this.sizeBy) - 1.2) / 8.8));
    return NEURON_MIN_PX + (NEURON_MAX_PX - NEURON_MIN_PX) * t ** 0.85;
  }

  /** A length in CSS pixels at the default distance, as a size in scene units for the effect sprites. */
  private worldSize(px: number): number {
    return (px * this.renderer.getPixelRatio() * REF_DISTANCE) / this.pxPerUnit;
  }

  private paintNode(b: BNode): void {
    const color = this.attr("aColor");
    const size = this.attr("aSize");
    const alpha = this.attr("aAlpha");
    // a node never used still shows, so the resting level runs from 0.8 to 1 of its neuron colour
    const level = 0.8 + 0.2 * ((restingBrightness(b.heat) - 0.35) / 0.55);
    const c = linear(shade(this.palette.neurons[b.region], this.palette.void, level));
    color[b.i * 3] = c.r;
    color[b.i * 3 + 1] = c.g;
    color[b.i * 3 + 2] = c.b;
    size[b.i] = this.neuronPx(b) * (b.id === this.hovered ? HOVER_GROW : b.id === this.selected ? 1.3 : this.focused === b.region ? FOCUS_GROW : this.focused ? FOCUS_SHRINK : 1);
    const outside = this.highlight && !this.highlight.has(b.id) ? 0.15 : 1;
    const dim = this.focused && b.region !== this.focused ? Math.min(outside, FOCUS_FADE) : outside;
    // the neurons of the step that is playing stand out over a focus and a highlight
    alpha[b.i] = b.visible && !this.hidden.has(b.region) ? (this.stepSet?.has(b.id) ? 1 : dim) : 0;
    this.attr("aGlow")[b.i] = this.glowFor(b);
  }

  /** The glow of a neuron: only a firing or a selected neuron glows, and none of a region that a focus has faded. */
  private glowFor(b: BNode): number {
    return glowOf(this.tracker.glow(b.id), b.id === this.selected, !!this.focused && b.region !== this.focused);
  }

  /** The strength of each surface: the Surface slider, and over a focus a lighter tint on the regions that are not focused, so that the neurons of the focus stay clear. */
  private applySurfaceLevels(): void {
    for (const [id, mat] of this.surfaces) {
      mat.uniforms.uSurface.value = this.surface * (!this.focused || id === "shell" ? 1 : id === this.focused ? FOCUS_OWN_SURFACE : FOCUS_SURFACE);
      // a region is tinted only while it is focused (or firing, through uGlow): at rest the brain is one neutral silhouette
      mat.uniforms.uTint.value = regionTint(id as RegionId | "shell", this.focused);
    }
  }

  private paintAll(): void {
    this.applySurfaceLevels();
    if (!this.nodes.length) return;
    for (const b of this.nodes) this.paintNode(b);
    for (const name of ["aColor", "aSize", "aAlpha", "aGlow"]) this.touch(name);
  }

  private applyHidden(): void {
    for (const s of this.surfaceMeshes) s.mesh.visible = s.region === "shell" || !this.hidden.has(s.region);
  }

  setSizeBy(sizeBy: "heat" | "degree"): void {
    if (sizeBy === this.sizeBy) return;
    this.sizeBy = sizeBy;
    this.paintAll();
  }

  /** Hide the regions in the list: their surfaces, nodes and captions are not drawn. */
  setHiddenRegions(ids: RegionId[]): void {
    this.hidden = new Set(ids);
    this.applyHidden();
    this.paintAll();
    this.rebuildLinks();
  }

  /** The number of nodes shown in each region. */
  regionCounts(): Record<RegionId, number> {
    return { ...this.counts };
  }

  get shownCount(): { nodes: number; links: number } {
    let links = 0;
    for (const l of this.adj.values()) links += l.length;
    return { nodes: this.nodes.filter((n) => n.visible).length, links: links / 2 };
  }

  setMoreLabels(on: boolean): void {
    this.moreLabels = on;
  }

  /** Dim every node outside the list to 15 %, until the list is empty. */
  setHighlight(ids: string[]): void {
    this.highlight = ids.length ? new Set(ids) : null;
    this.paintAll();
  }

  // ----------------------------------------------------------------- firing

  /** Light the nodes of an activation. A preview is drawn as a predicted step. */
  fire(activation: Activation[], preview: boolean): void {
    this.run(activation, preview);
  }

  /** Play one step of the thought trail: its nodes light in order of their hop, with their labels. */
  playStep(step: TrailStep): void {
    // with a path on screen the head turns the camera when it enters another region, so the step does not
    this.run(step.activation, step.mode === "predicted", !this.pathGeo);
    const g = this.pathGeo;
    if (g && step.n >= 1 && step.n <= g.steps) {
      this.pathSelected = null;
      this.pathProgress = step.n;
      this.pathAnim = { n: step.n, t0: performance.now(), ms: stepMs(step) / this.pathSpeed };
      this.pathHeld = 0;
    }
  }

  private run(activation: Activation[], predicted: boolean, turn = true): void {
    if (this.disposed || document.hidden || !this.nodes.length) return;
    const known = activation.filter((a) => this.byId.has(a.id));
    if (!known.length) return;
    const now = performance.now();
    const reduced = reducedMotion();
    for (const e of planStep(known, reduced)) this.waiting.push({ ...e, due: now + e.at, predicted });
    const region = leadRegion(known, (id) => this.byId.get(id)?.region);
    const span = Math.max(...known.map((a) => a.hop)) * 250;
    this.stepLabels = { ids: labelOrder(known), until: now + span + STEP_LABEL_MS, region };
    this.stepSet = new Set(known.map((a) => a.id));
    this.paintAll();
    if (region && !reduced && turn) this.turnTo(region);
  }

  private spawn(e: Pending, now: number): void {
    const b = this.byId.get(e.id);
    if (!b) return;
    const glow = e.predicted ? e.a * 0.6 : e.a;
    const half = e.predicted ? PREVIEW_HALF_LIFE_MS : HALF_LIFE_MS;
    this.tracker.add(e.id, glow, half);
    this.regionGlow.add(b.region, glow, half);
    if (reducedMotion()) return;
    if (e.pulse && e.via) {
      const v = this.byId.get(e.via);
      if (v && v.visible && b.visible && this.pulses.length < 160) {
        this.pulses.push({ a: { x: v.x, y: v.y, z: v.z }, b: { x: b.x, y: b.y, z: b.z }, t0: now, region: b.region, predicted: e.predicted });
      }
    }
    if (e.hop === 0 && this.rings.length < 120) {
      this.rings.push({ at: { x: b.x, y: b.y, z: b.z }, t0: now, base: this.worldSize(this.neuronPx(b)) * 0.5, region: b.region, predicted: e.predicted });
    }
  }

  private writeEffects(now: number): void {
    const g = this.fx.geometry;
    const pos = (g.getAttribute("position") as BufferAttribute).array as Float32Array;
    const col = (g.getAttribute("aColor") as BufferAttribute).array as Float32Array;
    const size = (g.getAttribute("aSize") as BufferAttribute).array as Float32Array;
    const alpha = (g.getAttribute("aAlpha") as BufferAttribute).array as Float32Array;
    const kind = (g.getAttribute("aKind") as BufferAttribute).array as Float32Array;
    let n = 0;
    const put = (p: Vec3, c: Color, s: number, a: number, k: number) => {
      if (n >= FX_MAX) return;
      pos[n * 3] = p.x;
      pos[n * 3 + 1] = p.y;
      pos[n * 3 + 2] = p.z;
      col[n * 3] = c.r;
      col[n * 3 + 1] = c.g;
      col[n * 3 + 2] = c.b;
      size[n] = s;
      alpha[n] = a;
      kind[n] = k;
      n += 1;
    };
    const tail = [1, 0.62, 0.38, 0.2];
    this.pulses = this.pulses.filter((p) => {
      const t = (now - p.t0) / PULSE_MS;
      if (t > 1.25) return false;
      const c = linear(this.palette.regions[p.region]);
      const soft = p.predicted ? 0.6 : 1;
      tail.forEach((w, k) => {
        const tk = Math.min(1, t - k * 0.07);
        if (tk < 0) return;
        put(curvePoint(p.a, p.b, tk), c, (4.2 - k * 0.8) * soft, w * soft * (t > 1 ? Math.max(0, 1 - (t - 1) * 4) : 1), 0);
      });
      return true;
    });
    this.rings = this.rings.filter((r) => {
      const t = (now - r.t0) / RING_MS;
      if (t >= 1) return false;
      put(r.at, linear(this.palette.regions[r.region]), r.base * (2 + 7 * t), 0.9 * (1 - t) * (r.predicted ? 0.7 : 1), r.predicted ? 2 : 1);
      return true;
    });
    this.fxCount = n;
    g.setDrawRange(0, n);
    for (const name of ["position", "aColor", "aSize", "aAlpha", "aKind"]) (g.getAttribute(name) as BufferAttribute).needsUpdate = true;
  }

  // -------------------------------------------------------------- selection

  setSelected(id: string | null): void {
    const was = this.selected;
    this.selected = id;
    if (this.nodes.length) {
      for (const key of [was, id]) {
        const b = key ? this.byId.get(key) : undefined;
        if (b) this.paintNode(b);
      }
      this.touch("aSize");
    }
    if (id) this.pauseOrbit();
    else if (was && !reducedMotion()) this.flyTo(this.camera.position.clone().normalize(), 320 * this.draw(), new Vector3(0, 0, 0));
    this.rebuildLinks();
    this.updateMarkers();
  }

  private updateMarkers(): void {
    const g = this.markers.geometry;
    const pos = (g.getAttribute("position") as BufferAttribute).array as Float32Array;
    const col = (g.getAttribute("aColor") as BufferAttribute).array as Float32Array;
    const size = (g.getAttribute("aSize") as BufferAttribute).array as Float32Array;
    const alpha = (g.getAttribute("aAlpha") as BufferAttribute).array as Float32Array;
    const kind = (g.getAttribute("aKind") as BufferAttribute).array as Float32Array;
    let n = 0;
    const put = (id: string | null, rgb: Rgb, scale: number, a: number) => {
      const b = id ? this.byId.get(id) : undefined;
      if (!b || !b.visible || this.hidden.has(b.region)) return;
      const c = linear(rgb);
      pos.set([b.x, b.y, b.z], n * 3);
      col.set([c.r, c.g, c.b], n * 3);
      size[n] = this.worldSize(this.neuronPx(b)) * scale;
      alpha[n] = a;
      kind[n] = 1;
      n += 1;
    };
    if (this.hovered && this.hovered !== this.selected) put(this.hovered, this.palette.ink, 2.4, 0.7);
    put(this.selected, this.palette.signal, 2.8, 1);
    g.setDrawRange(0, n);
    for (const name of ["position", "aColor", "aSize", "aAlpha", "aKind"]) (g.getAttribute(name) as BufferAttribute).needsUpdate = true;
  }

  /** Draw the links of the selected and the hovered node as curves that bend towards the centre. */
  private rebuildLinks(): void {
    const ids = [this.selected, this.hovered].filter((x): x is string => !!x);
    const seen = new Set<string>();
    const solid: [BNode, BNode][] = [];
    const dashed: [BNode, BNode][] = [];
    for (const id of ids) {
      for (const e of this.adj.get(id) ?? []) {
        const k = `${e.s}|${e.t}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const a = this.byId.get(e.s);
        const b = this.byId.get(e.t);
        if (!a || !b || this.hidden.has(a.region) || this.hidden.has(b.region)) continue;
        (e.proposed ? dashed : solid).push([a, b]);
        if (solid.length + dashed.length >= LINK_CAP) break;
      }
    }
    this.fillLines(this.solid, solid);
    this.fillLines(this.dashed, dashed);
  }

  private fillLines(lines: LineSegments, pairs: [BNode, BNode][]): void {
    const n = pairs.length * LINK_SEGMENTS;
    const pos = new Float32Array(n * 6);
    const col = new Float32Array(n * 6);
    let at = 0;
    pairs.forEach(([a, b]) => {
      const from = at;
      at = curveSegments(a, b, LINK_SEGMENTS, pos, at);
      const ca = linear(this.palette.regions[a.region]);
      const cb = linear(this.palette.regions[b.region]);
      for (let s = 0; s < LINK_SEGMENTS; s += 1) {
        const t0 = s / LINK_SEGMENTS;
        const t1 = (s + 1) / LINK_SEGMENTS;
        const o = from + s * 6;
        col[o] = ca.r + (cb.r - ca.r) * t0;
        col[o + 1] = ca.g + (cb.g - ca.g) * t0;
        col[o + 2] = ca.b + (cb.b - ca.b) * t0;
        col[o + 3] = ca.r + (cb.r - ca.r) * t1;
        col[o + 4] = ca.g + (cb.g - ca.g) * t1;
        col[o + 5] = ca.b + (cb.b - ca.b) * t1;
      }
    });
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    geo.setAttribute("color", new BufferAttribute(col, 3));
    lines.geometry.dispose();
    lines.geometry = geo;
    if (lines === this.dashed && n) lines.computeLineDistances();
  }

  // --------------------------------------------------------------- the traced path

  private pathColours(): PathColours {
    return {
      regions: this.palette.regions,
      void: this.palette.void,
      faint: parseCssColor(token("--color-ink-faint")),
      block: parseCssColor(token("--color-block")),
      hold: parseCssColor(token("--color-hold")),
      dark: this.palette.dark,
    };
  }

  /** The colour of the number on the badge of each region: the background colour or the text colour, whichever reads better. */
  private readInk(): void {
    for (const r of REGION_IDS) this.pathInk.set(r, badgeInk(this.palette.regions[r], this.palette.void, this.palette.ink));
  }

  private pathLookup = (id: string): { pos: V3; region: RegionId } | undefined => {
    const b = this.byId.get(id);
    return b ? { pos: { x: b.x, y: b.y, z: b.z }, region: b.region } : undefined;
  };

  private pathAnchor = (kind: string): { pos: V3; region: RegionId } | undefined => {
    const r = anchorRegion(kind);
    const a = r && this.asset ? this.nearestAnchor(r) : null;
    return r && a ? { pos: { x: a.centre.x, y: a.centre.y, z: a.centre.z }, region: r } : undefined;
  };

  /**
   * Draw a path, or none. A path with a new id starts again from before its first step. The same path with more steps keeps the
   * head where it is, which is how a live prompt grows. With reduced motion the whole path is drawn at once.
   */
  setPath(path: TracePath | null, opts: { previous?: TracePath | null; progress?: number; frame?: boolean } = {}): void {
    const fresh = !path || !this.pathData || path.id !== this.pathData.id;
    this.pathData = path;
    if (opts.previous !== undefined) this.prevData = opts.previous;
    if (fresh) {
      this.pathSelected = null;
      this.pathWhole = false;
      this.pathAnim = null;
      this.pathHead = null;
      this.pathVisitedArc = -2;
      this.pathVisited.clear();
      this.pathProgress = 0;
    }
    if (opts.progress !== undefined) {
      this.pathProgress = opts.progress;
      this.pathAnim = null;
    }
    if (path && reducedMotion()) this.pathProgress = path.steps.length + 1;
    this.rebuildPath();
    if (opts.frame) this.framePath();
  }

  private rebuildPath(): void {
    const p = this.pathData;
    if (!p || !this.nodes.length) {
      this.pathGeo = null;
      this.pathMarkers = [];
      this.pathLayer.setGeometry(null);
      this.pathLayer.setPrevious(null);
      this.pathBadges.clear();
      return;
    }
    const g = buildPath(p.steps, this.pathLookup, { anchor: this.pathAnchor, volume: this.pathVolume() });
    this.pathGeo = g;
    this.pathLayer.setGeometry(g, p.source === "plan");
    // a finding stands on the waypoint of the step that carries it (docs/BRAIN.md, "Findings on the path")
    this.pathMarkers = markerSpots(p.steps, (n) => g.waypoints[n - 1]?.pos);
    this.pathVisitedArc = -2;
    const prev = this.pathShowPrev ? this.prevData : null;
    this.pathLayer.setPrevious(prev && prev.steps.length ? buildPath(prev.steps, this.pathLookup, { anchor: this.pathAnchor, volume: this.pathVolume() }) : null);
  }

  /** The half extents of the box of the nodes on screen, which no curve of a path leaves. */
  private pathVolume(): V3 {
    return volumeOf(this.nodes.map((b) => ({ x: b.x, y: b.y, z: b.z })), 40);
  }

  /** The previous path is drawn dimmed beside the current one, or not at all. */
  setPathPrevious(on: boolean): void {
    this.pathShowPrev = on;
    const prev = on ? this.prevData : null;
    this.pathLayer.setPrevious(prev && prev.steps.length && this.nodes.length ? buildPath(prev.steps, this.pathLookup, { anchor: this.pathAnchor, volume: this.pathVolume() }) : null);
  }

  setPathFollow(on: boolean): void {
    this.pathFollow = on;
    if (on) this.pathWhole = false;
  }

  setPathPlaying(playing: boolean, speed?: number): void {
    const was = this.pathPlaying;
    this.pathPlaying = playing;
    if (speed) this.pathSpeed = speed;
    if (this.pathAnim) {
      const now = performance.now();
      if (was && !playing) this.pathHeld = now - this.pathAnim.t0;
      else if (!was && playing) this.pathAnim.t0 = now - this.pathHeld;
    }
  }

  /** Move the head to a step and a fraction of it, and highlight the step when it is selected. The head parks there. */
  seekPath(n: number, fraction: number, select = false): void {
    const g = this.pathGeo;
    if (!g) return;
    const step = Math.min(g.steps, Math.max(1, Math.round(n)));
    this.pathAnim = null;
    this.pathProgress = reducedMotion() && !select ? g.steps + 1 : progressOf(step, fraction);
    this.pathSelected = select ? step : null;
    if (select) {
      this.pathWhole = false;
      this.easeToStep(step);
    }
  }

  /** The head, the progress and the selected step now, for the panel. */
  pathState(): { n: number; fraction: number; selected: number | null } {
    const g = this.pathGeo;
    const s = g ? stepOfProgress(g, this.pathProgress) : { n: 0, fraction: 0 };
    return { ...s, selected: this.pathSelected };
  }

  private vec(p: V3): Vector3 {
    return new Vector3(p.x, p.y, p.z);
  }

  /** The direction from the centre of the brain to the middle of some points, tipped up a little as a focus is, or the present direction. */
  private dirOf(pts: Vector3[]): Vector3 {
    const c = new Vector3();
    for (const p of pts) c.add(p);
    c.divideScalar(Math.max(1, pts.length));
    if (c.length() < 12) return this.camera.position.clone().sub(this.controls.target).normalize();
    return c.normalize().add(new Vector3(0, 0.25, 0)).normalize();
  }

  /** Ease the camera to the nodes of one step (docs/BRAIN.md, "The thought trail panel and the line"). */
  private easeToStep(n: number): void {
    const g = this.pathGeo;
    if (!g || reducedMotion()) return;
    const pts: Vector3[] = [this.vec(g.waypoints[n - 1].pos)];
    for (const k of g.knots) if (k.step === n) pts.push(this.vec(k.pos));
    for (const b of g.branches) if (b.step === n) pts.push(this.vec(b.points[b.points.length - 1]));
    if (this.focused) {
      this.focused = null;
      this.paintAll();
    }
    // every point of the step, its line, its branches and its stubs, so that the hops of a chain and their plates fit in the free area
    const all: V3[] = pts.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const e = g.line.ends;
    for (let i = 0; i < g.line.count; i += 1) if (g.line.step[i] === n) all.push({ x: e[i * 6], y: e[i * 6 + 1], z: e[i * 6 + 2] }, { x: e[i * 6 + 3], y: e[i * 6 + 4], z: e[i * 6 + 5] });
    for (const b of g.branches) if (b.step === n && !b.dot) all.push(...b.points);
    for (const st of g.stubs) if (st.step === n) all.push(st.from, st.to);
    this.fitTo(all, this.dirOf(pts), PATH_EASE_MS);
  }

  /** Fly the camera to the distance and target at which every point lies in the free area of the canvas, 48 pixels from its edges. */
  private fitTo(all: V3[], dir: Vector3, ms: number): void {
    if (!all.length || this.width <= 0) return;
    const { s, cx, cy } = this.framing(this.width, this.height);
    const f = this.height / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const free = { left: Math.max(60, this.leftInset + 8), top: FRAME_TOP, right: this.width - BAR_ROOM, bottom: this.height - FRAME_BOTTOM };
    const fit = fitPathCamera(all, { x: dir.x, y: dir.y, z: dir.z }, { sf: s * f, cx, cy }, free, { margin: PATH_FRAME_MARGIN, minDist: FOCUS_MIN_DISTANCE, maxDist: MAX_DISTANCE * this.draw() });
    this.flyTo(dir, fit.dist, this.vec(fit.target), ms);
    this.pauseOrbit();
  }

  /** Show the whole path: draw all of it and frame every waypoint. Following the head stops until the person turns it on again. */
  framePath(): void {
    const g = this.pathGeo;
    if (!g) return;
    this.pathWhole = true;
    this.pathSelected = null;
    this.pathAnim = null;
    this.pathProgress = g.steps + 1;
    if (this.focused) {
      this.focused = null;
      this.paintAll();
    }
    const pts: Vector3[] = g.waypoints.map((w) => this.vec(w.pos));
    for (const k of g.knots) pts.push(this.vec(k.pos));
    for (const b of g.branches) pts.push(this.vec(b.tip));
    if (!pts.length || this.width <= 0) return;
    const dir = this.dirOf(pts);
    // every waypoint and every sample point of the main line lands inside the free area, 48 pixels from its edges
    const all: V3[] = pts.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const e = g.line.ends;
    for (let i = 0; i + 2 < e.length; i += 3) all.push({ x: e[i], y: e[i + 1], z: e[i + 2] });
    for (const b of g.branches) if (!b.dot) for (const q of b.points) all.push(q);
    for (const st of g.stubs) all.push(st.from, st.to);
    this.fitTo(all, dir, PATH_EASE_MS * 1.5);
  }

  private projectPoint(p: V3): { x: number; y: number } | null {
    const v = new Vector3(p.x, p.y, p.z).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height };
  }

  /** The regions the head has entered: those of the pieces of the line up to the head. */
  private visitedAt(arc: number): void {
    this.pathVisited.clear();
    const g = this.pathGeo;
    if (!g || arc < 0) return;
    for (const r of g.ranges) {
      for (const s of r.slots) if (s.region && s.arc0 <= arc + 1e-6) this.pathVisited.add(s.region);
    }
    for (const w of g.waypoints) if (w.region && w.arc <= arc + 1e-6 && w.at <= this.pathProgress + 1e-9) this.pathVisited.add(w.region);
  }

  /** Advance the head and tell the layer, the badges and the panel. Once a frame. */
  private stepPath(now: number): void {
    const g = this.pathGeo;
    const data = this.pathData;
    this.pathMoving = false;
    if (!g || !data) return;
    const reduced = reducedMotion();
    const a = this.pathAnim;
    if (reduced) {
      this.pathProgress = g.steps + 1;
      this.pathAnim = null;
    } else if (a && this.pathPlaying) {
      const u = (now - a.t0) / a.ms;
      if (u >= 1) {
        // the head parks a hair short of the next step, so that every caption still names the step that has just played
        this.pathProgress = a.n + 1 - PATH_END_EPS;
        this.pathAnim = null;
      } else {
        this.pathProgress = a.n + Math.max(0, u);
        this.pathMoving = true;
      }
    }
    const p = this.pathProgress;
    const arc = headArc(g, p);
    const region = arc >= 0 ? headRegion(g, arc) : null;
    if (region !== this.pathHead) {
      this.pathHead = region;
      // the camera turns to a region when the head enters it, and only while the path is followed
      if (region && this.pathMoving && this.pathFollow && !this.pathWhole && this.pathSelected === null && !reduced) this.turnTo(region);
    }
    if (region && this.pathMoving) this.regionGlow.add(region, 0.7, 220);
    if (arc !== this.pathVisitedArc) {
      this.pathVisitedArc = arc;
      this.visitedAt(arc);
    }
    const sel = this.pathSelected;
    const range = sel ? g.ranges[sel - 1] : null;
    const stepNow = stepOfProgress(g, p).n;
    this.pathLayer.update({
      arc,
      progress: p,
      selected: range ? { a: range.s, b: range.e } : null,
      activeStep: sel ?? stepNow,
      centre: this.camera.position.distanceTo(this.controls.target),
      unit: (2 * Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.position.distanceTo(this.controls.target)) / Math.max(1, this.height),
      head: { pos: arc >= 0 ? pointAt(g, arc) : null, region, moving: this.pathMoving },
      now,
      reduced,
    });
    // the scrubber follows the head about ten times a second
    const state = stepOfProgress(g, p);
    const key = `${data.id}|${state.n}|${state.fraction.toFixed(2)}|${this.pathMoving}`;
    if (key !== this.pathSent.key && (now - this.pathSent.at > 100 || !this.pathMoving)) {
      this.pathSent = { at: now, key };
      bus.emit("path-progress", { id: data.id, n: state.n, fraction: state.fraction, playing: this.pathMoving });
    }
  }

  /** The hops of the chains that stand on the line: all of them while the whole path is shown, and those of the selected step otherwise. */
  private visibleSubs(): PathSub[] {
    const g = this.pathGeo;
    if (!g?.subs.length) return [];
    if (this.pathWhole) return g.subs;
    return this.pathSelected === null ? [] : g.subs.filter((s) => s.step === this.pathSelected);
  }

  private pathBadgeInput(): Parameters<PathBadges["update"]>[0] {
    const g = this.pathGeo;
    const data = this.pathData;
    return {
      geo: g,
      progress: this.pathProgress,
      selected: this.pathSelected,
      active: g ? stepOfProgress(g, this.pathProgress).n : 0,
      markers: this.pathMarkers,
      subs: this.visibleSubs(),
      project: (p) => this.projectPoint(p),
      ink: (r) => (r ? this.pathInk.get(r) ?? "void" : "void"),
      sentences: (n) => data?.steps[n - 1]?.sentence ?? "",
      blocked: this.blockedBoxes(performance.now()),
      bounds: { left: Math.max(60, this.leftInset), top: FRAME_TOP - 8, right: this.width - 8, bottom: this.height - 8 },
    };
  }

  // ----------------------------------------------------------------- camera

  private flyTo(dir: Vector3, dist: number, target: Vector3, ms = FOCUS_MS): void {
    const cur = this.camera.position.clone().sub(this.controls.target);
    if (reducedMotion()) {
      this.controls.target.copy(target);
      this.camera.position.copy(target).addScaledVector(dir.clone().normalize(), dist);
      this.controls.update();
      return;
    }
    this.tween = {
      t0: performance.now(),
      dur: ms,
      dir0: cur.clone().normalize(),
      dir1: dir.clone().normalize(),
      dist0: cur.length(),
      dist1: dist,
      tgt0: this.controls.target.clone(),
      tgt1: target.clone(),
    };
    this.controls.autoRotate = false;
  }

  /** Turn the camera to a node and select it in the Inspector. */
  focus(id: string): void {
    const b = this.byId.get(id);
    if (!b || !b.visible) return;
    const p = new Vector3(b.x, b.y, b.z);
    const len = p.length() || 1;
    this.flyTo(p.clone().divideScalar(len), 170, p);
    this.pauseOrbit();
  }

  /** The direction of a region from the centre: the hemisphere nearer to the camera, or the only one. */
  private regionDirection(id: RegionId): Vector3 | null {
    const a = this.nearestAnchor(id);
    return a ? new Vector3(a.centre.x, a.centre.y, a.centre.z).normalize() : null;
  }

  /** Turn the camera to a region and close in on it. The other regions fade and the labels of its clusters appear. */
  focusRegion(id: RegionId): void {
    const a = this.nearestAnchor(id);
    if (!a) return;
    const centre = new Vector3(a.centre.x, a.centre.y, a.centre.z);
    this.focused = id;
    this.paintAll();
    // the camera frames the box of the neurons of the region (the rim of the brain may be cropped): the box fills the free
    // area that its callout leaves, so that a scattered region and the largest region both fill about 70 per cent of it
    const dir = centre.clone().normalize().add(new Vector3(0, 0.25, 0)).normalize();
    const frame = this.focusFrame(id, dir);
    this.flyTo(dir, frame.dist, frame.target);
    this.pauseOrbit();
  }

  /** The x range of the free area that the box of a focused region may take: right of the caption column and clear of the control bar. */
  private focusRange(): { xa: number; xb: number } {
    return { xa: Math.max(60, this.leftInset + 8) + this.calloutW + FOCUS_CLEARANCE + 6, xb: this.width - BAR_ROOM };
  }

  /** The distance and target at which the box of the neurons of a region, seen from `dir`, fills the room that its caption leaves. */
  private focusFrame(id: RegionId, dir: Vector3): { dist: number; target: Vector3 } {
    const pts: Vector3[] = [];
    for (const b of this.nodes) if (b.region === id && b.visible) pts.push(new Vector3(b.x, b.y, b.z));
    return this.frameFor(pts, dir, this.focusRange());
  }

  /** The distance and target at which the box of some points, seen from `dir`, fills the x range given. */
  private frameFor(pts: Vector3[], dir: Vector3, range: { xa: number; xb: number }, whole = false): { dist: number; target: Vector3 } {
    const fallback = { dist: START_POSITION.length() * this.draw(), target: new Vector3(0, 0, 0) };
    if (!pts.length || this.width <= 0) return fallback;
    const { s } = this.framing(this.width, this.height);
    const f = this.height / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const right = new Vector3(0, 1, 0).cross(dir).normalize();
    const up = dir.clone().cross(right).normalize();
    const { xa, xb } = range;
    // a path keeps every waypoint in view, with room for the plates beside the badges, where a focus may leave a few neurons outside
    const availW = (xb - xa) * (whole ? 0.78 : 0.97);
    const availH = (this.height - FRAME_TOP - FRAME_BOTTOM) * (whole ? 0.86 : 0.97);
    const co = pts.map((p) => [p.dot(right), p.dot(up), p.dot(dir)]);
    // the 5th to 95th percentile box of the projected neurons is fitted, so that a few outliers may stand at the edge or outside the view.
    // The view centre is the centre of the free area, so the target moves to put the box in the range right of the caption
    const wantX = (xa + xb) / 2 - (Math.min(this.leftInset, this.width * 0.7) + this.width - BAR_ROOM) / 2;
    const fit = fitFocusFrame({ co, sf: s * f, availW, availH, wantX, wantY: 0, minDist: FOCUS_MIN_DISTANCE, maxDist: MAX_DISTANCE * this.draw(), ...(whole ? { lo: 0, hi: 1 } : {}) });
    const target = right.clone().multiplyScalar(fit.mid[0] - fit.shift).addScaledVector(up, fit.mid[1] - fit.lift).addScaledVector(dir, fit.mid[2]);
    return { dist: fit.dist, target };
  }

  /** End a focus: every region returns to full strength and the camera returns to the whole brain. */
  clearFocus(): void {
    if (!this.focused) return;
    this.focused = null;
    this.paintAll();
    this.flyTo(this.camera.position.clone().sub(this.controls.target).normalize(), 320 * this.draw(), new Vector3(0, 0, 0));
  }

  /** True when the keys belong to a field or a window, which is where a person types or moves through a list. */
  private typing(ev: KeyboardEvent): boolean {
    const t = ev.target as HTMLElement | null;
    if (!t || !t.tagName) return false;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return true;
    return !!t.closest?.('[role="dialog"], [role="region"], [role="listbox"], [role="menu"]');
  }

  private onKey = (ev: KeyboardEvent): void => {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target as HTMLInputElement | null;
    // Escape belongs to a field that takes text, but a slider, a switch or a button that has the focus does not keep it
    const entry = !!t && (t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || (t.tagName === "INPUT" && !["range", "checkbox", "radio", "button"].includes(t.type)));
    if (ev.key === "Escape") {
      if (!entry && this.focused) this.clearFocus();
      return;
    }
    if (this.typing(ev)) return;
    switch (ev.key) {
      case "ArrowLeft":
        this.turnBy(TURN_STEP, 0);
        break;
      case "ArrowRight":
        this.turnBy(-TURN_STEP, 0);
        break;
      case "ArrowUp":
        this.turnBy(0, -TURN_STEP);
        break;
      case "ArrowDown":
        this.turnBy(0, TURN_STEP);
        break;
      case "+":
      case "=":
        this.command("zoom-in");
        break;
      case "-":
      case "_":
        this.command("zoom-out");
        break;
      case "0":
        this.command("reset");
        break;
      case "1":
        this.command("view-left");
        break;
      case "2":
        this.command("view-right");
        break;
      case "3":
        this.command("view-top");
        break;
      case "4":
        this.command("view-front");
        break;
      default:
        return;
    }
    ev.preventDefault();
  };

  /** Turn the camera about the brain by an azimuth and a polar angle, spread over the next few frames. */
  private turnBy(az: number, pol: number): void {
    this.turnRest.az += az;
    this.turnRest.pol += pol;
    this.tween = null;
    this.lastTouch = performance.now();
    this.pauseOrbit();
  }

  private stepTurn(): void {
    const r = this.turnRest;
    if (!r.az && !r.pol) return;
    const az = Math.abs(r.az) < 1e-3 ? r.az : r.az * 0.22;
    const pol = Math.abs(r.pol) < 1e-3 ? r.pol : r.pol * 0.22;
    r.az -= az;
    r.pol -= pol;
    const off = this.camera.position.clone().sub(this.controls.target);
    const sph = new Spherical().setFromVector3(off);
    sph.theta += az;
    sph.phi = Math.min(Math.PI - 0.05, Math.max(0.05, sph.phi + pol));
    off.setFromSpherical(sph);
    this.camera.position.copy(this.controls.target).add(off);
  }

  /** The commands of the control group and of the keys: zoom, reset and the four preset views. */
  command(cmd: BrainCommand): void {
    const target = this.controls.target;
    const draw = this.draw();
    this.pauseOrbit();
    this.lastTouch = performance.now();
    if (cmd === "zoom-in" || cmd === "zoom-out") {
      const off = this.camera.position.clone().sub(target);
      const d = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, off.length() * (cmd === "zoom-in" ? 0.8 : 1.25)));
      this.flyTo(off.normalize(), d, target.clone(), ZOOM_MS);
    } else if (cmd === "reset") {
      if (this.focused) {
        this.focused = null;
        this.paintAll();
      }
      this.turnRest = { az: 0, pol: 0 };
      this.flyTo(START_POSITION.clone().normalize(), START_POSITION.length() * draw, new Vector3(0, 0, 0));
    } else {
      const dir = PRESETS[cmd.slice(5)];
      if (dir) this.flyTo(dir, PRESET_DISTANCE * draw, new Vector3(0, 0, 0));
    }
  }

  /** The camera turn at the start of a step. It leaves alone a person who is looking at a node or has just moved the view. */
  private turnTo(id: RegionId): void {
    const now = performance.now();
    if (this.selected || now - this.lastTouch < 4000) return;
    const dir = this.regionDirection(id);
    if (!dir) return;
    const cur = this.camera.position.clone().normalize();
    if (cur.dot(dir) > 0.9) return;
    // a gentle turn: part of the way to the region, not all of it
    const dist = Math.min(340 * this.draw(), Math.max(260, this.camera.position.distanceTo(this.controls.target)));
    const part = cur.clone().lerp(dir, 0.65).add(new Vector3(0, 0.12, 0));
    this.flyTo(part, dist, new Vector3(0, 0, 0), 1400);
  }

  setAmbient(on: boolean): void {
    this.ambient = on;
    this.applyOrbit();
  }

  private applyOrbit(): void {
    this.controls.autoRotate = this.ambient && !this.selected && !reducedMotion() && performance.now() >= this.orbitPausedUntil && !this.tween;
  }

  private pauseOrbit(): void {
    this.orbitPausedUntil = performance.now() + ORBIT_PAUSE_MS;
    this.controls.autoRotate = false;
  }

  private onControlStart = (): void => {
    this.lastTouch = performance.now();
    this.tween = null;
    this.pauseOrbit();
  };

  private stepTween(now: number): void {
    const t = this.tween;
    if (!t) return;
    const u = Math.min(1, (now - t.t0) / t.dur);
    const e = ease(u);
    const q = new Quaternion().setFromUnitVectors(t.dir0, t.dir1);
    const part = new Quaternion().slerp(q, e);
    const dir = t.dir0.clone().applyQuaternion(part);
    const dist = t.dist0 + (t.dist1 - t.dist0) * e;
    this.controls.target.lerpVectors(t.tgt0, t.tgt1, e);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    if (u >= 1) this.tween = null;
  }

  // ------------------------------------------------------------ interaction

  private onPointerMove = (ev: PointerEvent): void => {
    const r = this.container.getBoundingClientRect();
    this.pointer = { x: ev.clientX - r.left, y: ev.clientY - r.top, inside: true, dirty: true };
  };

  private onPointerLeave = (): void => {
    this.pointer.inside = false;
    this.pointer.dirty = true;
  };

  private onPointerDown = (ev: PointerEvent): void => {
    this.down = { x: ev.clientX, y: ev.clientY, t: performance.now() };
  };

  private onPointerUp = (ev: PointerEvent): void => {
    const d = this.down;
    this.down = null;
    if (!d || ev.button !== 0) return;
    if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 5 || performance.now() - d.t > 600) return;
    const r = this.container.getBoundingClientRect();
    const hit = this.pickAt(ev.clientX - r.left, ev.clientY - r.top);
    // a click selects a neuron, and a double-click moves the camera to it (onDoubleClick)
    this.hooks.onSelect(hit ? hit.id : null);
  };

  private onDoubleClick = (ev: MouseEvent): void => {
    const r = this.container.getBoundingClientRect();
    const hit = this.pickAt(ev.clientX - r.left, ev.clientY - r.top);
    if (!hit) return;
    this.hooks.onSelect(hit.id);
    this.focus(hit.id);
  };

  /** The node nearest to a point of the canvas, within a few pixels of its sprite. */
  private pickAt(px: number, py: number): BNode | null {
    let best: BNode | null = null;
    let bestScore = Infinity;
    for (const b of this.nodes) {
      if (!b.visible || this.hidden.has(b.region)) continue;
      const z = this.screen[b.i * 3 + 2];
      if (z > 1 || z < -1) continue;
      const dx = this.screen[b.i * 3] - px;
      const dy = this.screen[b.i * 3 + 1] - py;
      const d = Math.hypot(dx, dy);
      const depth = this.camera.position.distanceTo(new Vector3(b.x, b.y, b.z));
      const reach = Math.max(7, (this.neuronPx(b) * Math.min(1.8, Math.max(0.7, REF_DISTANCE / depth))) / 2 + 4);
      if (d > reach) continue;
      const score = d / reach + z * 0.02;
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best;
  }

  private project(): void {
    const v = new Vector3();
    const w = this.width;
    const h = this.height;
    for (const b of this.nodes) {
      v.set(b.x, b.y, b.z).project(this.camera);
      this.screen[b.i * 3] = (v.x * 0.5 + 0.5) * w;
      this.screen[b.i * 3 + 1] = (-v.y * 0.5 + 0.5) * h;
      this.screen[b.i * 3 + 2] = v.z;
    }
  }

  private updateHover(): void {
    this.pointer.dirty = false;
    const hit = this.pointer.inside && !this.down ? this.pickAt(this.pointer.x, this.pointer.y) : null;
    const id = hit ? hit.id : null;
    if (id !== this.hovered) {
      const before = this.hovered ? this.byId.get(this.hovered) : undefined;
      this.hovered = id;
      // the hovered neuron grows, and the one that was hovered returns to its size
      for (const b of [before, hit ?? undefined]) {
        if (b) this.paintNode(b);
      }
      this.touch("aSize");
      this.container.style.cursor = id ? "pointer" : "";
      this.rebuildLinks();
      this.updateMarkers();
    }
  }

  // ----------------------------------------------------------------- labels

  private labelRec(key: string, build: (el: HTMLDivElement) => void): LabelRec {
    let rec = this.labelPool.get(key);
    if (!rec) {
      const el = document.createElement("div");
      el.className = "text-caption";
      el.style.cssText = `position:absolute;left:0;top:0;white-space:nowrap;color:var(--color-ink);text-shadow:none;padding:1px 6px;border-radius:4px;background:color-mix(in srgb, var(--color-surface) 90%, transparent);font-family:var(--font-sans);will-change:transform;transition:opacity 150ms ease;pointer-events:none;opacity:0`;
      build(el);
      this.overlay.appendChild(el);
      rec = { el, w: el.offsetWidth, h: el.offsetHeight, used: false };
      this.labelPool.set(key, rec);
    }
    return rec;
  }

  /** The caption of a region: its dot in the colour of the region and its category. A hover shows what the region holds. */
  private captionRec(id: RegionId): LabelRec {
    const def = REGIONS.find((r) => r.id === id)!;
    return this.labelRec(`r:${id}`, (el) => {
      el.style.pointerEvents = "auto";
      el.style.cursor = "pointer";
      el.dataset.region = id;
      el.style.fontWeight = "600";
      // a backing pill keeps the name at full contrast, and the border takes the colour of the region while it is focused or hovered
      el.style.cssText += ";text-shadow:none;padding:2px 8px;border-radius:999px;border:1px solid var(--color-rule-strong);background:color-mix(in srgb, var(--color-surface) 92%, transparent)";
      const dot = document.createElement("span");
      dot.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:var(--color-region-${id});box-shadow:0 0 0 1px var(--color-void)`;
      dot.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.textContent = def.label;
      el.append(dot, name);
      el.addEventListener("mouseenter", () => (this.hoverRegion = id));
      el.addEventListener("mouseleave", () => (this.hoverRegion = null));
      el.addEventListener("click", () => {
        this.focusRegion(id);
        this.hooks.onRegion?.(id);
      });
    });
  }

  /** The label of a cluster: the name of its container, beside a dot in the colour of its region. */
  private clusterRec(c: Cluster): LabelRec {
    return this.labelRec(`c:${c.key}`, (el) => {
      el.style.pointerEvents = "auto";
      el.style.cursor = "pointer";
      el.dataset.cluster = c.key;
      el.style.fontWeight = "500";
      const dot = document.createElement("span");
      dot.style.cssText = `display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;background:var(--color-region-${c.region});box-shadow:0 0 0 1px var(--color-void)`;
      dot.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.textContent = c.label.length > 34 ? `${c.label.slice(0, 33)}…` : c.label;
      el.append(dot, name);
      el.addEventListener("click", () => {
        this.focusRegion(c.region);
        this.hooks.onRegion?.(c.region);
      });
    });
  }

  /** The plate of a step of the path: its number, its sentence, its label when the step is a recorded run step, and its findings. */
  private plateRec(n: number, step: TrailStep): LabelRec {
    const key = `s:${this.pathData?.id}:${n}:${step.sentence}`;
    return this.labelRec(key, (el) => {
      el.style.border = "1px solid var(--color-rule-strong)";
      el.style.background = "color-mix(in srgb, var(--color-surface), transparent 4%)";
      el.style.fontWeight = "500";
      el.style.whiteSpace = "normal";
      el.style.maxWidth = "220px";
      const head = document.createElement("div");
      head.textContent = `${n}. ${plateSentence(step.sentence)}`;
      el.appendChild(head);
      if (step.label) {
        const tag = document.createElement("div");
        tag.style.cssText = "font-weight:400;color:var(--color-ink-soft)";
        tag.textContent = step.label;
        el.appendChild(tag);
      }
      for (const m of step.markers ?? []) {
        const line = document.createElement("div");
        line.style.cssText = `font-weight:600;color:${m.severity === "violation" ? "var(--color-block)" : m.severity === "warning" ? "var(--color-hold)" : "var(--color-ink-soft)"}`;
        line.textContent = m.title;
        el.appendChild(line);
      }
    });
  }

  /** The plate of a hop of a chain: its sub-step, its kind, its name and the status of the link that reaches it. */
  private hopRec(sub: PathSub): LabelRec {
    const text = hopLine(sub.step, sub.hop);
    return this.labelRec(`h:${sub.id}:${text}`, (el) => {
      el.style.border = `1px solid var(--color-region-${sub.region})`;
      el.style.background = "color-mix(in srgb, var(--color-surface), transparent 4%)";
      el.style.whiteSpace = "normal";
      el.style.maxWidth = "200px";
      el.textContent = text;
    });
  }

  /** The words at the end of a dashed stub: no link. */
  private stubRec(text: string): LabelRec {
    return this.labelRec(`u:${text}`, (el) => {
      el.style.border = "1px dashed var(--color-block)";
      el.style.background = "color-mix(in srgb, var(--color-surface), transparent 4%)";
      el.style.color = "var(--color-block)";
      el.style.fontWeight = "600";
      el.textContent = text.charAt(0).toUpperCase() + text.slice(1);
    });
  }

  private nodeRec(b: BNode, strong: boolean): LabelRec {
    return this.labelRec(`n:${b.id}:${strong ? "s" : "n"}`, (el) => {
      const name = document.createElement("div");
      name.textContent = shortLabel(b.gn);
      el.style.fontWeight = strong ? "600" : "500";
      // a plate: a border and a nearly opaque backing, so that a step label reads over the neurons
      el.style.border = "1px solid var(--color-rule-strong)";
      el.style.background = "color-mix(in srgb, var(--color-surface), transparent 4%)";
      el.appendChild(name);
      if (strong) {
        // the tooltip of a neuron names its category as well
        const where = document.createElement("div");
        where.style.cssText = "font-weight:400;color:var(--color-ink-soft)";
        const cluster = this.clusterRefs.get(b.id)?.label;
        const category = REGIONS.find((r) => r.id === b.region)?.label ?? "";
        where.textContent = cluster && cluster !== shortLabel(b.gn) ? `${category}, ${cluster}` : category;
        el.appendChild(where);
      }
    });
  }

  private updateLabels(now: number): void {
    for (const r of this.labelPool.values()) r.used = false;
    type Req = LabelRequest & { rec: LabelRec; dim?: number };
    const reqs: Req[] = [];
    const taken = new Set<string>();
    const nodeCount = { n: 0 };
    const camPos = this.camera.position;

    const addNode = (id: string | null, strong: boolean): void => {
      if (!id || taken.has(id) || nodeCount.n >= MAX_NODE_LABELS) return;
      const b = this.byId.get(id);
      if (!b || !b.visible || this.hidden.has(b.region)) return;
      const z = this.screen[b.i * 3 + 2];
      if (z > 1 || z < -1) return;
      taken.add(id);
      nodeCount.n += 1;
      const rec = this.nodeRec(b, strong);
      const d = camPos.distanceTo(new Vector3(b.x, b.y, b.z));
      const radius = (this.neuronPx(b) * (b.id === this.hovered ? HOVER_GROW : 1) * Math.min(1.8, Math.max(0.7, REF_DISTANCE / d))) / 2;
      reqs.push({ key: `n:${id}`, x: this.screen[b.i * 3], y: this.screen[b.i * 3 + 1], w: rec.w, h: rec.h, radius: Math.max(3, radius), rec });
    };

    // The sentence of the step that plays or is selected stands on a plate beside its waypoint, and while the whole path is shown the
    // plates of up to 12 steps do (docs/BRAIN.md, "Rules of 7 October 2026 that change").
    if (this.captionsOn && this.pathGeo && this.pathData) {
      const g = this.pathGeo;
      const steps = this.pathData.steps;
      let picks: number[];
      let urgent = new Set<number>();
      if (this.pathWhole) {
        const markerSteps = [...new Set(this.pathMarkers.map((m) => m.step))];
        picks = platePicks(g.steps, markerSteps, routeRuns(steps, (id) => this.byId.get(id)?.region));
        // the steps with a finding come first, then those of the badge under the pointer, then the rest, so that the first two are placed
        // before the others take the room (a step the pointer names has its plate whatever the other plates are)
        const over = this.pathHover;
        const capOver = over ? this.pathBadges.placed.find((c) => !c.pin && !c.sub && c.steps.includes(over)) : undefined;
        const hovered = capOver ? capOver.steps.slice(0, PATH_HOVER_PLATES_MAX) : over ? [over] : [];
        const ordered = orderPlatePicks(picks, markerSteps, hovered);
        picks = ordered.picks;
        urgent = new Set(ordered.urgent);
      } else {
        const n = this.pathHover ?? this.pathSelected ?? stepOfProgress(g, this.pathProgress).n;
        // a step with a finding keeps its label once the head has reached it
        picks = livePlatePicks(n, [...new Set(this.pathMarkers.map((m) => m.step))], (k) => (g.waypoints[k - 1]?.at ?? Infinity) <= this.pathProgress + 1e-9);
      }
      for (const n of picks) {
        const w = g.waypoints[n - 1];
        const step = steps[n - 1];
        if (!w || !step || w.at > this.pathProgress + 1e-9) continue;
        const sp = this.projectPoint(w.pos);
        if (!sp) continue;
        const rec = this.plateRec(n, step);
        // the plate stands clear of the whole capsule that holds this step, which may list several steps
        const cap = this.pathBadges.placed.find((c) => !c.pin && !c.sub && c.steps.includes(n));
        reqs.push({ key: `s:${n}`, x: sp.x, y: sp.y, w: rec.w, h: rec.h, radius: cap && !cap.moved ? Math.max(13, cap.w / 2 + 2) : 13, rec, far: urgent.has(n) });
      }
      // the hops of the chain of the selected step are named beside their sub-steps, and a missing link ends in the words "no link"
      if (!this.pathWhole && this.pathSelected !== null) {
        for (const sub of g.subs.filter((s) => s.step === this.pathSelected).slice(0, HOP_PLATES_MAX)) {
          const sp = this.projectPoint(sub.pos);
          if (!sp) continue;
          const rec = this.hopRec(sub);
          reqs.push({ key: `h:${sub.step}${sub.letter}`, x: sp.x, y: sp.y, w: rec.w, h: rec.h, radius: 12, rec });
        }
      }
      const current = this.pathSelected ?? stepOfProgress(g, this.pathProgress).n;
      g.stubs.forEach((st, k) => {
        if (!st.label || st.at > this.pathProgress + 1e-9 || !(this.pathWhole || st.step === current)) return;
        const sp = this.projectPoint(st.to);
        if (!sp) return;
        const rec = this.stubRec(st.label);
        reqs.push({ key: `u:${st.step}:${k}`, x: sp.x, y: sp.y, w: rec.w, h: rec.h, radius: 6, rec });
      });
    }

    addNode(this.selected, true);
    addNode(this.hovered, true);

    // The region callouts (callouts.ts) are placed first: each has a dot at the centre of the visible neurons of its region, a
    // caption in a column beside the brain and a leader line. Near a region, or once it is focused, the labels of its clusters
    // are shown as well.
    const closeRegions = new Set<RegionId>();
    const wanted: (CalloutRequest & { rec: LabelRec; id: RegionId })[] = [];
    const edges = this.regionEdges();
    // a focus shows its own callout alone, and the trail panel shows the callouts of the regions of the step that is playing
    // (the lead region of the step: a step that reaches a few neighbouring nodes does not call out their regions)
    const stepRegions = new Set<RegionId>();
    if (this.stepSet && this.stepLabels.region) stepRegions.add(this.stepLabels.region);
    if (this.pathGeo) for (const r of pathCalloutRegions(this.pathVisited, this.pathHead)) stepRegions.add(r);
    const shownIds = new Set(calloutRegions(REGIONS.map((d) => d.id), { focused: this.focused, trail: this.leftInset > 0, stepRegions }));
    for (const def of this.captionsOn ? REGIONS : []) {
      if (this.hidden.has(def.id) || !this.asset || !shownIds.has(def.id)) continue;
      const anchor = this.nearestAnchor(def.id);
      if (!anchor) continue;
      const centre = new Vector3(anchor.centre.x, anchor.centre.y, anchor.centre.z);
      if (labelLevel(camPos.distanceTo(centre), this.focused === def.id) === "clusters") closeRegions.add(def.id);
      const c = centre.clone().project(this.camera);
      if (c.z > 1) continue;
      const rec = this.captionRec(def.id);
      wanted.push({ key: `r:${def.id}`, id: def.id, x: (c.x * 0.5 + 0.5) * this.width, y: (-c.y * 0.5 + 0.5) * this.height, w: rec.w, h: rec.h, rec, edge: edges.get(def.id) });
    }
    const calloutBoxes = this.placeCallouts(wanted, now);
    // in a focus a label keeps 14 pixels from the callout and from its leader, so the labels of the clusters never crowd the caption
    const keepOut = this.focused ? calloutBoxes.flatMap((c) => keepOutBoxes(c.box, c.path, FOCUS_LABEL_CLEARANCE)) : calloutBoxes.map((c) => c.box);

    if (this.captionsOn && now < this.stepLabels.until) for (const id of this.stepLabels.ids.slice(0, STEP_LABELS_MAX)) addNode(id, false);

    // The cluster labels: at most 18, the largest clusters first, each at the centre of its neurons on the side facing the camera.
    if (closeRegions.size) {
      const facing = this.clusters.filter((c) => closeRegions.has(c.region) && (!this.focused || c.region === this.focused) && c.at.x * camPos.x + c.at.y * camPos.y + c.at.z * camPos.z > 0);
      for (const c of pickClusters(facing, this.focused ? MAX_FOCUS_CLUSTER_LABELS : MAX_CLUSTER_LABELS)) {
        const len = Math.hypot(c.at.x, c.at.y, c.at.z) || 1;
        const p = new Vector3(c.at.x * (1 + 4 / len), c.at.y * (1 + 4 / len), c.at.z * (1 + 4 / len)).project(this.camera);
        if (p.z > 1 || p.z < -1) continue;
        const rec = this.clusterRec(c);
        reqs.push({ key: `c:${c.key}`, x: (p.x * 0.5 + 0.5) * this.width, y: (-p.y * 0.5 + 0.5) * this.height, w: rec.w, h: rec.h, radius: 4, centred: true, rec });
      }
    }

    if (this.captionsOn && this.moreLabels) {
      const extra = this.nodes
        .filter((b) => b.visible && LANDMARKS.has(b.gn.type) && !this.hidden.has(b.region) && b.x * camPos.x + b.y * camPos.y + b.z * camPos.z > 0)
        .sort((p, q) => q.heat - p.heat || (p.id < q.id ? -1 : 1));
      for (const b of extra) addNode(b.id, false);
    }

    // the top bar and the rail of the window cover the edges of the canvas, so a label keeps clear of them
    // the badges and the markers are placed first (pathboxes.ts), and the labels keep clear of their real boxes
    const badgeBoxes = this.pathBadges.placed.map((b) => ({ left: b.left - 2, top: b.top - 2, w: b.w + 4, h: b.h + 4 }));
    const placed = placeLabels(reqs, this.width, this.height, 6, { left: Math.max(60, this.leftInset), top: 44, right: 8, bottom: 8 }, [...this.blockedBoxes(now), ...keepOut, ...badgeBoxes]);
    const byKey = new Map(reqs.map((r) => [r.key, r]));
    let leader = 0;
    const drawLeader = (box: { left: number; top: number; w: number; h: number }, x: number, y: number) => {
      const end = leaderEnd(box, x, y);
      const line = this.leaderLine(leader++);
      line.setAttribute("x1", String(Math.round(x)));
      line.setAttribute("y1", String(Math.round(y)));
      line.setAttribute("x2", String(Math.round(end.x)));
      line.setAttribute("y2", String(Math.round(end.y)));
      line.style.display = "";
    };
    // a badge that stands off its node keeps a leader line to the node
    for (const b of this.pathBadges.placed) if (b.moved) drawLeader({ left: b.left, top: b.top, w: b.w, h: b.h }, b.ax, b.ay);
    for (const p of placed) {
      const r = byKey.get(p.key)!;
      r.rec.used = true;
      r.rec.el.style.transform = `translate3d(${Math.round(p.left)}px,${Math.round(p.top)}px,0)`;
      r.rec.el.style.opacity = String(r.dim ?? 1);
      if (p.moved) drawLeader(p, p.x, p.y);
    }
    for (let i = leader; i < this.leaders.length; i += 1) this.leaders[i].style.display = "none";
    for (const [key, rec] of this.labelPool) {
      if (!rec.used) rec.el.style.opacity = "0";
      if (!rec.used && this.labelPool.size > 90 && !key.startsWith("r:")) {
        rec.el.remove();
        this.labelPool.delete(key);
      }
    }
  }

  /** For each region, the visible neuron nearest to the left and to the right edge of the region on screen (the mean of its 6% outermost), so that a leader is short and ends on the region. */
  private regionEdges(): Map<RegionId, { left: Pt; right: Pt }> {
    const by = new Map<RegionId, number[]>();
    for (const b of this.nodes) {
      const z = this.screen[b.i * 3 + 2];
      if (!b.visible || this.hidden.has(b.region) || z <= -1 || z >= 1) continue;
      const list = by.get(b.region);
      if (list) list.push(b.i);
      else by.set(b.region, [b.i]);
    }
    const out = new Map<RegionId, { left: Pt; right: Pt }>();
    const s = this.screen;
    for (const [id, list] of by) {
      if (list.length < 4) continue;
      list.sort((p, q) => s[p * 3] - s[q * 3]);
      const k = Math.max(1, Math.round(list.length * 0.06));
      const mean = (ix: number[]): Pt => ({ x: ix.reduce((t, i) => t + s[i * 3], 0) / ix.length, y: ix.reduce((t, i) => t + s[i * 3 + 1], 0) / ix.length });
      out.set(id, { left: mean(list.slice(0, k)), right: mean(list.slice(-k)) });
    }
    return out;
  }

  /** The projected outline of the brain on the canvas: the convex hull of its sample points and, once Expand moves them, of its neurons. */
  private silhouette(): Pt[] {
    if (!this.asset) return [];
    // a focus keeps its caption clear of the neurons of the region, which fill the view and crop the rim of the brain
    if (this.focused) {
      const own: Pt[] = [];
      for (const b of this.nodes) {
        const z = this.screen[b.i * 3 + 2];
        if (b.region === this.focused && b.visible && z > -1 && z < 1) own.push({ x: this.screen[b.i * 3], y: this.screen[b.i * 3 + 1] });
      }
      if (own.length) return convexHull(own);
    }
    if (!this.hullSource) {
      const src = this.asset.points;
      const keep: number[] = [];
      for (let i = 0; i + 5 < src.length; i += 96) keep.push(src[i], src[i + 1], src[i + 2]);
      this.hullSource = Float32Array.from(keep);
    }
    const e = this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements;
    const pts: Pt[] = [];
    const src = this.hullSource;
    for (let i = 0; i < src.length; i += 3) {
      const x = src[i];
      const y = src[i + 1];
      const z = src[i + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w <= 1) continue;
      pts.push({ x: ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * this.width, y: (-(e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5 + 0.5) * this.height });
    }
    // the neurons lie at the surface and some stand outside the sample points, so they count in the outline
    for (const b of this.nodes) {
      const z = this.screen[b.i * 3 + 2];
      if (b.visible && !this.hidden.has(b.region) && z > -1 && z < 1) pts.push({ x: this.screen[b.i * 3], y: this.screen[b.i * 3 + 1] });
    }
    return convexHull(pts);
  }

  private viewProjection = new Matrix4();

  private calloutShape(id: RegionId): { line: SVGPolylineElement; dot: SVGCircleElement } {
    let shape = this.calloutShapes.get(id);
    if (!shape) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", `var(--color-region-${id})`);
      line.setAttribute("stroke-width", "1");
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("r", "3.5");
      dot.setAttribute("fill", `var(--color-region-${id})`);
      dot.setAttribute("stroke", "var(--color-void)");
      dot.setAttribute("stroke-width", "1");
      this.svg.append(line, dot);
      this.calloutShapes.set(id, (shape = { line, dot }));
    }
    return shape;
  }

  /**
   * Place the region callouts in the columns beside the brain and draw their dots and leader lines. A focused region keeps
   * its callout lit, and the callouts of the other regions stay readable at a lower strength. Returns the boxes taken.
   */
  private placeCallouts(wanted: (CalloutRequest & { rec: LabelRec; id: RegionId })[], now: number): { box: { left: number; top: number; w: number; h: number }; path: Pt[] }[] {
    const shown = new Set<RegionId>();
    const boxes: { box: { left: number; top: number; w: number; h: number }; path: Pt[] }[] = [];
    if (wanted.length) {
      // the widest of all the captions, so that a focus or the trail (which show fewer) does not change the framing
      const widest = Math.max(...REGIONS.filter((d) => !this.hidden.has(d.id)).map((d) => this.captionRec(d.id).w), ...wanted.map((r) => r.w));
      if (Math.abs(widest - this.calloutW) > 3) {
        // the framing leaves room for the widest caption, so it is fitted again when the captions are first measured
        this.calloutW = widest;
        this.fit();
      }
      const safe = { left: Math.max(60, this.leftInset + 8), top: FRAME_TOP, right: 8, bottom: FRAME_BOTTOM };
      const placed = this.focused ? this.focusCallouts(wanted, safe, now) : layoutCallouts(wanted, this.silhouette(), {
        width: this.width,
        height: this.height,
        safe,
        blocked: this.blockedBoxes(now),
        gap: 6,
        clearance: 30,
      });
      const byKey = new Map(wanted.map((r) => [r.key, r]));
      for (const p of placed) {
        const r = byKey.get(p.key)!;
        const id = r.id;
        const on = this.focused === id;
        const lit = on || this.hoverRegion === id || (!!this.pathGeo && this.pathHead === id);
        const quiet = !!this.pathGeo && this.pathVisited.size > 0 && this.pathHead !== id;
        const fade = this.focused && !on ? CALLOUT_FADE : quiet ? PATH_CALLOUT_VISITED : 1;
        r.rec.used = true;
        r.rec.el.style.transform = `translate3d(${Math.round(p.left)}px,${Math.round(p.top)}px,0)`;
        r.rec.el.style.opacity = String(fade);
        r.rec.el.style.borderColor = lit ? `var(--color-region-${id})` : "var(--color-rule-strong)";
        r.rec.el.style.boxShadow = on ? `0 0 0 1px var(--color-region-${id})` : "none";
        const def = REGIONS.find((d) => d.id === id)!;
        const title = `${def.holds}. ${this.counts[id]} ${this.counts[id] === 1 ? "node" : "nodes"}.`;
        if (r.rec.el.title !== title) r.rec.el.title = title;
        const shape = this.calloutShape(id);
        shape.line.setAttribute("points", p.path.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" "));
        shape.line.setAttribute("stroke-width", lit ? "2" : "1");
        // while a path is drawn, every leader is neutral and dashed, so that it never reads as a piece of the path or, in the red of a
        // region, as a fault. The caption of the region of the head keeps its colour (13 October 2026)
        const neutral = !!this.pathGeo;
        const stroke = neutral ? "var(--color-rule-strong)" : `var(--color-region-${id})`;
        if (shape.line.getAttribute("stroke") !== stroke) {
          shape.line.setAttribute("stroke", stroke);
          shape.line.setAttribute("stroke-dasharray", neutral ? "3 3" : "none");
        }
        shape.dot.setAttribute("cx", p.dot.x.toFixed(1));
        shape.dot.setAttribute("cy", p.dot.y.toFixed(1));
        for (const el of [shape.line, shape.dot]) {
          el.style.display = "";
          el.style.opacity = String(fade);
        }
        shown.add(id);
        boxes.push({ box: { left: p.left, top: p.top, w: p.w, h: p.h }, path: p.path });
      }
    }
    for (const [id, shape] of this.calloutShapes) {
      if (!shown.has(id)) {
        shape.line.style.display = "none";
        shape.dot.style.display = "none";
      }
    }
    return boxes;
  }

  /** The caption of the focused region: in the free margin beside its neurons, or at the top left, clear of every neuron (callouts.ts). */
  private focusCallouts(wanted: (CalloutRequest & { rec: LabelRec; id: RegionId })[], safe: { left: number; top: number; right: number; bottom: number }, now: number): PlacedCallout[] {
    const own: Pt[] = [];
    for (const b of this.nodes) {
      const z = this.screen[b.i * 3 + 2];
      if (b.region === this.focused && b.visible && z > -1 && z < 1) own.push({ x: this.screen[b.i * 3], y: this.screen[b.i * 3 + 1] });
    }
    return wanted.map((r) => layoutFocusCallout(r, own, { width: this.width, height: this.height, safe, blocked: this.blockedBoxes(now), clearance: 28, radius: 4, view: { left: safe.left, top: safe.top, w: this.width - BAR_ROOM - safe.left, h: this.height - safe.top - safe.bottom } }));
  }

  private blocked: { left: number; top: number; w: number; h: number }[] = [];
  private blockedAt = -Infinity;

  /** The boxes that other parts of the window cover over the canvas (the control group, the thought trail), measured twice a second. */
  private blockedBoxes(now: number): { left: number; top: number; w: number; h: number }[] {
    if (now - this.blockedAt < 500) return this.blocked;
    this.blockedAt = now;
    const origin = this.container.getBoundingClientRect();
    this.blocked = [...(this.container.parentElement?.querySelectorAll("[data-brain-block]") ?? [])].map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left - origin.left - 4, top: r.top - origin.top - 4, w: r.width + 8, h: r.height + 8 };
    });
    return this.blocked;
  }

  private leaderLine(i: number): SVGLineElement {
    while (this.leaders.length <= i) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("stroke", "var(--color-ink-soft)");
      line.setAttribute("stroke-width", "1");
      line.style.display = "none";
      this.svg.appendChild(line);
      this.leaders.push(line);
    }
    return this.leaders[i];
  }

  /**
   * The anchor of a region on the side that faces the camera. It is taken from the neurons as drawn, and a region with
   * none shown falls back to the label anchor of the brain asset.
   */
  private nearestAnchor(id: RegionId): Anchor | null {
    this.refreshAnchors();
    let best: Anchor | null = null;
    let top = -Infinity;
    for (const a of this.anchors) {
      if (a.region !== id) continue;
      const s = a.centre.x * this.camera.position.x + a.centre.y * this.camera.position.y + a.centre.z * this.camera.position.z;
      if (s > top) {
        top = s;
        best = a;
      }
    }
    if (best || !this.asset) return best;
    for (const e of this.asset.manifest.regions) {
      if (e.id !== id || !e.labelAnchor) continue;
      const v = { x: e.labelAnchor[0], y: e.labelAnchor[1], z: e.labelAnchor[2] };
      const s = v.x * this.camera.position.x + v.y * this.camera.position.y + v.z * this.camera.position.z;
      if (s > top) {
        top = s;
        best = { region: id, hemisphere: e.hemisphere, centre: v, caption: v, count: 0, spread: 20 };
      }
    }
    return best;
  }

  // ------------------------------------------------------------------- loop

  private start(): void {
    if (this.raf || this.disposed) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.raf = 0;
    if (this.disposed || document.hidden) return;
    const dt = Math.min(100, Math.max(0, now - this.last));
    this.last = now;

    if (this.waiting.length) {
      const rest: Pending[] = [];
      for (const p of this.waiting) {
        if (p.due > now) rest.push(p);
        else this.spawn(p, now);
      }
      this.waiting = rest;
    }

    const { active, ended } = this.tracker.step(dt);
    if (active.length || ended.length) {
      const glow = this.attr("aGlow");
      for (const id of active) {
        const b = this.byId.get(id);
        if (b) glow[b.i] = this.glowFor(b);
      }
      for (const id of ended) {
        const b = this.byId.get(id);
        if (b) glow[b.i] = this.glowFor(b);
      }
      this.touch("aGlow");
    }
    this.regionGlow.step(dt);
    // the bloom is faint at rest, so that dense clusters show single neurons, and it rises while a neuron fires or is selected
    const bloomTarget = this.tracker.size > 0 || this.selected ? BLOOM_FIRING : this.pathMoving ? PATH_BLOOM_MOVING : BLOOM_REST;
    this.bloom.strength += (bloomTarget - this.bloom.strength) * Math.min(1, dt / 160);
    for (const [id, mat] of this.surfaces) mat.uniforms.uGlow.value = id === "shell" ? 0 : Math.min(1, this.regionGlow.glow(id));

    if (this.pulses.length || this.rings.length || this.fxCount) this.writeEffects(now);

    this.stepExpand(dt);
    if (this.stepSet && now > this.stepLabels.until) {
      this.stepSet = null;
      this.paintAll();
    }
    this.stepTurn();
    this.stepTween(now);
    this.stepPath(now);
    if (!this.tween && !this.selected && this.ambient && now >= this.orbitPausedUntil && !reducedMotion()) this.controls.autoRotate = true;
    this.controls.update();

    // the far side of the brain is the part beyond the distance of the point that the camera looks at
    this.nodeMat.uniforms.uCentre.value = this.camera.position.distanceTo(this.controls.target);

    this.camera.updateMatrixWorld();
    this.project();
    if (this.pointer.dirty) this.updateHover();
    this.composer.render();
    if (this.pathGeo) this.pathBadges.update(this.pathBadgeInput());
    this.updateLabels(now);
    this.raf = requestAnimationFrame(this.frame);
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else {
      const gap = performance.now() - this.last;
      for (const p of this.waiting) p.due += gap;
      this.start();
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("keydown", this.onKey);
    this.container.removeEventListener("pointermove", this.onPointerMove);
    this.container.removeEventListener("pointerleave", this.onPointerLeave);
    this.container.removeEventListener("pointerdown", this.onPointerDown);
    this.container.removeEventListener("pointerup", this.onPointerUp);
    this.container.removeEventListener("dblclick", this.onDoubleClick);
    this.controls.removeEventListener("start", this.onControlStart);
    this.controls.dispose();
    for (const m of this.surfaces.values()) m.dispose();
    this.depthMat?.dispose();
    for (const l of [this.solid, this.dashed]) {
      l.geometry.dispose();
      (l.material as LineBasicMaterial).dispose();
    }
    this.nodeGeo.dispose();
    this.nodeMat.dispose();
    this.pathLayer.dispose();
    this.pathBadges.dispose();
    this.fx.geometry.dispose();
    this.markers.geometry.dispose();
    this.fxMat.dispose();
    this.markerMat.dispose();
    this.brainRoot?.traverse((o) => (o as Mesh).geometry?.dispose());
    this.bloom.dispose();
    this.output.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.container.style.cursor = "";
    this.container.replaceChildren();
  }
}
