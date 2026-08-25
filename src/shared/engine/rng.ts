// Seeded mulberry32 PRNG: deterministic, dependency-free randomness for
// reproducible board generation and replayable game logs.
// The seed is coerced to uint32, so fractional/negative seeds alias
// (e.g. `--seed 1.5` == `--seed 1`).

/** Returns a generator producing floats in [0, 1) for the given seed. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Returns an integer in [0, n) drawn from the given generator. */
export const randInt = (rng: () => number, n: number) => Math.floor(rng() * n);
