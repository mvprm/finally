// Same rule as the backend (PLAN.md §6): uppercase, whitespace stripped, ^[A-Z.]{1,10}$.
const TICKER_RE = /^[A-Z.]{1,10}$/;

export function normalizeTicker(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export function isValidTicker(ticker: string): boolean {
  return TICKER_RE.test(ticker);
}

/** Parse a quantity field. Returns null unless it is a finite number > 0. */
export function parseQuantity(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}
