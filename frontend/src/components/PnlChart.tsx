"use client";

import { BaselineSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useMemo, useRef } from "react";
import { formatMoney } from "@/logic/format";
import type { Snapshot } from "@/logic/types";
import { baseChartOptions, formatWholeDollars } from "./chartTheme";
import { Panel } from "./Panel";

/** Snapshots to chart points: seconds, ascending, one point per second (the last wins). */
export function snapshotsToPoints(history: Snapshot[]): { time: UTCTimestamp; value: number }[] {
  const bySecond = new Map<number, number>();
  for (const s of history) {
    const t = Math.floor(Date.parse(s.recorded_at) / 1000);
    if (Number.isFinite(t)) bySecond.set(t, s.total_value);
  }
  return [...bySecond.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

export function PnlChart({ history }: { history: Snapshot[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
  const points = useMemo(() => snapshotsToPoints(history), [history]);
  const start = points[0]?.value;

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, baseChartOptions(false));
    // Green above the first snapshot, red below it.
    const series = chart.addSeries(BaselineSeries, {
      lineWidth: 2,
      topLineColor: "#2bb673",
      topFillColor1: "rgba(43, 182, 115, 0.25)",
      topFillColor2: "rgba(43, 182, 115, 0.02)",
      bottomLineColor: "#e5484d",
      bottomFillColor1: "rgba(229, 72, 77, 0.02)",
      bottomFillColor2: "rgba(229, 72, 77, 0.25)",
      priceLineVisible: false,
      priceFormat: { type: "custom", formatter: formatWholeDollars, minMove: 1 },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (start !== undefined) series.applyOptions({ baseValue: { type: "price", price: start } });
    series.setData(points);
    chartRef.current?.timeScale().fitContent();
  }, [points, start]);

  return (
    <div data-testid="pnl-chart" data-points={points.length} className="h-full min-h-0">
    <Panel title="Portfolio value" aside={start !== undefined ? `baseline ${formatMoney(start)}` : undefined} bodyClassName="relative">
      <div ref={containerRef} className="absolute inset-0" />
      {points.length < 2 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-faint">
          Value is recorded every 30 seconds and after each trade. The line fills in as snapshots arrive.
        </div>
      )}
    </Panel>
    </div>
  );
}
