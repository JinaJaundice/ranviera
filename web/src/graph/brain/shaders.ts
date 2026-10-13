// The shaders of the brain scene. Colours reach them in linear space, because the scene renders into a linear
// target and the output pass converts it to sRGB.

/**
 * The nodes: a bright core with a soft halo. The core keeps its size in pixels (aSize is the core diameter in CSS pixels
 * at the reference distance, and it follows the zoom within limits), a glow widens the halo only, and a node on the far
 * side of the brain is dimmed so that depth stays readable.
 */
export const NODE_VERTEX = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aGlow;
attribute float aAlpha;
uniform float uRatio;
uniform float uRef;
uniform float uCentre;
uniform float uFar;
varying vec3 vColor;
varying float vGlow;
varying float vAlpha;
varying float vCore;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(1.0, -mv.z);
  float zoom = clamp(uRef / d, 0.7, 1.8);
  float grow = 1.0 + 0.9 * aGlow;
  float farSide = smoothstep(uCentre - 12.0, uCentre + 70.0, d);
  float core = aSize * zoom * (1.0 - 0.22 * farSide);
  gl_PointSize = clamp(core * 2.5 * grow * uRatio, 3.0, 260.0);
  vCore = 1.0 / (2.5 * grow);
  vColor = aColor;
  vGlow = aGlow;
  vAlpha = aAlpha * (1.0 - uFar * farSide);
  gl_Position = projectionMatrix * mv;
}`;

export const NODE_FRAGMENT = /* glsl */ `
#define HALO_REST 0.04
uniform float uBloom;
uniform float uOutline;
varying vec3 vColor;
varying float vGlow;
varying float vAlpha;
varying float vCore;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float edge = max(vCore, 0.12);
  float core = 1.0 - smoothstep(edge * 0.8, edge, r);
  float halo = (1.0 - smoothstep(edge, 1.0, r));
  halo = halo * halo * (HALO_REST + 0.8 * vGlow);
  float a = max(core, halo) * vAlpha;
  if (a < 0.01) discard;
  float centre = 1.0 - clamp(r / edge, 0.0, 1.0);
  vec3 c = mix(vColor, vec3(1.0), 0.32 * centre + 0.12 * vGlow * uBloom);
  float ring = smoothstep(edge * 0.62, edge * 0.9, r) * core;
  c = mix(c, vColor * 0.5, ring * uOutline);
  c *= 1.0 + 0.5 * vGlow * uBloom;
  gl_FragColor = vec4(c, a);
}`;

/** Pulses and rings: kind 0 is a soft dot, 1 a ring, 2 a dashed ring for a predicted step. */
export const FX_VERTEX = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
attribute float aKind;
uniform float uPx;
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(1.0, -mv.z);
  gl_PointSize = clamp(aSize * uPx / d, 2.0, 160.0);
  vColor = aColor;
  vAlpha = aAlpha;
  vKind = aKind;
  gl_Position = projectionMatrix * mv;
}`;

export const FX_FRAGMENT = /* glsl */ `
uniform float uBloom;
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a;
  if (vKind < 0.5) {
    a = pow(1.0 - r, 1.8);
  } else {
    a = smoothstep(0.62, 0.8, r) * (1.0 - smoothstep(0.9, 1.0, r));
    if (vKind > 1.5) {
      float seg = fract(atan(p.y, p.x) * 1.909859);
      if (seg > 0.5) discard;
    }
  }
  a *= vAlpha;
  if (a < 0.01) discard;
  vec3 c = vColor * (1.0 + 1.2 * uBloom);
  gl_FragColor = vec4(c, a);
}`;

/** The surface of a region or of the shell: a rim-lit translucent material whose rim follows the view angle. */
export const SURFACE_VERTEX = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

