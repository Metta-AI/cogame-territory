// The canonical seeded PRNG for every cogweb game. It lives in @cogweb/protocol —
// the shared, dependency-light, browser-safe foundation every game and client
// already imports — so that no game reaches for its own generator. Its state width
// is a SECURITY property, not just a reproducibility one.
//
// A game's per-game randomness (board / deal / hidden roles) is a pure function of
// its seed. When a game derives HIDDEN per-seat information from the seed (a private
// hand, a secret role), the seed is a secret: anyone who learns it re-derives every
// opponent's hidden state. The old per-game generator (mulberry32) had a 32-bit
// state — any seed collapsed to `seed >>> 0`, so the whole deal lived in a ~4-billion
// space. A player, who legitimately sees their OWN hidden info, could enumerate every
// seed, re-derive the deal, match the candidate against what they see, recover the
// seed, and then read everyone else's hidden state.
//
// `makeRng` seeds `sfc32` (128 bits of state) from the FULL seed string. It hashes
// the seed FOUR INDEPENDENT times (a distinct salt per word) — a single `xmur3(seed)`
// keeps only a 32-bit state, so four successive draws from one instance share that
// 32-bit state and carry just 32 bits of JOINT entropy, leaving the deal enumerable.
// Four independently-salted hashes give sfc32 the full 128 bits, so the deal can't be
// brute-forced. Determinism is preserved (same seed string → same stream, everywhere),
// which is what docs/SEEDING.md requires. Two more things make the seed actually
// secret, and they are the game's responsibility: mint it with real entropy (the
// runner mints a 128-bit CSPRNG seed; coworld pins a high-entropy one or omits it) and
// NEVER send it to a player (redact it from every per-seat/public view, AND from any
// log/event text or welcome/config frame).

export type Rng = () => number;

/** Hash a string into a stream of 32-bit values. Exported so a regression test can
 *  assert that two seeds colliding on a single `xmur3` draw still deal differently
 *  (the salted-per-word seeding in `makeRng` breaks that 32-bit funnel). */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** sfc32: a fast PRNG with 128 bits of internal state — wide enough that a deal
 *  derived from the seed cannot be enumerated even though it is a pure function of
 *  the seed. */
function sfc32(a: number, b: number, c: number, d: number): Rng {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** A uniform [0, 1) generator seeded from the FULL seed string (128-bit state).
 *  The four sfc32 words come from four INDEPENDENT, distinctly-salted hashes — NOT
 *  four draws of one `xmur3(seed)` (which share one 32-bit state, leaving the deal
 *  enumerable over 2^32). */
export function makeRng(seed: string): Rng {
  return sfc32(
    xmur3("a:" + seed)(),
    xmur3("b:" + seed)(),
    xmur3("c:" + seed)(),
    xmur3("d:" + seed)(),
  );
}

/** Next integer in [0, n). */
export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/** Fisher–Yates shuffle returning a NEW array; pure given `rng`. */
export function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
