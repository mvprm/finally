import type { PricePoint } from "@/logic/priceBuffer";

interface Props {
  points: PricePoint[] | undefined;
  /** Session baseline; the line is drawn green above it, red below. */
  baseline: number | undefined;
  width?: number;
  height?: number;
}

/** Inline SVG sparkline, no chart library (PLAN.md §10). */
export function Sparkline({ points, baseline, width = 76, height = 22 }: Props) {
  if (!points || points.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line x1="0" x2={width} y1={height / 2} y2={height / 2} stroke="#252f3d" strokeDasharray="2 3" />
      </svg>
    );
  }
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
  }
  if (baseline !== undefined) {
    min = Math.min(min, baseline);
    max = Math.max(max, baseline);
  }
  const span = max - min || 1;
  const pad = 1.5;
  const t0 = points[0].time;
  const tSpan = points[points.length - 1].time - t0 || 1;
  const x = (t: number) => ((t - t0) / tSpan) * width;
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.time).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const last = points[points.length - 1].value;
  const color = baseline === undefined || last === baseline ? "#8b97a7" : last > baseline ? "#2bb673" : "#e5484d";

  return (
    <svg width={width} height={height} aria-hidden="true" className="overflow-visible">
      {baseline !== undefined && (
        <line x1="0" x2={width} y1={y(baseline)} y2={y(baseline)} stroke="#34404f" strokeDasharray="1 2" />
      )}
      <path d={d} fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" />
      <circle cx={x(points[points.length - 1].time)} cy={y(last)} r="1.75" fill={color} />
    </svg>
  );
}