export const SURFACE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uRimColor;
uniform float uOpacity;
uniform float uRim;
uniform float uPower;
uniform float uGlow;
uniform float uSurface;
uniform float uSolid;
uniform float uTint;
uniform vec3 uNeutral;
uniform float uNeutralOpacity;
uniform float uNeutralRim;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), uPower);
  // The Surface value runs from 0 (hidden) to 1 (solid) and is 0.25 at the default, where uOpacity and uRim apply as they stand.
  float level = uSurface / 0.25;
  float solid = max(0.0, uSurface - 0.25) * 1.2 * uSolid;
  // At rest (uTint 0) a region draws as part of one neutral silhouette, and its own colour comes in over a focus or a firing.
  float k = clamp(uTint + uGlow * 4.0, 0.0, 1.0);
  float tinted = ((uOpacity + f * uRim) * level + solid) * uTint + uGlow * (0.04 + f * 0.22) * min(1.0, level);
  float neutral = (uNeutralOpacity + f * uNeutralRim) * level;
  float a = mix(neutral, tinted, k);
  vec3 c = mix(uNeutral, mix(uColor, uRimColor, clamp(f + uGlow, 0.0, 1.0)), k);
  gl_FragColor = vec4(c, clamp(a, 0.0, 0.92));
}`;

// ------------------------------------------------------------------- the traced path (docs/BRAIN.md, 13 October 2026)

/** Replace `from` by `to` once, and fail loudly when three.js has changed the line material so that the anchor is gone. */
function patch(source: string, from: string, to: string): string {
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) throw new Error(`the line shader has no single anchor ${JSON.stringify(from)}`);
  return source.slice(0, at) + to + source.slice(at + from.length);
}

/**
 * The line material of three.js (Line2) with the arc length of each piece added. The vertex shader passes the arc length and the
 * depth to the fragment shader and tapers the width behind the head, and the fragment shader clips the line at the head
 * (uHead, in arc length), fades the trail behind the comet, dims what lies outside a selected step and what lies on the far side
 * of the brain. Each piece of the line is an instance, and its two arc lengths are the attribute instanceArc.
 */
export function patchLineVertex(src: string): string {
  let s = patch(src, "attribute vec3 instanceColorEnd;", "attribute vec3 instanceColorEnd;\n\t\tattribute vec2 instanceArc;\n\t\tattribute float instanceStyle;\n\t\tattribute float instanceInner;\n\t\tvarying float vInner;\n\t\tuniform float uHead;\n\t\tuniform float uComet;\n\t\tuniform float uWide;\n\t\tuniform float uSelA;\n\t\tuniform float uSelB;\n\t\tuniform float uSelOn;\n\t\tuniform float uClip;\n\t\tvarying float vArc;\n\t\tvarying float vStyle;\n\t\tvarying float vDepth;");
  s = patch(s, "float aspect = resolution.x / resolution.y;", "float aspect = resolution.x / resolution.y;\n\t\t\tfloat arcHere = ( position.y < 0.5 ) ? instanceArc.x : instanceArc.y;\n\t\t\tfloat taper = ( uClip > 0.5 && arcHere <= uHead ) ? 1.0 - smoothstep( 0.0, uComet, uHead - arcHere ) : 0.0;\n\t\t\tfloat chosen = uSelOn * step( uSelA - 0.001, arcHere ) * step( arcHere, uSelB + 0.001 );\n\t\t\tfloat widen = 1.0 + ( uWide - 1.0 ) * max( taper, chosen );\n\t\t\tvArc = arcHere;\n\t\t\tvStyle = instanceStyle;\n\t\t\tvInner = instanceInner;");
  s = patch(s, "offset *= linewidth;", "offset *= linewidth * widen;");
  s = patch(s, "vec4 mvPosition = ( position.y < 0.5 ) ? start : end; // this is an approximation", "vec4 mvPosition = ( position.y < 0.5 ) ? start : end; // this is an approximation\n\t\t\tvDepth = - mvPosition.z;");
  return s;
}

export function patchLineFragment(src: string): string {
  let s = patch(src, "varying float vLineDistance;", "varying float vLineDistance;\n\t\tvarying float vArc;\n\t\tvarying float vStyle;\n\t\tvarying float vDepth;\n\t\tuniform float uUnit;\n\t\tuniform vec4 uPattern;\n\t\tuniform float uHead;\n\t\tuniform float uComet;\n\t\tuniform float uTrail;\n\t\tuniform float uSelA;\n\t\tuniform float uSelB;\n\t\tuniform float uSelOn;\n\t\tuniform float uDim;\n\t\tuniform float uClip;\n\t\tuniform float uFar;\n\t\tuniform float uCentre;\n\t\tuniform float uBoost;\n\t\tuniform float uInner;\n\t\tvarying float vInner;");
  s = patch(
    s,
    "gl_FragColor = vec4( diffuseColor.rgb, alpha );",
    [
      "if ( uClip > 0.5 && vArc > uHead ) discard;",
      // the pattern of a segment, in pixels along the line: vStyle 1 is dashed and 2 is dotted (uPattern holds the length on and the period of each)
      "\t\t\tif ( vStyle > 0.5 ) { float along = vArc / max( uUnit, 0.0001 ); vec2 pat = ( vStyle < 1.5 ) ? uPattern.xy : uPattern.zw; if ( mod( along, pat.y ) > pat.x ) discard; }",
      "\t\t\tfloat comet = ( uClip > 0.5 ) ? 1.0 - smoothstep( 0.0, uComet, uHead - vArc ) : 0.0;",
      "\t\t\tfloat chosen = step( uSelA - 0.001, vArc ) * step( vArc, uSelB + 0.001 );",
      "\t\t\tfloat keep = ( uSelOn > 0.5 ) ? mix( uDim, 1.0, chosen ) : mix( uTrail, 1.0, comet );",
      // a piece inside one step (the hops of a chain) is faint unless its step is chosen or the head is on it
      "\t\t\tkeep *= mix( 1.0, uInner, step( 0.5, vInner ) * ( 1.0 - uSelOn * chosen ) * ( 1.0 - comet ) );",
      "\t\t\tfloat farSide = smoothstep( uCentre - 12.0, uCentre + 70.0, vDepth );",
      "\t\t\tfloat shown = alpha * keep * ( 1.0 - ( 1.0 - uFar ) * farSide );",
      "\t\t\tgl_FragColor = vec4( diffuseColor.rgb * ( 1.0 + uBoost * comet ), shown );",
    ].join("\n"),
  );
  return s;
}

/**
 * Sprites with a size in pixels: the head, its resting ring, the knots, the branch knots, the hollow waypoints and the dots of the
 * previous path. A sprite appears when the progress reaches its aAt. The kind is 0 for a soft disc with a glow, 1 for a solid disc
 * with an edge in the colour of the background, 2 for a ring and 3 for a dashed ring.
 */
export const SPRITE_VERTEX = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
attribute float aKind;
attribute float aAt;
uniform float uRatio;
uniform float uProgress;
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float on = step(aAt - 0.000001, uProgress);
  gl_PointSize = max(1.0, aSize * uRatio * on);
  vColor = aColor;
  vAlpha = aAlpha * on;
  vKind = aKind;
  gl_Position = projectionMatrix * mv;
}`;

export const SPRITE_FRAGMENT = /* glsl */ `
uniform float uBloom;
uniform vec3 uEdge;
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0 || vAlpha < 0.01) discard;
  vec3 c = vColor;
  float a;
  if (vKind < 0.5) {
    float core = 1.0 - smoothstep(0.34, 0.5, r);
    float halo = pow(1.0 - r, 2.0) * 0.8;
    a = max(core, halo) * vAlpha;
    c = mix(vColor, vec3(1.0), 0.55 * core) * (1.0 + 1.4 * uBloom * core);
  } else if (vKind < 1.5) {
    float edge = smoothstep(0.62, 0.78, r);
    c = mix(vColor, uEdge, edge);
    a = (1.0 - smoothstep(0.9, 1.0, r)) * vAlpha;
  } else {
    a = smoothstep(0.55, 0.7, r) * (1.0 - smoothstep(0.88, 1.0, r)) * vAlpha;
    if (vKind > 2.5) {
      float seg = fract(atan(p.y, p.x) * 1.909859);
      if (seg > 0.5) discard;
    }
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(c, a);
}`;
