import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against a live FinAlly container started with LLM_MOCK=true.
 *
 * - In Docker (test/docker-compose.test.yml) BASE_URL is http://finally:8000.
 * - Locally, start the app yourself and run `npx playwright test` (defaults to localhost:8000).
 *
 * The app is single-user and stateful, so tests run serially in file order
 * (01-..., 02-...). Only the fresh-start test expects a fresh database.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  outputDir: "test-results",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8000",
    viewport: { width: 1600, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } } }],
});
