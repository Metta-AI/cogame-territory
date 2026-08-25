import { describe, it, expect } from "vitest";
import { makeRng, randInt } from "./rng";

describe("makeRng", () => {
  it("is deterministic for a given seed", () => {
    const a = makeRng(42), b = makeRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it("returns floats in [0,1)", () => {
    const r = makeRng(1);
    for (let i = 0; i < 100; i++) { const x = r(); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
  });
});

describe("randInt", () => {
  it("returns integers in [0,n)", () => {
    const r = makeRng(7);
    for (let i = 0; i < 1000; i++) {
      const x = randInt(r, 4);
      expect(Number.isInteger(x)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(4);
    }
  });
});
