import { expect, test } from "@playwright/test";
import { apiTrade, getPortfolio, openApp, waitForPrice } from "./helpers";

interface CellInfo {
  ticker: string;
  pnl: string | null;
  rgba: number[] | null;
}

test.describe("portfolio visualisation", () => {
  test.beforeAll(async ({ request }) => {
    // Make sure there are positions to draw.
    await apiTrade(request, "AMZN", 1, "buy");
    await apiTrade(request, "GOOGL", 1, "buy");
  });

  test("heatmap has a cell per position, coloured by P&L", async ({ page, request }) => {
    await openApp(page);
    await waitForPrice(page, "AMZN");

    const tickers = (await getPortfolio(request)).positions.map((p) => p.ticker);
    expect(tickers.length).toBeGreaterThan(0);
    for (const ticker of tickers) {
      await expect(page.getByTestId(`heatmap-cell-${ticker}`)).toBeVisible();
      await expect(page.getByTestId(`heatmap-cell-${ticker}`)).toHaveAttribute(
        "data-pnl",
        /^(positive|negative|flat)$/,
      );
    }

    // Read each cell's data-pnl and its painted colour in one synchronous snapshot, so a
    // live price tick can't change one without the other.
    const readCells = () =>
      page.getByTestId("heatmap").evaluate((heatmap): CellInfo[] => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext("2d")!;
        const toRgba = (color: string): number[] | null => {
          if (!color || color === "none" || color === "transparent") return null;
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = "rgba(0, 0, 0, 0)";
          ctx.fillStyle = color; // any CSS colour: rgb(), hex, oklch(), ...
          ctx.fillRect(0, 0, 1, 1);
          const d = Array.from(ctx.getImageData(0, 0, 1, 1).data);
          return d[3] === 0 ? null : d;
        };
        // The colour may sit on the cell itself or on a descendant (div background or SVG fill).
        const colorOf = (el: Element): number[] | null => {
          for (const node of [el, ...Array.from(el.querySelectorAll("*"))]) {
            const cs = getComputedStyle(node);
            const rgba = toRgba(cs.backgroundColor) ?? (node instanceof SVGElement ? toRgba(cs.fill) : null);
            if (rgba) return rgba;
          }
          return null;
        };
        return Array.from(heatmap.querySelectorAll('[data-testid^="heatmap-cell-"]')).map((el) => ({
          ticker: el.getAttribute("data-testid")!.replace("heatmap-cell-", ""),
          pnl: el.getAttribute("data-pnl"),
          rgba: colorOf(el),
        }));
      });

    // Prices move every ~500 ms, so a non-flat cell appears quickly.
    await expect
      .poll(async () => (await readCells()).some((c) => c.pnl !== "flat"), { timeout: 20_000 })
      .toBe(true);

    const cells = await readCells();
    for (const cell of cells) {
      expect(cell.rgba, `heatmap-cell-${cell.ticker} has no visible fill colour`).not.toBeNull();
      const [r, g] = cell.rgba!;
      if (cell.pnl === "positive") {
        expect(g, `${cell.ticker} is positive but not green: rgba(${cell.rgba})`).toBeGreaterThan(r);
      } else if (cell.pnl === "negative") {
        expect(r, `${cell.ticker} is negative but not red: rgba(${cell.rgba})`).toBeGreaterThan(g);
      }
    }
  });

  test("P&L chart renders with snapshot data", async ({ page, request }) => {
    const res = await request.get("/api/portfolio/history");
    expect(res.status()).toBe(200);
    const history = (await res.json()) as { total_value: number; recorded_at: string }[];
    // One snapshot at startup plus one per trade.
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]).toEqual(
      expect.objectContaining({ total_value: expect.any(Number), recorded_at: expect.any(String) }),
    );

    await openApp(page);
    const chart = page.getByTestId("pnl-chart");
    await expect(chart).toBeVisible();
    await expect(chart.locator("canvas").first()).toBeVisible();
  });

  test("positions table lists every position", async ({ page, request }) => {
    await openApp(page);
    const positions = (await getPortfolio(request)).positions;
    for (const p of positions) {
      await expect(page.getByTestId(`position-row-${p.ticker}`)).toBeVisible();
    }
  });
});
