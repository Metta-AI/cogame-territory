// Hexagonal board in axial coordinates {q, r}: the spatial substrate every
// later system (board generation, the fling-range predicates, home rings) builds
// on. Kept verbatim from coworld-cogherence.
// Tiles are keyed by the `${q},${r}` string. A radius-7 board has 169 tiles.

/** A board position in axial coordinates. */
export interface Hex {
  q: number;
  r: number;
}

/** Stable string key for a hex, used to index tile maps. */
export const key = (h: Hex) => `${h.q},${h.r}`;

/** The six axial direction vectors, ordered clockwise from +q. */
const DIRS: Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

/** The six hexes adjacent to `h` (off-board neighbors are not filtered). */
export const neighbors = (h: Hex): Hex[] =>
  DIRS.map((d) => ({ q: h.q + d.q, r: h.r + d.r }));

/** Every hex within `radius` of the origin (center included). */
export function hexesInRadius(radius: number): Hex[] {
  const out: Hex[] = [];
  for (let q = -radius; q <= radius; q++)
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++)
      out.push({ q, r });
  return out;
}

/** Hex (cube) distance between two axial hexes. */
export const distance = (a: Hex, b: Hex): number =>
  (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
