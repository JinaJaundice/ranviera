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
