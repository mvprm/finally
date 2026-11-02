// Tunable frontend values (PLAN.md §5). Plain constants, not environment variables,
// except API_BASE, which only exists so `next dev` on :3000 can reach the backend on :8000.

/** Points kept per ticker in the price buffer feeding sparklines and the main chart. */
export const PRICE_BUFFER_POINTS = 200;

/** How often the P&L chart picks up the backend's 30-second snapshots. */
export const PNL_HISTORY_POLL_MS = 30_000;

/** Delay before re-opening an EventSource the browser gave up on (readyState CLOSED). */
export const SSE_MANUAL_RETRY_MS = 3_000;

/** Duration of the green/red price flash. Must match the CSS transition in globals.css. */
export const PRICE_FLASH_MS = 500;

/** Empty string = same origin (production). Set NEXT_PUBLIC_API_BASE=http://localhost:8000 for `next dev`. */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
