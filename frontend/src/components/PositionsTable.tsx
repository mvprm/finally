"use client";

import { formatMoney, formatPercent, formatPrice, formatQty, formatSignedMoney, signOf } from "@/logic/format";
import type { LivePosition } from "@/logic/portfolio";
import { Panel } from "./Panel";

const tone = { positive: "text-up", negative: "text-down", flat: "text-dim" } as const;

interface Props {
  positions: LivePosition[];
  selected: string | null;
  onSelect: (ticker: string) => void;
}

export function PositionsTable({ positions, selected, onSelect }: Props) {
  return (
    <Panel title="Positions" aside={positions.length ? `${positions.length} open` : undefined} bodyClassName="overflow-auto">
      <table data-testid="positions-table" className="num w-full min-w-[600px] border-collapse text-[12.5px] whitespace-nowrap">
        <thead className="sticky top-0 bg-panel text-[11px] text-dim">
          <tr className="border-b border-rule">
            <th className="px-3 py-1.5 text-left font-medium">Symbol</th>
            <th className="px-2 py-1.5 text-right font-medium">Qty</th>
            <th className="px-2 py-1.5 text-right font-medium">Avg cost</th>
            <th className="px-2 py-1.5 text-right font-medium">Price</th>
            <th className="px-2 py-1.5 text-right font-medium">Value</th>
            <th className="px-2 py-1.5 text-right font-medium">Unrealized P&L</th>
            <th className="px-3 py-1.5 text-right font-medium">Change</th>
          </tr>
        </thead>
        <tbody>
          {positions.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-5 text-center text-[12px] text-faint">
                You don&apos;t hold anything yet. You have cash to buy with in the trade ticket.
              </td>
            </tr>
          )}
          {positions.map((p) => {
            const t = tone[signOf(p.unrealizedPnl)];
            return (
              <tr
                key={p.ticker}
                data-testid={`position-row-${p.ticker}`}
                onClick={() => onSelect(p.ticker)}
                className={`cursor-pointer border-b border-rule/60 hover:bg-raised ${selected === p.ticker ? "bg-raised" : ""}`}
              >
                <td className="px-3 py-1.5 font-bold" style={{ fontStretch: "108%" }}>
                  {p.ticker}
                </td>
                <td data-testid={`position-qty-${p.ticker}`} className="px-2 py-1.5 text-right">
                  {formatQty(p.quantity)}
                </td>
                <td className="px-2 py-1.5 text-right text-dim">{formatPrice(p.avgCost)}</td>
                <td className="px-2 py-1.5 text-right">{formatPrice(p.currentPrice)}</td>
                <td className="px-2 py-1.5 text-right">{formatMoney(p.marketValue)}</td>
                <td className={`px-2 py-1.5 text-right ${t}`}>{formatSignedMoney(p.unrealizedPnl)}</td>
                <td className={`px-3 py-1.5 text-right ${t}`}>{formatPercent(p.unrealizedPnlPercent)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
