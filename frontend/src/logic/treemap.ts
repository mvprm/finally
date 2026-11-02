// Squarified treemap (Bruls, Huizing & van Wijk, 2000). Hand-rolled because
// Lightweight Charts has no treemap (PLAN.md §10).

export interface TreemapItem {
  id: string;
  value: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TreemapCell extends Rect {
  id: string;
  value: number;
}

/** Worst (largest) aspect ratio in a row of areas laid along a side of length `side`. */
function worstRatio(areas: number[], side: number): number {
  if (areas.length === 0) return Infinity;
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const a of areas) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/**
 * Lay out items inside `bounds` so each cell's area is proportional to its value
 * and cells stay as close to square as possible. Items with value <= 0 are dropped.
 * Cells are returned largest first.
 */
export function squarify(items: TreemapItem[], bounds: Rect): TreemapCell[] {
  const sorted = items.filter((i) => i.value > 0 && Number.isFinite(i.value)).sort((a, b) => b.value - a.value);
  if (sorted.length === 0 || bounds.w <= 0 || bounds.h <= 0) return [];

  const total = sorted.reduce((s, i) => s + i.value, 0);
  const scale = (bounds.w * bounds.h) / total;
  const areas = sorted.map((i) => i.value * scale);

  const cells: TreemapCell[] = [];
  let { x, y, w, h } = bounds;
  let row: number[] = [];

  const layoutRow = (indices: number[]) => {
    const rowAreas = indices.map((i) => areas[i]);
    const sum = rowAreas.reduce((s, a) => s + a, 0);
    if (w >= h) {
      // Column on the left, stacked along the (shorter) height.
      const colW = h > 0 ? sum / h : 0;
      let yy = y;
      indices.forEach((idx, k) => {
        const cellH = colW > 0 ? rowAreas[k] / colW : 0;
        cells.push({ id: sorted[idx].id, value: sorted[idx].value, x, y: yy, w: colW, h: cellH });
        yy += cellH;
      });
      x += colW;
      w -= colW;
    } else {
      // Row along the top, spread along the (shorter) width.
      const rowH = w > 0 ? sum / w : 0;
      let xx = x;
      indices.forEach((idx, k) => {
        const cellW = rowH > 0 ? rowAreas[k] / rowH : 0;
        cells.push({ id: sorted[idx].id, value: sorted[idx].value, x: xx, y, w: cellW, h: rowH });
        xx += cellW;
      });
      y += rowH;
      h -= rowH;
    }
  };

  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    const current = row.map((r) => areas[r]);
    if (row.length === 0 || worstRatio([...current, areas[i]], side) <= worstRatio(current, side)) {
      row.push(i);
      i++;
    } else {
      layoutRow(row);
      row = [];
    }
  }
  if (row.length) layoutRow(row);
  return cells;
}
