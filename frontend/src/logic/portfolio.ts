// Live valuation computed on the frontend on every SSE event (PLAN.md §10).
// Rounding matches the backend: money and P&L percentages to 2 decimals.

import type { Portfolio } from "./types";

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface LivePosition {
  ticker: string;
  quantity: number;
  avgCost: number;
  /** Latest known price, or null if none has arrived yet. */
  currentPrice: number | null;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export interface LivePortfolio {
  cash: number;
  totalValue: number;
  totalUnrealizedPnl: number;
  positions: LivePosition[];
}

/**
 * Value the portfolio with the latest streamed prices.
 * Price precedence: live SSE price, then the price the backend reported, then avg cost
 * (a position with no price is valued at its average cost, as on the backend).
 */
export function computeLivePortfolio(
  portfolio: Portfolio,
  livePrices: Record<string, number | undefined>,
): LivePortfolio {
  let total = portfolio.cash_balance;
  let totalPnl = 0;
  const positions = portfolio.positions.map((p) => {
    const live = livePrices[p.ticker];
    const price = live ?? p.current_price ?? null;
    const mark = price ?? p.avg_cost;
    const marketValue = p.quantity * mark;
    const pnl = p.quantity * (mark - p.avg_cost);
    const pnlPct = p.avg_cost ? ((mark - p.avg_cost) / p.avg_cost) * 100 : 0;
    total += marketValue;
    totalPnl += pnl;
    return {
      ticker: p.ticker,
      quantity: p.quantity,
      avgCost: p.avg_cost,
      currentPrice: price,
      marketValue: round2(marketValue),
      unrealizedPnl: round2(pnl),
      unrealizedPnlPercent: round2(pnlPct),
    };
  });
  return {
    cash: round2(portfolio.cash_balance),
    totalValue: round2(total),
    totalUnrealizedPnl: round2(totalPnl),
    positions,
  };
}

/**
 * Session change % against the first price received after page load.
 * Returns null until both prices are known.
 */
export function sessionChangePercent(
  firstPrice: number | null | undefined,
  latestPrice: number | null | undefined,
): number | null {
  if (firstPrice == null || latestPrice == null || firstPrice === 0) return null;
  return round2(((latestPrice - firstPrice) / firstPrice) * 100);
}
