// The Upkeep phase — step 9a through 9e of the design note's resolution order:
//
//   a. DRY     every tile with `wet` and `claimedTurn === turn` goes dry. From
//              the next turn it pays income and can no longer be claimed by
//              ANYBODY. Dry paint is removed only by razing — irreversibility is
//              the only door into a rival's territory.
//   b. INCOME  each living seat gains Σ effYield over its DRY owned tiles, so a
//              tile claimed THIS turn contributes nothing this turn.
//   c. CREDIT  salvage and incoming transfers land now (next-turn money).
//   d. LIFE    the strike machine; an eliminated seat's claims revert (life.ts).
//   e. ADVANCE turn += 1.
//
// PURE: the input state is never mutated.

import type { GameState, HexKey, Tile } from "./types";
import type { UpkeepEvent } from "./log";
import { effYield } from "./constants";
import { applyLife } from "./life";

/** Steps 9a–9d. `stepTurn` owns 9e (advance + the TurnRecord). */
export function upkeep(state: GameState): { state: GameState; events: UpkeepEvent[] } {
  const events: UpkeepEvent[] = [];
  const tiles: Record<HexKey, Tile> = {};
  for (const [k, t] of Object.entries(state.tiles)) tiles[k] = { ...t };
  const cogs = state.cogs.map((c) => ({ ...c }));

  // ── 9a. dry ────────────────────────────────────────────────────────────────
  // The tiles claimed THIS turn are the ones that dry now — and precisely the
  // ones excluded from this turn's income (they were wet for its 25 ticks).
  const driedNow: HexKey[] = [];
  for (const [k, t] of Object.entries(tiles)) {
    if (t.wet && t.claimedTurn === state.turn) {
      t.wet = false;
      driedNow.push(k);
    }
  }
  driedNow.sort();
  events.push({ kind: "dried", tiles: driedNow });
  const wetThisTurn = new Set(driedNow);

  // ── 9b. income ─────────────────────────────────────────────────────────────
  for (const cog of cogs) {
    if (cog.life === "eliminated") {
      cog.incomeLastTurn = 0;
      cog.wallsHeld = 0;
      continue;
    }
    let paint = 0;
    let walls = 0;
    for (const [k, t] of Object.entries(tiles)) {
      if (t.owner !== cog.seat) continue;
      walls += 1;
      if (wetThisTurn.has(k)) continue; // claimed this turn: pays nothing
      paint += effYield(t);
    }
    // Income is BOTH spendable paint and score: `banked` is the gross paint
    // EARNED, which is what `results.scores[]` reports and the league ranks by.
    cog.paint += paint;
    cog.banked += paint;
    cog.incomeLastTurn = paint;
    cog.wallsHeld = walls;
    events.push({ kind: "income", seat: cog.seat, paint, walls });
  }

  // ── 9c. credit — salvage + incoming transfers land as spendable paint ──────
  const credit = state.credit.map(() => 0);
  for (const cog of cogs) {
    if (cog.life === "eliminated") continue;
    cog.paint += state.credit[cog.seat] ?? 0;
  }

  // ── 9d. life ───────────────────────────────────────────────────────────────
  const lifed = applyLife({ ...state, phase: "upkeep", tiles, cogs, credit });
  events.push(...lifed.events);

  return { state: lifed.state, events };
}
