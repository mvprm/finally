import { describe, expect, it } from "vitest";
import { computeLivePortfolio, round2, sessionChangePercent } from "../portfolio";
import type { Portfolio } from "../types";

const base: Portfolio = {
  cash_balance: 8500,
  total_value: 10120.5,
  total_unrealized_pnl: 120.5,
  positions: [
    {
      ticker: "AAPL",
      quantity: 10,
      avg_cost: 150,
      current_price: 162.05,
      market_value: 1620.5,
      unrealized_pnl: 120.5,
      unrealized_pnl_percent: 8.03,
    },
  ],
};

describe("computeLivePortfolio", () => {
  it("reproduces the backend's numbers when prices haven't moved", () => {
    const live = computeLivePortfolio(base, {});
    expect(live.totalValue).toBe(10120.5);
    expect(live.totalUnrealizedPnl).toBe(120.5);
    expect(live.positions[0].unrealizedPnlPercent).toBe(8.03);
    expect(live.positions[0].currentPrice).toBe(162.05);
  });

  it("revalues with the latest streamed price", () => {
    const live = computeLivePortfolio(base, { AAPL: 140 });
    expect(live.positions[0].marketValue).toBe(1400);
    expect(live.positions[0].unrealizedPnl).toBe(-100);
    expect(live.positions[0].unrealizedPnlPercent).toBe(-6.67);
    expect(live.totalValue).toBe(9900);
    expect(live.totalUnrealizedPnl).toBe(-100);
  });

  it("values a position with no price at its average cost", () => {
    const p: Portfolio = {
      ...base,
      positions: [{ ...base.positions[0], current_price: null }],
    };
    const live = computeLivePortfolio(p, {});
    expect(live.positions[0].currentPrice).toBeNull();
    expect(live.positions[0].marketValue).toBe(1500);
    expect(live.positions[0].unrealizedPnl).toBe(0);
    expect(live.totalValue).toBe(10000);
  });

  it("uses prices of held tickers even if they are not on the watchlist", () => {
    const p: Portfolio = {
      cash_balance: 0,
      total_value: 0,
      total_unrealized_pnl: 0,
      positions: [
        { ...base.positions[0] },
        { ticker: "PYPL", quantity: 2.5, avg_cost: 60, current_price: 60, market_value: 150, unrealized_pnl: 0, unrealized_pnl_percent: 0 },
      ],
    };
    const live = computeLivePortfolio(p, { AAPL: 150, PYPL: 64 });
    expect(live.totalValue).toBe(1500 + 160);
    expect(live.positions[1].unrealizedPnl).toBe(10);
  });

  it("handles an empty portfolio", () => {
    const live = computeLivePortfolio({ cash_balance: 10000, total_value: 10000, total_unrealized_pnl: 0, positions: [] }, {});
    expect(live.totalValue).toBe(10000);
    expect(live.positions).toEqual([]);
  });
});

describe("sessionChangePercent", () => {
  it("is relative to the first price seen", () => {
    expect(sessionChangePercent(200, 210)).toBe(5);
    expect(sessionChangePercent(200, 190)).toBe(-5);
    expect(sessionChangePercent(190.41, 190.52)).toBe(0.06);
  });

  it("is null until prices exist", () => {
    expect(sessionChangePercent(undefined, 10)).toBeNull();
    expect(sessionChangePercent(10, null)).toBeNull();
    expect(sessionChangePercent(0, 10)).toBeNull();
  });
});

describe("round2", () => {
  it("rounds half up like the backend for typical values", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-6.666)).toBe(-6.67);
  });
});
