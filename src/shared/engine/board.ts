// Initial GameState construction: a seeded radius-7 hex lattice of resource
// walls, one immutable hearth per seat on ring 5 (owned dry at turn 1), and the
// three variant overlays. Deterministic for a given seed, so `(seed, variant)`
// reproduces a board byte for byte — which is what lets the SAME module be
// compiled into the viewer bundle by vite and re-derive every frame in the
// browser.

import { makeRng } from "./rng";
import { distance, hexesInRadius, key, neighbors } from "./hex";
import type { CogState, GameState, HexKey, Tile, Variant } from "./types";
import {
  ALIASES,
  BOARD_RADIUS,
  effYield,
  HEARTHS,
  MAX_TURNS,
  SEATS,
  STARTING_PAINT,
  YIELD_THRESHOLDS,
} from "./constants";

const ORIGIN = { q: 0, r: 0 };

/** Seeded yield draw: `u < 0.45 → 0`, `< 0.75 → 1`, `< 0.92 → 2`, else 3. A
 *  yield-0 wall is still claimable (it is territory and a projection origin) and
 *  pays nothing. */
function drawYield(u: number): number {
  if (u < YIELD_THRESHOLDS[0]!) return 0;
  if (u < YIELD_THRESHOLDS[1]!) return 1;
  if (u < YIELD_THRESHOLDS[2]!) return 2;
  return 3;
}

/** The 7 coordinates whose loss threatens seat `seat`'s life: its hearth plus
 *  the hearth's on-board neighbours. The COORDINATES are permanent even after
 *  the tiles are razed. */
export function homeRing(seat: number): HexKey[] {
  const hearth = HEARTHS[seat]!;
  const out = [key(hearth)];
  for (const n of neighbors(hearth)) {
    if (distance(n, ORIGIN) <= BOARD_RADIUS) out.push(key(n));
  }
  return out;
}

/** Hex distance from `h` to the NEAREST hearth of any seat. */
const distToAnyHearth = (h: { q: number; r: number }): number =>
  HEARTHS.reduce((best, hh) => Math.min(best, distance(h, hh)), Infinity);

/** Apply a variant's board overlay in place. `open` is a no-op. */
function applyVariant(tiles: Record<HexKey, Tile>, variant: Variant): void {
  if (variant === "open") return;

  if (variant === "inside_out") {
    // The wealth is all shared and central, so contact is immediate.
    for (const t of Object.values(tiles)) {
      const d = distance(t.hex, ORIGIN);
      if (d <= 2) t.yield = 3;
      else if (d >= 6) t.yield = 0;
    }
    return;
  }

  // rooms: every hearth's 6 neighbours are forced to yield 3, and every tile at
  // hex distance EXACTLY 2 from a hearth is seeded rubble (the room wall) except
  // one gap — the tile in that ring nearest the board origin (ties → lowest
  // tileKey). Precedence when rings collide (hearths can be 3 apart): being
  // within distance <= 1 of ANY hearth wins over being a room wall.
  for (const t of Object.values(tiles)) {
    if (distToAnyHearth(t.hex) === 1) t.yield = 3;
  }
  // The gap of EVERY room is computed first, then the wall set excludes all of
  // them: a hearth 3 away can otherwise reach into this room's ring and brick up
  // its only door (the invariant board.test.ts pins is "exactly one gap per room,
  // and no gap tile is rubble").
  const rings = new Map<HexKey, Tile[]>();
  const gaps = new Set<HexKey>();
  for (const hearth of HEARTHS) {
    const ring = Object.values(tiles)
      .filter((t) => distance(t.hex, hearth) === 2)
      .sort((a, b) => distance(a.hex, ORIGIN) - distance(b.hex, ORIGIN) || (key(a.hex) < key(b.hex) ? -1 : 1));
    rings.set(key(hearth), ring);
    const gap = ring[0];
    if (gap) gaps.add(key(gap.hex));
  }
  const walls = new Set<HexKey>();
  for (const ring of rings.values()) {
    for (const t of ring) {
      const k = key(t.hex);
      if (gaps.has(k)) continue;
      walls.add(k);
    }
  }
  for (const k of walls) {
    const t = tiles[k]!;
    if (distToAnyHearth(t.hex) <= 1) continue; // hearth adjacency wins
    t.state = "rubble";
    t.owner = null;
    t.wet = false;
  }
}

/** The income pool at full claim: Σ effYield over the whole board. That number
 *  falling across the episode IS the deadweight loss the experiment measures. */
export const incomePool = (tiles: Record<HexKey, Tile>): number =>
  Object.values(tiles).reduce((s, t) => s + effYield(t), 0);

/**
 * Generate the initial GameState: 169 seeded walls, the nine hearths owned dry
 * at whatever yield the seed gave them, and `STARTING_PAINT` in every treasury.
 * Pure and deterministic for `(seed, variant)`.
 */
export function generateBoard(seed: number, variant: Variant = "open", turns: number = MAX_TURNS): GameState {
  const rng = makeRng(seed);
  const tiles: Record<HexKey, Tile> = {};
  for (const hex of hexesInRadius(BOARD_RADIUS)) {
    tiles[key(hex)] = {
      hex,
      state: "wall",
      yield: drawYield(rng()),
      owner: null,
      wet: false,
      claimedTurn: -1,
    };
  }
  applyVariant(tiles, variant);

  const cogs: CogState[] = [];
  for (let seat = 0; seat < SEATS; seat++) {
    const hearth = HEARTHS[seat]!;
    // The hearth tile is a normal wall (claimable, razeable, destructible) but
    // the COORDINATE is permanent. At game start each seat owns it, dry.
    const tile = tiles[key(hearth)]!;
    tile.state = "wall";
    tile.owner = seat;
    tile.wet = false;
    tile.claimedTurn = 0;
    cogs.push({
      seat,
      alias: ALIASES[seat]!,
      paint: STARTING_PAINT,
      banked: 0,
      hearth,
      life: "steady",
      struckThisTurn: false,
      razesMade: 0,
      wallsHeld: 1,
      incomeLastTurn: 0,
      fallbacks: 0,
    });
  }

  return {
    turn: 1,
    turns,
    phase: "commit",
    seed,
    variant,
    tiles,
    cogs,
    cogOrder: cogs.map((c) => c.seat),
    log: [],
    talk: [],
    settled: null,
    turnsPlayed: 0,
    poolStart: incomePool(tiles),
    destroyed: 0,
    wars: [],
    credit: cogs.map(() => 0),
  };
}
