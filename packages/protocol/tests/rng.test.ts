// The shared seeded PRNG is what keeps a seed-derived deal unguessable for every
// cogweb game (see src/rng.ts). These tests pin the two properties that matter:
// it depends on the FULL seed (so the deal can't be enumerated over the old 32-bit
// space) and it is deterministic (so seeded reproducibility still holds).
import { describe, it, expect } from "vitest";

import { makeRng, randInt, shuffled, xmur3 } from "../src/rng.js";

const stream = (seed: string, n = 12): number[] => {
  const rng = makeRng(seed);
  return Array.from({ length: n }, () => rng());
};

describe("makeRng", () => {
  it("is a deterministic function of the seed string", () => {
    expect(stream("deadbeefcafe1234")).toEqual(stream("deadbeefcafe1234"));
  });

  it("depends on seed bits above 2^32 — no 32-bit (mulberry32) collapse", () => {
    // The old per-game generator collapsed any seed to `seed >>> 0`, so "1" and
    // 2^32 + 1 produced the IDENTICAL stream. Crossing the 32-bit boundary must
    // now change the stream — that's what makes the deal non-enumerable.
    expect(stream("1")).not.toEqual(stream(String(2 ** 32 + 1)));
    expect(stream("1")).not.toEqual(stream(String(2 ** 40 + 1)));
  });

  it("does not funnel the seed through a single 32-bit xmur3 state", () => {
    // Two seeds whose FIRST xmur3 draw collides. The naive idiom
    // `sfc32(n(),n(),n(),n())` (one n = xmur3(seed)) would seed all four words from
    // this one shared 32-bit state and deal them IDENTICALLY — so the deal would
    // still live in a 2^32 space. makeRng salts each word independently, so the
    // colliding pair must deal differently.
    const a = "643399";
    const b = "1512042";
    expect(xmur3(a)()).toBe(xmur3(b)()); // precondition: first-draw collision
    expect(stream(a)).not.toEqual(stream(b));
  });

  it("randInt stays in range and shuffled is a deterministic permutation", () => {
    const rng = makeRng("x");
    for (let i = 0; i < 100; i++) {
      const v = randInt(rng, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = shuffled(makeRng("seed-a"), items);
    expect([...a].sort((x, y) => x - y)).toEqual(items);
    expect(shuffled(makeRng("seed-a"), items)).toEqual(a);
    expect(shuffled(makeRng("seed-b"), items)).not.toEqual(a);
  });
});
