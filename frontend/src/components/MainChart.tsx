"use client";

import { AreaSeries, createChart, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { formatMoney, formatPercent, formatSignedMoney, signOf } from "@/logic/format";
import { sessionChangePercent } from "@/logic/portfolio";
import type { PricePoint } from "@/logic/priceBuffer";
import { baseChartOptions } from "./chartTheme";
import { Panel } from "./Panel";

const tone = { positive: "text-up", negative: "text-down", flat: "text-dim" } as const;

interface Props {
  ticker: string | null;
  points: PricePoint[] | undefined;
  price: number | null;
  firstPrice: number | undefined;
  /** Average cost when the ticker is held, drawn as a reference line. */
  avgCost: number | null;
}

export function MainChart({ ticker, points, price, firstPrice, avgCost }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const costLineRef = useRef<IPriceLine | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, baseChartOptions(true));
    const series = chart.addSeries(AreaSeries, {
      lineColor: "#209dd7",
      lineWidth: 2,
      topColor: "rgba(32, 157, 215, 0.28)",
      bottomColor: "rgba(32, 157, 215, 0.02)",
      priceLineColor: "#209dd7",
      priceLineStyle: LineStyle.Dotted,
      lastValueVisible: true,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      costLineRef.current = null;
    };
  }, []);

  // Redraw from the buffer: at most PRICE_BUFFER_POINTS points, so a full setData is cheap.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData((points ?? []).map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    chartRef.current?.timeScale().fitContent();
  }, [points, ticker]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (costLineRef.current) {
      series.removePriceLine(costLineRef.current);
      costLineRef.current = null;
    }
    if (avgCost != null) {
      costLineRef.current = series.createPriceLine({
        price: avgCost,
        color: "#ecad0a",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "avg cost",
      });
    }
  }, [avgCost, ticker]);

  const change = sessionChangePercent(firstPrice, price);
  const changeAbs = firstPrice != null && price != null ? price - firstPrice : null;
  const sign = signOf(change);

  // The test id wraps the whole panel so its text includes the selected symbol.
  return (
    <div data-testid="main-chart" data-ticker={ticker ?? ""} className="h-full min-h-0">
    <Panel
      title={ticker ?? "Chart"}
      aside={ticker ? "price since page load" : undefined}
      bodyClassName="relative"
      actions={
        ticker && (
          <div className="num flex items-baseline gap-3 text-[12.5px]">
            <span className="font-semibold text-text">{formatMoney(price)}</span>
            <span className={tone[sign]}>
              {formatSignedMoney(changeAbs)} ({formatPercent(change)})
            </span>
          </div>
        )
      }
    >
      <div ref={containerRef} className="absolute inset-0" />
      {ticker && (!points || points.length < 2) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-faint">
          Waiting for prices on {ticker}…
        </div>
      )}
      {!ticker && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-faint">
          Select a symbol in the watchlist to chart it.
        </div>
      )}
    </Panel>
    </div>
  );
}
