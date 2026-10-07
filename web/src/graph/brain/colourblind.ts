// Colour difference under simulated colour blindness, for the test of the region tokens. The simulation is the
// matrices of Machado, Oliveira and Fernandes (2009) at full severity, applied to linear sRGB, and the difference is
// CIEDE2000 in CIELAB (Sharma, Wu and Dalal, 2005). contrastRatio is the WCAG 2 ratio.
import type { Rgb } from "../palette";

export type Vision = "normal" | "deuteranopia" | "protanopia" | "tritanopia";

const MATRIX: Record<Exclude<Vision, "normal">, number[][]> = {
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};
const TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const WHITE = [0.95047, 1, 1.08883];

const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const mul = (m: number[][], v: number[]): number[] => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

export function toLab(rgb: Rgb, vision: Vision = "normal"): [number, number, number] {
  let l = rgb.map(lin);
  if (vision !== "normal") l = mul(MATRIX[vision], l).map((v) => Math.min(1, Math.max(0, v)));
  const xyz = mul(TO_XYZ, l).map((v, i) => v / WHITE[i]);
  const f = xyz.map((t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116));
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

const rad = (d: number): number => (d * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;

/** CIEDE2000 between two CIELAB colours. */
export function ciede2000(p: [number, number, number], q: [number, number, number]): number {
  const [L1, a1, b1] = p;
  const [L2, a2, b2] = q;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hp = (b: number, a: number): number => (b === 0 && a === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360);
  const h1p = hp(b1, a1p);
  const h2p = hp(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360;
    hbp /= 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.2 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

export function deltaE(a: Rgb, b: Rgb, vision: Vision): number {
  return ciede2000(toLab(a, vision), toLab(b, vision));
}

/** WCAG 2 relative luminance. */
export function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two colours, from 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The smallest difference between any two colours of the list, and the pair that has it. */
export function minPairwise(colours: Rgb[], vision: Vision): { min: number; pair: [number, number] } {
  let min = Infinity;
  let pair: [number, number] = [0, 0];
  for (let i = 0; i < colours.length; i += 1) {
    for (let j = i + 1; j < colours.length; j += 1) {
      const d = deltaE(colours[i], colours[j], vision);
      if (d < min) {
        min = d;
        pair = [i, j];
      }
    }
  }
  return { min, pair };
}
