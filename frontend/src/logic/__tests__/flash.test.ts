import { describe, expect, it } from "vitest";
import { flashFor } from "../flash";

describe("flashFor", () => {
  it("flashes up on an uptick", () => expect(flashFor(100, 100.01)).toBe("up"));
  it("flashes down on a downtick", () => expect(flashFor(100, 99.99)).toBe("down"));
  it("doesn't flash when unchanged", () => expect(flashFor(100, 100)).toBeNull());
  it("doesn't flash on the first price", () => expect(flashFor(undefined, 100)).toBeNull());
  it("doesn't flash without a new price", () => expect(flashFor(100, null)).toBeNull());
});
