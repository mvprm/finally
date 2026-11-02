export type Flash = "up" | "down" | null;

/**
 * Which flash a price change triggers. No flash for the first price
 * (nothing to compare against) or an unchanged price.
 */
export function flashFor(previous: number | null | undefined, next: number | null | undefined): Flash {
  if (previous == null || next == null) return null;
  if (next > previous) return "up";
  if (next < previous) return "down";
  return null;
}
