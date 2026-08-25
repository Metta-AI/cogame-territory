// The serializable core data model: the board (`Tile`), per-Cog state, phases,
// and the top-level `GameState` every other engine module imports. Types only —
// no behavior; correctness is checked by `tsc --noEmit`.

import type { Hex } from "./hex";

/** A tile map key, the `${q},${r}` string for a hex (see `hex.key`). */
export type HexKey = string;

/**
 * A wall's condition. IRREVERSIBLE, in this order: `wall` → `cracked` → `rubble`.
 * A `rubble` tile is inert (income 0), never claimable again, and it stops
 * conducting adjacency — nobody may project a claim or a raze FROM it.
 */
export type TileState = "wall" | "cracked" | "rubble";

/** A seat's life state. `steady` → `staggered` → `eliminated`, driven by strikes. */
export type LifeState = "steady" | "staggered" | "eliminated";

/** One board cell. `yield` is the seeded 0..3 base; `effYield` (upkeep.ts)
 *  halves it once cracked and zeroes it once rubble. */
export interface Tile {
  hex: Hex;
  state: TileState;
  yield: number;
  /** Seat index of the owner, or null for unclaimed ground. */
  owner: number | null;
  /** Paint applied THIS turn: pays no income and dries in this turn's Upkeep. */
  wet: boolean;
  /** The turn the current claim was made (−1 when unowned). */
  claimedTurn: number;
}

/** Per-seat mutable state. */
export interface CogState {
  seat: number;
  /** The anonymous in-game alias (ALIASES[seat]). Never a policy/player name. */
  alias: string;
  /** STORED paint — the only spendable resource. */
  paint: number;
  /** Gross paint EARNED (income + salvage). This is the score; it never falls. */
  banked: number;
  hearth: Hex;
  life: LifeState;
  /** Set by this turn's strike bookkeeping (step 5), read by the life machine. */
  struckThisTurn: boolean;
  /** Cumulative razes this seat has committed (public; the ledger + tie-break). */
  razesMade: number;
  /** Owned tiles at the last snapshot (derived, cached for cheap observations). */
  wallsHeld: number;
  /** Income paid to this seat in the previous Upkeep (public). */
  incomeLastTurn: number;
  /** Times this seat's decision fell back to a scripted/hold move. */
  fallbacks: number;
}

/** The phases exposed to the chrome. */
export type Phase = "commit" | "resolve" | "upkeep";

/** Board generation variants (board generation only; same seats, same rules). */
export type Variant = "open" | "rooms" | "inside_out";

/** One cheap-talk line as recorded. `to` null = public, else the recipient seat.
 *  Talk binds nobody and the engine never reads it back into resolution; it is
 *  state only so `(seed, variant, submissions)` reproduces the transcript too. */
export interface TalkRecord {
  turn: number;
  from: number;
  to: number | null;
  text: string;
}

/** The complete, serializable game state at a point in time. */
export interface GameState {
  turn: number;
  /** The episode's turn horizon (config `turns`, default MAX_TURNS). */
  turns: number;
  phase: Phase;
  seed: number;
  variant: Variant;
  tiles: Record<HexKey, Tile>;
  cogs: CogState[];
  /** Seat indices in stable order — always `[0..SEATS-1]`. */
  cogOrder: number[];
  log: import("./log").TurnRecord[];
  /** The whole cheap-talk transcript (public lines + every DM). Redacted per
   *  seat by `redact`; spectator-side the replay shows all of it. */
  talk: TalkRecord[];
  /** Set once the episode has stopped: the value written to `results.reason`.
   *  Null while the episode is still running. */
  settled: EndReason | null;
  /** Turns actually completed (what `results.turnsPlayed` reports). */
  turnsPlayed: number;
  /** Full-claim income pool at turn 1 — the deadweight-loss baseline. */
  poolStart: number;
  /** Tiles razed all the way to rubble (the irreversible hole count). */
  destroyed: number;
  /** Distinct ordered `attacker>victim` pairs whose first raze on the victim's
   *  ground has occurred — the wars-started ledger. */
  wars: string[];
  /** Next-turn money accrued so far (salvage + incoming transfers), by seat. */
  credit: number[];
}

/** The only three legal values of `results.reason`. */
export type EndReason = "complete" | "elimination" | "deadline";
