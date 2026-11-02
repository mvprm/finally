"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatMoney, formatPercent, signOf } from "@/logic/format";
import type { LivePosition } from "@/logic/portfolio";
import { squarify } from "@/logic/treemap";
import { Panel } from "./Panel";

/** Colour intensity saturates at ±5% unrealized P&L. */
function cellColor(pct: number): string {
  const sign = signOf(pct);
  if (sign === "flat") return "#1f2935";
  const strength = Math.round(18 + Math.min(Math.abs(pct) / 5, 1) * 62);
  const hue = sign === "positive" ? "#2bb673" : "#e5484d";
  return `color-mix(in srgb, ${hue} ${strength}%, #141b24)`;
}

interface Props {
  positions: LivePosition[];
  selected: string | null;
  onSelect: (ticker: string) => void;
}

export function Heatmap({ positions, selected, onSelect }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalMv = positions.reduce((s, p) => s + Math.max(p.marketValue, 0), 0);
  const cells = useMemo(
    () => squarify(positions.map((p) => ({ id: p.ticker, value: p.marketValue })), { x: 0, y: 0, w: size.w, h: size.h }),
    [positions, size.w, size.h],
  );
  const byTicker = useMemo(() => new Map(positions.map((p) => [p.ticker, p])), [positions]);

  return (
    <Panel title="Positions map" aside="size = weight, colour = unrealized P&L" bodyClassName="relative p-1">
      <div data-testid="heatmap" ref={boxRef} className="relative h-full w-full">
        {positions.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-faint">
            No positions yet. Buy from the trade ticket or ask the assistant, and each holding appears here sized by its weight.
          </div>
        )}
        {cells.map((c) => {
          const p = byTicker.get(c.id);
          if (!p) return null;
          const pnlSign = signOf(p.unrealizedPnlPercent);
          const weight = totalMv > 0 ? (p.marketValue / totalMv) * 100 : 0;
          const minSide = Math.min(c.w, c.h);
          const big = minSide > 70 && c.w > 90;
          const showText = c.w > 34 && c.h > 22;
          return (
            <button
              key={c.id}
              type="button"
              data-testid={`heatmap-cell-${c.id}`}
              data-pnl={pnlSign}
              onClick={() => onSelect(c.id)}
              title={`${c.id}: ${formatMoney(p.marketValue)}, ${formatPercent(p.unrealizedPnlPercent)} unrealized, ${weight.toFixed(1)}% of holdings`}
              className={`absolute flex flex-col items-start justify-between overflow-hidden p-1.5 text-left transition-[filter] hover:brightness-125 ${
                selected === c.id ? "outline-2 -outline-offset-2 outline-brand" : ""
              }`}
              style={{
                left: c.x + 1,
                top: c.y + 1,
                width: Math.max(c.w - 2, 0),
                height: Math.max(c.h - 2, 0),
                background: cellColor(p.unrealizedPnlPercent),
              }}
            >
              {showText && (
                <>
                  <span
                    className={`leading-none font-extrabold text-white ${big ? "text-[20px]" : "text-[12px]"}`}
                    style={{ fontStretch: "115%" }}
                  >
                    {c.id}
                  </span>
                  <span className={`num leading-tight text-white/85 ${big ? "text-[12.5px]" : "text-[10.5px]"}`}>
                    {formatPercent(p.unrealizedPnlPercent)}
                    {big && <span className="block text-white/60">{weight.toFixed(1)}% of holdings</span>}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
