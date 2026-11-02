import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const DEFAULT_TICKERS = [
  "AAPL", "GOOGL", "MSFT", "AMZN", "TSLA", "NVDA", "META", "JPM", "V", "NFLX",
];

export interface Position {
  ticker: string;
  quantity: number;
  avg_cost: number;
  current_price: number | null;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_percent: number;
}

export interface Portfolio {
  cash_balance: number;
  total_value: number;
  total_unrealized_pnl: number;
  positions: Position[];
}

export interface WatchlistEntry {
  ticker: string;
  price: number | null;
  previous_price: number | null;
  direction: string | null;
}

/** "$10,000.00" -> 10000, "-$5.20" -> -5.2, "1,234.5678" -> 1234.5678 */
export function parseNumber(text: string | null | undefined): number {
  const cleaned = (text ?? "").replace(/−/g, "-").replace(/[^0-9.\-]/g, "");
  const value = Number.parseFloat(cleaned);
  if (Number.isNaN(value)) {
    throw new Error(`Could not parse a number from ${JSON.stringify(text)}`);
  }
  return value;
}

export function formatUsd(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Open the app and wait until the SSE stream is connected and the watchlist is rendered. */
export async function openApp(page: Page): Promise<void> {
  const portfolioLoaded = page.waitForResponse(
    (r) => r.url().endsWith("/api/portfolio") && r.request().method() === "GET",
  );
  await page.goto("/");
  await portfolioLoaded;
  await expect(page.getByTestId("cash-balance")).toHaveText(/\d/);
  await expect(page.getByTestId("watchlist")).toBeVisible();
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-state", "connected", {
    timeout: 15_000,
  });
}

export async function readMoney(page: Page, testId: string): Promise<number> {
  return parseNumber(await page.getByTestId(testId).innerText());
}

/** Quantity held according to the API (0 when there is no position). */
export async function apiQty(request: APIRequestContext, ticker: string): Promise<number> {
  return (await getPortfolio(request)).positions.find((p) => p.ticker === ticker)?.quantity ?? 0;
}

/** Quantity shown in the positions table, or 0 when the row is absent. */
export async function positionQty(page: Page, ticker: string): Promise<number> {
  if ((await page.getByTestId(`position-row-${ticker}`).count()) === 0) return 0;
  return parseNumber(await page.getByTestId(`position-qty-${ticker}`).innerText());
}

/** Wait until the watchlist shows a numeric price for the ticker. */
export async function waitForPrice(page: Page, ticker: string): Promise<void> {
  await expect(page.getByTestId(`price-${ticker}`)).toHaveText(/\d/, { timeout: 15_000 });
}

export async function getPortfolio(request: APIRequestContext): Promise<Portfolio> {
  const res = await request.get("/api/portfolio");
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Portfolio;
}

export async function getWatchlist(request: APIRequestContext): Promise<WatchlistEntry[]> {
  const res = await request.get("/api/watchlist");
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as WatchlistEntry[];
}

/** Execute a trade through the REST API (test setup), retrying briefly until a price exists. */
export async function apiTrade(
  request: APIRequestContext,
  ticker: string,
  quantity: number,
  side: "buy" | "sell",
): Promise<void> {
  let lastBody = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await request.post("/api/portfolio/trade", { data: { ticker, quantity, side } });
    if (res.status() === 200) return;
    lastBody = await res.text();
    if (!/no price/i.test(lastBody)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`API ${side} ${quantity} ${ticker} failed: ${lastBody}`);
}

/** Click buy/sell in the trade bar and return the trade API response. */
export async function tradeViaUi(
  page: Page,
  ticker: string,
  quantity: number | string,
  side: "buy" | "sell",
) {
  await page.getByTestId("trade-ticker").fill(ticker);
  await page.getByTestId("trade-quantity").fill(String(quantity));
  const responsePromise = page.waitForResponse(
    (r) => r.url().endsWith("/api/portfolio/trade") && r.request().method() === "POST",
  );
  await page.getByTestId(side === "buy" ? "buy-button" : "sell-button").click();
  return responsePromise;
}

