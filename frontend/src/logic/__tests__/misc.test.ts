import { describe, expect, it } from "vitest";
import { errorDetail } from "../api";
import { describeActions } from "../chatActions";
import { formatMoney, formatPercent, formatSignedMoney, signOf } from "../format";
import { appendPoint, applyEventToBuffers } from "../priceBuffer";
import { isValidTicker, normalizeTicker, parseQuantity } from "../ticker";
import type { PriceEvent } from "../types";

describe("price buffer", () => {
  it("caps the buffer at max points, dropping the oldest", () => {
    let buf = appendPoint(undefined, { time: 1, value: 1 }, 3);
    for (let t = 2; t <= 5; t++) buf = appendPoint(buf, { time: t, value: t }, 3);
    expect(buf.map((p) => p.time)).toEqual([3, 4, 5]);
  });

  it("ignores points that aren't newer", () => {
    const buf = appendPoint(undefined, { time: 10, value: 1 }, 5);
    expect(appendPoint(buf, { time: 10, value: 2 }, 5)).toBe(buf);
    expect(appendPoint(buf, { time: 9, value: 2 }, 5)).toBe(buf);
  });

  it("folds an event into buffers and keeps identity when nothing changed", () => {
    const ev: PriceEvent = {
      AAPL: { ticker: "AAPL", price: 190, previous_price: 189, timestamp: 100, change: 1, change_percent: 0.5, direction: "up" },
    };
    const b1 = applyEventToBuffers({}, ev, 200);
    expect(b1.AAPL).toEqual([{ time: 100, value: 190 }]);
    expect(applyEventToBuffers(b1, ev, 200)).toBe(b1);
  });
});

describe("formatting", () => {
  it("formats dollars", () => {
    expect(formatMoney(10000)).toBe("$10,000.00");
    expect(formatMoney(-0.001)).toBe("$0.00");
    expect(formatMoney(null)).toBe("—");
  });
  it("formats signed values", () => {
    expect(formatSignedMoney(120.5)).toBe("+$120.50");
    expect(formatSignedMoney(-4.1)).toBe("-$4.10");
    expect(formatPercent(8.031)).toBe("+8.03%");
    expect(formatPercent(-0.001)).toBe("0.00%");
  });
  it("classifies sign", () => {
    expect(signOf(1)).toBe("positive");
    expect(signOf(-1)).toBe("negative");
    expect(signOf(0.001)).toBe("flat");
  });
});

describe("ticker input", () => {
  it("normalises and validates like the backend", () => {
    expect(normalizeTicker(" brk. b ")).toBe("BRK.B");
    expect(isValidTicker("BRK.B")).toBe(true);
    expect(isValidTicker("AAPL1")).toBe(false);
    expect(isValidTicker("")).toBe(false);
    expect(isValidTicker("ABCDEFGHIJK")).toBe(false);
  });
  it("parses quantities", () => {
    expect(parseQuantity("10")).toBe(10);
    expect(parseQuantity("0.5")).toBe(0.5);
    expect(parseQuantity("0")).toBeNull();
    expect(parseQuantity("-1")).toBeNull();
    expect(parseQuantity("abc")).toBeNull();
    expect(parseQuantity("")).toBeNull();
  });
});

describe("api error detail", () => {
  it("reads FastAPI 400 and 422 bodies", () => {
    expect(errorDetail({ detail: "Insufficient cash" }, 400)).toBe("Insufficient cash");
    expect(errorDetail({ detail: [{ loc: ["body", "quantity"], msg: "Field required" }] }, 422)).toBe(
      "quantity: Field required",
    );
    expect(errorDetail(null, 500)).toBe("Request failed (500)");
  });
});

describe("chat action lines", () => {
  it("describes trades, watchlist changes and errors", () => {
    const lines = describeActions({
      trades: [{ ticker: "AAPL", side: "buy", quantity: 10, price: 190.52 }],
      watchlist_changes: [{ ticker: "PYPL", action: "add" }],
      errors: ["Insufficient cash to buy 1000 TSLA"],
    });
    expect(lines.map((l) => l.text)).toEqual([
      "Bought 10 AAPL at $190.52",
      "Added PYPL to the watchlist",
      "Insufficient cash to buy 1000 TSLA",
    ]);
    expect(describeActions(null)).toEqual([]);
  });
});
