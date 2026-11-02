import { describe, expect, it } from "vitest";
import { squarify, type TreemapCell } from "../treemap";

const area = (c: TreemapCell) => c.w * c.h;

describe("squarify", () => {
  const bounds = { x: 0, y: 0, w: 600, h: 400 };

  it("returns nothing for no items or empty bounds", () => {
    expect(squarify([], bounds)).toEqual([]);
    expect(squarify([{ id: "A", value: 1 }], { x: 0, y: 0, w: 0, h: 100 })).toEqual([]);
  });

  it("fills the bounds with a single item", () => {
    const [c] = squarify([{ id: "A", value: 5 }], bounds);
    expect(c).toMatchObject({ id: "A", x: 0, y: 0, w: 600, h: 400 });
  });

  it("drops zero and negative values", () => {
    const cells = squarify(
      [
        { id: "A", value: 3 },
        { id: "B", value: 0 },
        { id: "C", value: -2 },
      ],
      bounds,
    );
    expect(cells.map((c) => c.id)).toEqual(["A"]);
  });

  it("makes areas proportional to values and covers the whole rectangle", () => {
    const items = [
      { id: "A", value: 6 },
      { id: "B", value: 6 },
      { id: "C", value: 4 },
      { id: "D", value: 3 },
      { id: "E", value: 2 },
      { id: "F", value: 2 },
      { id: "G", value: 1 },
    ];
    const cells = squarify(items, bounds);
    const total = items.reduce((s, i) => s + i.value, 0);
    expect(cells).toHaveLength(items.length);
    const sumArea = cells.reduce((s, c) => s + area(c), 0);
    expect(sumArea).toBeCloseTo(600 * 400, 6);
    for (const c of cells) {
      expect(area(c)).toBeCloseTo((c.value / total) * 600 * 400, 6);
      // Stays inside the bounds.
      expect(c.x).toBeGreaterThanOrEqual(-1e-9);
      expect(c.y).toBeGreaterThanOrEqual(-1e-9);
      expect(c.x + c.w).toBeLessThanOrEqual(600 + 1e-9);
      expect(c.y + c.h).toBeLessThanOrEqual(400 + 1e-9);
    }
  });

  it("produces non-overlapping cells", () => {
    const cells = squarify(
      [5, 4, 3, 2, 1, 1].map((v, i) => ({ id: String(i), value: v })),
      bounds,
    );
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i];
        const b = cells[j];
        const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(overlapW <= 1e-6 || overlapH <= 1e-6).toBe(true);
      }
    }
  });

  it("keeps cells reasonably square (the point of squarifying)", () => {
    const cells = squarify(
      [6, 6, 4, 3, 2, 2, 1].map((v, i) => ({ id: String(i), value: v })),
      bounds,
    );
    for (const c of cells) {
      const ratio = Math.max(c.w / c.h, c.h / c.w);
      expect(ratio).toBeLessThan(4);
    }
  });

  it("orders cells largest first", () => {
    const cells = squarify(
      [
        { id: "small", value: 1 },
        { id: "big", value: 10 },
      ],
      bounds,
    );
    expect(cells[0].id).toBe("big");
  });
});
