const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const plain2 = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const qtyFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

export const DASH = "—";

/** "$10,000.00"; "—" for missing values. */
export function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  // Avoid "-$0.00" after rounding.
  const v = Math.abs(value) < 0.005 ? 0 : value;
  return usd.format(v);
}

/** Price without the currency sign, for dense tables: "190.52". */
export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return plain2.format(value);
}

/** Signed money: "+$120.50" / "-$4.10". */
export function formatSignedMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const v = Math.abs(value) < 0.005 ? 0 : value;
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return sign + usd.format(Math.abs(v));
}

/** Signed percent: "+8.03%". */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const v = Math.abs(value) < 0.005 ? 0 : value;
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return `${sign}${plain2.format(Math.abs(v))}%`;
}

/** Share quantity; fractional shares keep up to 4 decimals. */
export function formatQty(value: number): string {
  return qtyFmt.format(value);
}

/** Sign of a value for colouring: values that round to zero are flat. */
export function signOf(value: number | null | undefined): "positive" | "negative" | "flat" {
  if (value == null || !Number.isFinite(value) || Math.abs(value) < 0.005) return "flat";
  return value > 0 ? "positive" : "negative";
}
