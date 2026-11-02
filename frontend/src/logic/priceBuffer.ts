import type { PriceEvent } from "./types";

export interface PricePoint {
  time: number; // Unix seconds
  value: number;
}

export type PriceBuffers = Record<string, PricePoint[]>;

/**
 * Append a point, keeping at most `max` points. A point that is not newer than
 * the last one is ignored (the stream resends unchanged tickers with their old timestamp).
 * Returns the same array when nothing changed, so callers can skip re-renders.
 */
export function appendPoint(buffer: PricePoint[] | undefined, point: PricePoint, max: number): PricePoint[] {
  const current = buffer ?? [];
  const last = current[current.length - 1];
  if (last && point.time <= last.time) return current;
  const next = current.length >= max ? current.slice(current.length - max + 1) : current.slice();
  next.push(point);
  return next;
}

/** Fold one SSE event into the per-ticker buffers. */
export function applyEventToBuffers(buffers: PriceBuffers, event: PriceEvent, max: number): PriceBuffers {
  let changed = false;
  const out: PriceBuffers = { ...buffers };
  for (const [ticker, update] of Object.entries(event)) {
    const before = buffers[ticker];
    const after = appendPoint(before, { time: update.timestamp, value: update.price }, max);
    if (after !== before) {
      out[ticker] = after;
      changed = true;
    }
  }
  return changed ? out : buffers;
}
