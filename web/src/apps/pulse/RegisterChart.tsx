import type { RegisterDay } from "@shared/types";
import { Empty } from "../../components/Empty";

const W = 640;
const H = 220;
const M = { l: 52, r: 16, t: 16, b: 44 };

/** Faults per reply by day. The axis starts at zero, the latest day is marked and labelled, and colour is a token. */
export function RegisterChart({ days }: { days: RegisterDay[] }) {
  const pts = days.map((d) => ({ day: d.day, v: d.replies > 0 ? d.faults / d.replies : 0, replies: d.replies }));
  if (pts.length === 0) return <Empty>No replies have been scored yet.</Empty>;

  const top = Math.max(0.5, ...pts.map((p) => p.v));
  const max = Math.ceil(top * 2) / 2;
  const iw = W - M.l - M.r;
  const ih = H - M.t - M.b;
  const x = (i: number) => M.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v: number) => M.t + ih - (v / max) * ih;
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const ticks = [0, max / 2, max];
  const last = pts[pts.length - 1];
  const lastX = x(pts.length - 1);
  const labelRight = lastX > W - 90;
  const every = Math.max(1, Math.ceil(pts.length / 6));
  const shortDay = (d: string) => d.slice(5);

  return (
    <figure className="min-w-0">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Register faults per reply by day, last 30 days" className="h-auto w-full">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} className="stroke-rule" strokeWidth={1} />
            <text x={M.l - 6} y={y(t) + 4} textAnchor="end" className="fill-ink-soft text-caption">
              {t.toFixed(1)}
            </text>
          </g>
        ))}
        {pts.map((p, i) =>
          i % every === 0 ? (
            <text key={p.day} x={x(i)} y={H - M.b + 16} textAnchor="middle" className="fill-ink-soft text-caption">
              {shortDay(p.day)}
            </text>
          ) : null,
        )}
        <text x={M.l + iw / 2} y={H - 6} textAnchor="middle" className="fill-ink-soft text-caption">
          Day
        </text>
        <text transform={`translate(12 ${M.t + ih / 2}) rotate(-90)`} textAnchor="middle" className="fill-ink-soft text-caption">
          Faults per reply
        </text>
        <path d={line} fill="none" className="stroke-signal" strokeWidth={2} strokeLinejoin="round" />
        <circle cx={lastX} cy={y(last.v)} r={4} className="fill-signal" />
        <text x={labelRight ? lastX - 8 : lastX + 8} y={y(last.v) - 8} textAnchor={labelRight ? "end" : "start"} className="fill-ink text-caption">
          {last.v.toFixed(2)} on {shortDay(last.day)}
        </text>
      </svg>
      <figcaption className="mt-1 flex items-center gap-2 text-small text-ink-soft">
        <span className="inline-block h-0.5 w-5 bg-signal" aria-hidden="true" />
        Faults per reply on each day, with the latest day marked.
      </figcaption>
    </figure>
  );
}
