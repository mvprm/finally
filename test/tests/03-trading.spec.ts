import { expect, test } from "@playwright/test";
import {
  apiQty,
  apiTrade,
  getPortfolio,
  openApp,
  positionQty,
  readMoney,
  tradeViaUi,
  waitForPrice,
} from "./helpers";

test.describe("trading", () => {
  test("buy shares: cash decreases and the position appears", async ({ page, request }) => {
    const ticker = "V";
    await openApp(page);
    await waitForPrice(page, ticker);

    const before = await getPortfolio(request);
    const qtyBefore = await apiQty(request, ticker);

    const res = await tradeViaUi(page, ticker, 2, "buy");
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.trade).toMatchObject({ ticker, side: "buy", quantity: 2 });
    expect(body.trade.price).toBeGreaterThan(0);
    expect(body.portfolio.cash_balance).toBeCloseTo(before.cash_balance - 2 * body.trade.price, 6);

    // UI applies the returned portfolio: cash down, position row with the new quantity.
    await expect(page.getByTestId(`position-row-${ticker}`)).toBeVisible();
    await expect.poll(() => positionQty(page, ticker)).toBeCloseTo(qtyBefore + 2, 4);
    await expect.poll(() => readMoney(page, "cash-balance")).toBeCloseTo(body.portfolio.cash_balance, 2);
    expect(await readMoney(page, "cash-balance")).toBeLessThan(before.cash_balance);
    expect(await apiQty(request, ticker)).toBeCloseTo(qtyBefore + 2, 6);
  });

  test("sell shares: cash increases, the position shrinks and then disappears", async ({ page, request }) => {
    const ticker = "JPM";
    // Setup: hold at least 3 shares (via API), then load the page.
    await apiTrade(request, ticker, 3, "buy");
    await openApp(page);
    await waitForPrice(page, ticker);
    await expect(page.getByTestId(`position-row-${ticker}`)).toBeVisible();

    const before = await getPortfolio(request);
    const qtyBefore = await apiQty(request, ticker);
    expect(qtyBefore).toBeGreaterThanOrEqual(3);

    // Partial sell
    const res = await tradeViaUi(page, ticker, 1, "sell");
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.trade).toMatchObject({ ticker, side: "sell", quantity: 1 });
    expect(body.portfolio.cash_balance).toBeCloseTo(before.cash_balance + body.trade.price, 6);

    await expect.poll(() => positionQty(page, ticker)).toBeCloseTo(qtyBefore - 1, 4);
    await expect.poll(() => readMoney(page, "cash-balance")).toBeCloseTo(body.portfolio.cash_balance, 2);
    expect(await readMoney(page, "cash-balance")).toBeGreaterThan(before.cash_balance);

    // Sell the rest: the row disappears
    const remaining = await apiQty(request, ticker);
    const resAll = await tradeViaUi(page, ticker, remaining, "sell");
    expect(resAll.status(), await resAll.text()).toBe(200);
    await expect(page.getByTestId(`position-row-${ticker}`)).toHaveCount(0);
    expect((await getPortfolio(request)).positions.map((p) => p.ticker)).not.toContain(ticker);
  });

  test("selling more than held shows an error and changes nothing", async ({ page, request }) => {
    const ticker = "TSLA";
    await openApp(page);
    await waitForPrice(page, ticker);
    const before = await getPortfolio(request);

    const res = await tradeViaUi(page, ticker, 1_000_000, "sell");
    expect(res.status()).toBe(400);
    await expect(page.getByTestId("trade-error")).toBeVisible();
    await expect(page.getByTestId("trade-error")).toContainText(/insufficient shares/i);

    const after = await getPortfolio(request);
    expect(after.cash_balance).toBeCloseTo(before.cash_balance, 6);
  });

  test("buying with insufficient cash shows an error", async ({ page }) => {
    const ticker = "NVDA";
    await openApp(page);
    await waitForPrice(page, ticker);

    const res = await tradeViaUi(page, ticker, 1_000_000, "buy");
    expect(res.status()).toBe(400);
    await expect(page.getByTestId("trade-error")).toBeVisible();
    await expect(page.getByTestId("trade-error")).toContainText(/insufficient cash/i);
  });
});
