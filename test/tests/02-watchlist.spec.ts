import { expect, test } from "@playwright/test";
import { getWatchlist, openApp, waitForPrice } from "./helpers";

const TICKER = "PYPL"; // not in the default watchlist

test.describe("watchlist", () => {
  test.beforeEach(async ({ request }) => {
    // Start from a known state even if a previous run left the ticker behind.
    const watchlist = await getWatchlist(request);
    if (watchlist.some((w) => w.ticker === TICKER)) {
      const res = await request.delete(`/api/watchlist/${TICKER}`);
      expect(res.status()).toBe(200);
    }
  });

  test("add and remove a ticker", async ({ page, request }) => {
    await openApp(page);
    await expect(page.getByTestId(`watchlist-row-${TICKER}`)).toHaveCount(0);

    // Add
    await page.getByTestId("add-ticker-input").fill(TICKER);
    const addResponse = page.waitForResponse(
      (r) => r.url().endsWith("/api/watchlist") && r.request().method() === "POST",
    );
    await page.getByTestId("add-ticker-button").click();
    expect((await addResponse).status()).toBe(200);

    const row = page.getByTestId(`watchlist-row-${TICKER}`);
    await expect(row).toBeVisible();
    await waitForPrice(page, TICKER); // simulator starts streaming new tickers immediately
    expect((await getWatchlist(request)).map((w) => w.ticker)).toContain(TICKER);

    // Survives a reload (persisted server-side)
    await openApp(page);
    await expect(row).toBeVisible();

    // Remove (the button may only be shown on hover)
    await row.hover();
    const removeResponse = page.waitForResponse(
      (r) => r.url().endsWith(`/api/watchlist/${TICKER}`) && r.request().method() === "DELETE",
    );
    await page.getByTestId(`remove-ticker-${TICKER}`).click();
    expect((await removeResponse).status()).toBe(200);

    await expect(row).toHaveCount(0);
    expect((await getWatchlist(request)).map((w) => w.ticker)).not.toContain(TICKER);
  });

  test("adding an invalid symbol does not add a row", async ({ page, request }) => {
    await openApp(page);
    const before = (await getWatchlist(request)).length;
    await page.getByTestId("add-ticker-input").fill("NOT_A_TICKER1");
    await page.getByTestId("add-ticker-button").click();
    // Give the request (if any) time to complete, then check nothing changed.
    await page.waitForTimeout(1_000);
    expect((await getWatchlist(request)).length).toBe(before);
    await expect(page.getByTestId("watchlist-row-NOT_A_TICKER1")).toHaveCount(0);
  });
});
