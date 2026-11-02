import { expect, test } from "@playwright/test";
import { openApp, positionQty, waitForPrice } from "./helpers";

// These tests rely on LLM_MOCK=true (PLAN.md §9 mock rules).
test.describe("AI chat (mock LLM)", () => {
  test("buy 1 AAPL: assistant replies and the trade appears inline", async ({ page }) => {
    await openApp(page);
    await waitForPrice(page, "AAPL");
    const qtyBefore = await positionQty(page, "AAPL");

    // Delay the chat request slightly so the loading indicator is observable.
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 1_000));
      await route.continue();
    });

    await page.getByTestId("chat-input").fill("buy 1 AAPL");
    const chatResponse = page.waitForResponse(
      (r) => r.url().endsWith("/api/chat") && r.request().method() === "POST",
    );
    await page.getByTestId("chat-send").click();
    await expect(page.getByTestId("chat-loading")).toBeVisible();

    const res = await chatResponse;
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/Mock: buy 1 AAPL/i);
    expect(body.actions.trades).toHaveLength(1);
    expect(body.actions.trades[0]).toMatchObject({ ticker: "AAPL", side: "buy", quantity: 1 });
    expect(body.portfolio).not.toBeNull();

    await expect(page.getByTestId("chat-loading")).toBeHidden();
    await expect(
      page.locator('[data-testid="chat-message"][data-role="user"]').filter({ hasText: "buy 1 AAPL" }).last(),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="chat-message"][data-role="assistant"]').filter({ hasText: /Mock: buy 1 AAPL/i }).last(),
    ).toBeVisible();
    await expect(page.getByTestId("chat-action").filter({ hasText: "AAPL" }).last()).toBeVisible();

    // The portfolio state from the chat response is applied without a reload.
    await expect(page.getByTestId("position-row-AAPL")).toBeVisible();
    await expect.poll(() => positionQty(page, "AAPL")).toBeCloseTo(qtyBefore + 1, 4);

    // History survives a page reload.
    await openApp(page);
    await expect(
      page.locator('[data-testid="chat-message"][data-role="assistant"]').filter({ hasText: /Mock: buy 1 AAPL/i }).last(),
    ).toBeVisible();
  });

  test("a failing action is reported inline", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("chat-input").fill("sell 1000000 NFLX");
    const chatResponse = page.waitForResponse(
      (r) => r.url().endsWith("/api/chat") && r.request().method() === "POST",
    );
    await page.getByTestId("chat-send").click();
    const res = await chatResponse;
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.actions.trades).toHaveLength(0);
    expect(body.actions.errors.length).toBeGreaterThan(0);

    await expect(
      page.locator('[data-testid="chat-message"][data-role="assistant"]').filter({ hasText: /Mock: sell 1000000 NFLX/i }).last(),
    ).toBeVisible();
    await expect(page.getByTestId("chat-action").filter({ hasText: "NFLX" }).last()).toBeVisible();
  });

  test("message with no actions gets the default mock reply", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("chat-input").fill("how is my portfolio doing?");
    await page.getByTestId("chat-send").click();
    await expect(
      page.locator('[data-testid="chat-message"][data-role="assistant"]').filter({ hasText: "Mock response: no actions." }).last(),
    ).toBeVisible();
  });
});
