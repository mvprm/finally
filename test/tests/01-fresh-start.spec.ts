import { expect, test } from "@playwright/test";
import { DEFAULT_TICKERS, formatUsd, getPortfolio, openApp, waitForPrice } from "./helpers";

test.describe("fresh start", () => {
  test("health endpoint responds", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("shows the default watchlist, $10,000 cash and the main panels", async ({ page, request }) => {
    await openApp(page);

    for (const ticker of DEFAULT_TICKERS) {
      await expect(page.getByTestId(`watchlist-row-${ticker}`)).toBeVisible();
    }

    // On a fresh database the cash is exactly $10,000.00. If the suite is re-run against a
    // database that already has trades, check the UI matches the API instead.
    const portfolio = await getPortfolio(request);
    const fresh = portfolio.positions.length === 0 && portfolio.cash_balance === 10_000;
    if (fresh) {
      await expect(page.getByTestId("cash-balance")).toContainText("$10,000.00");
      await expect(page.getByTestId("total-value")).toContainText("$10,000.00");
    } else {
      test.info().annotations.push({ type: "note", description: "database not fresh; cash checked against API" });
      await expect(page.getByTestId("cash-balance")).toContainText(formatUsd(portfolio.cash_balance));
    }

    await expect(page.getByTestId("main-chart")).toBeVisible();
    await expect(page.getByTestId("positions-table")).toBeVisible();
    await expect(page.getByTestId("heatmap")).toBeVisible();
    await expect(page.getByTestId("pnl-chart")).toBeVisible();
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect(page.getByTestId("trade-ticker")).toBeVisible();
  });

  test("prices stream and update live", async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId("connection-status")).toHaveAttribute("data-state", "connected");

    for (const ticker of DEFAULT_TICKERS) {
      await waitForPrice(page, ticker);
    }

    // The simulator ticks every ~500 ms: at least one of the prices must change soon.
    const snapshot = async () =>
      Promise.all(DEFAULT_TICKERS.map((t) => page.getByTestId(`price-${t}`).innerText()));
    const initial = await snapshot();
    await expect
      .poll(async () => (await snapshot()).some((text, i) => text !== initial[i]), {
        timeout: 10_000,
        message: "expected at least one watchlist price to change",
      })
      .toBe(true);
  });

  test("clicking a watchlist ticker shows it in the main chart", async ({ page }) => {
    await openApp(page);
    await waitForPrice(page, "MSFT");
    await page.getByTestId("watchlist-row-MSFT").click();
    const chart = page.getByTestId("main-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toContainText("MSFT");
    await expect(chart.locator("canvas").first()).toBeVisible();
  });
});
