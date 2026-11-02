// The natural width of a rendered diagram, from its viewBox. A degenerate svg falls back to 600.
export function chartWidth(svg: string): number {
  const vb = /viewBox="[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+[\d.]+"/.exec(svg);
  const w = vb ? Number(vb[1]) : Number(/\swidth="([\d.]+)"/.exec(svg)?.[1] ?? 0);
  return w > 0 ? w : 600;
}
