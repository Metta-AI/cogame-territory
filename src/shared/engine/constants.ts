// Every tunable number in Territory, one exported const each. The design note
// (docs/plans/2026-08-25-territory-design.md) is the source of truth; nothing in
// the engine hard-codes a value that is not named here.

import type { Hex } from "./hex";

/** Seat count. Nine, everywhere, no exceptions — variants, the cert fixture and
 *  the CI smoke all cross-check against this one number. */
export const SEATS = 9;

/** Board radius in hexes. Radius 7 => 169 tiles. */
export const BOARD_RADIUS = 7;

/** Turns in a full episode. One decision point per living seat per turn. */
export const MAX_TURNS = 18;

/** Sim ticks inside one turn. Ticks set the income/drying arithmetic; there are
 *  no per-tick decisions. */
export const TICKS_PER_TURN = 25;

/** A tile's EFFECTIVE yield: `wall → yield`, `cracked → floor(yield/2)`,
 *  `rubble → 0`. The single place the destruction ladder becomes arithmetic. */
export const effYield = (t: { state: import("./types").TileState; yield: number }): number =>
  t.state === "wall" ? t.yield : t.state === "cracked" ? Math.floor(t.yield / 2) : 0;

/** Paint per tick per unit of effective yield. `4 × 0.01`: Melting Pot's
 *  0.01/tick over a 25-tick turn is 0.25/turn/wall; Territory scales that ×4 so
 *  the thinnest wall pays exactly ONE whole paint per turn and every number a
 *  spectator reads is an integer. See `incomePerTurn`. */
export const INCOME_PER_TICK_PER_YIELD = 0.04;

/** `effYield × TICKS_PER_TURN × INCOME_PER_TICK_PER_YIELD === effYield`. The
 *  identity is asserted by income.test.ts — it is the whole reason the constants
 *  are those three numbers. */
export const incomePerTurn = (effYield: number): number =>
  Math.round(effYield * TICKS_PER_TURN * INCOME_PER_TICK_PER_YIELD);

/** Paint each seat holds at turn 1. */
export const STARTING_PAINT = 12;

/** Fling range: a claim or raze must land within this hex distance of the seat's
 *  nearest OWNED tile (or its hearth if it owns nothing at all). */
export const FLING_RANGE = 2;

/** `CLAIM_COST(dist) = CLAIM_BASE + CLAIM_PER_DIST × dist` → 4 at dist 1, 6 at 2. */
export const CLAIM_BASE = 2;
export const CLAIM_PER_DIST = 2;
export const CLAIM_COST = (dist: number): number => CLAIM_BASE + CLAIM_PER_DIST * dist;

/** Paint charged for a raze, and the surcharge for razing inside distance 1 of
 *  another LIVING seat's hearth (an assassination costs 2 × this plus two turns
 *  of public warning). */
export const RAZE_COST = 5;
export const RAZE_HOME_COST = 10;

/** Razes are illegal before this turn: the opening is claiming and talking. */
export const RAZE_OPEN_TURN = 4;

/** Salvage on the FIRST raze of a tile you own = `SALVAGE_MULT × effYield`,
 *  paid as next-turn money. Break-even against holding is turn 14. */
export const SALVAGE_MULT = 4;

/** Paint burned on top of the amount moved by a `transfer`. */
export const TRANSFER_FEE = 1;

/** Hard cap on orders in one reply; the whole set bounces if it is exceeded. */
export const MAX_ORDERS_PER_TURN = 8;

/** Reply caps. `messages` past MAX_LINES are DROPPED; `text`/`note` past their
 *  cap are TRUNCATED on rune boundaries (see text.ts). */
export const MAX_SAY_LEN = 200;
export const MAX_LINES = 3;
export const MAX_NOTE_LEN = 120;

/** Seeded yield draw: `u < 0.45 → 0`, `< 0.75 → 1`, `< 0.92 → 2`, else 3. */
export const YIELD_THRESHOLDS: readonly number[] = [0.45, 0.75, 0.92];

/** The nine fixed anonymous in-game aliases, index-ordered. These are the ONLY
 *  names any observation, DM address or rendered event text carries. */
export const ALIASES: readonly string[] = [
  "Sable",
  "Ochre",
  "Verdant",
  "Cobalt",
  "Amber",
  "Violet",
  "Teal",
  "Rose",
  "Ash",
];

/** One immutable hearth per seat, on ring 5. Ring 5 has 30 tiles; in traversal
 *  order from (5,0) stepping (0,-1),(-1,0),(-1,+1),(0,+1),(+1,0),(+1,-1) five
 *  times each, seat i takes index floor(i·30/9). Minimum pairwise hex distance
 *  is 3 (asserted by board.test.ts). */
export const HEARTHS: readonly Hex[] = [
  { q: 5, r: 0 },
  { q: 5, r: -3 },
  { q: 4, r: -5 },
  { q: 0, r: -5 },
  { q: -3, r: -2 },
  { q: -5, r: 1 },
  { q: -5, r: 5 },
  { q: -2, r: 5 },
  { q: 1, r: 4 },
];

/** Per-seat colours for the viewer (index-ordered, matching ALIASES). */
export const SEAT_COLORS: readonly string[] = [
  "#ff2e63",
  "#36e07f",
  "#4d7cff",
  "#ff9838",
  "#c061ff",
  "#42d4f4",
  "#ffe14d",
  "#ff6ec7",
  "#9fb2c4",
];

// ── wall-clock budget (host-side; the engine itself has no clock) ─────────────

/** Per-reply timeout for one seat's decision. */
export const ACT_TIMEOUT_MS = 20_000;

/** Floor on the spacing between batch STARTS, so a turn costs max(batch, this).
 *  The cert fixture pins `paceMs: 0`. */
export const BATCH_MIN_MS = 22_000;

/** How long the host waits for every player to connect before starting anyway. */
export const CONNECT_DEADLINE_MS = 45_000;

/** Episode wall-clock guard. At step 10, `elapsed + 2 × ACT_TIMEOUT_MS >` this
 *  settles the episode early with `reason: "deadline"` — artifacts always written. */
export const EPISODE_DEADLINE_MS = 660_000;

/** Bounded post-episode linger during which /healthz, /client/* and /global keep
 *  answering before the process exits 0. */
export const SHUTDOWN_GRACE_MS = 20_000;
