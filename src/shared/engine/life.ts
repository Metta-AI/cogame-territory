// PERMADEATH — the strike machine and the elimination revert. Melting Pot's
// "zapped twice: gone, all their claims revert", read at turn granularity.
//
//   steady    + struck                     -> staggered   (public; the plate flashes)
//   staggered + struck in the NEXT turn     -> eliminated
//   staggered + a turn with no strike       -> steady      (recovered)
//
// A seat is STRUCK in turn T iff at least one raze committed by ANOTHER seat in
// turn T lands on a tile inside that seat's HOME RING (its hearth or one of the
// <=6 neighbours) which that seat OWNED at the start of turn T's Resolve.
// Razing your own home ring never strikes you. `struckThisTurn` is set by
// resolve.ts step 5; this module only reads it.
//
// Because a raze needs a projection origin within distance 2, the besieged seat
// has a real counter: raze the attacker's nearest foothold. The destruction rule
// is simultaneously the weapon and the shield.

import type { GameState, HexKey, Tile } from "./types";
import type { UpkeepEvent } from "./log";

/** Seats that are still in the game. */
export const living = (state: GameState): number[] =>
  state.cogs.filter((c) => c.life !== "eliminated").map((c) => c.seat);

/**
 * Step 9d. Apply the strike machine and, on elimination, revert that seat's
 * claims: `owner = null, wet = false` with the tile STATE untouched (a cracked
 * tile stays cracked, rubble stays rubble), paint zeroed and unspendable, score
 * FROZEN at what it had already banked. Pure.
 */
export function applyLife(state: GameState): { state: GameState; events: UpkeepEvent[] } {
  const events: UpkeepEvent[] = [];
  const cogs = state.cogs.map((c) => ({ ...c }));
  let tiles: Record<HexKey, Tile> | null = null;

  for (const cog of cogs) {
    if (cog.life === "eliminated") {
      cog.struckThisTurn = false;
      continue;
    }
    if (cog.struckThisTurn) {
      if (cog.life === "steady") {
        cog.life = "staggered";
      } else {
        cog.life = "eliminated";
        cog.paint = 0;
        if (tiles === null) {
          tiles = {};
          for (const [k, t] of Object.entries(state.tiles)) tiles[k] = { ...t };
        }
        let reverted = 0;
        for (const t of Object.values(tiles)) {
          if (t.owner !== cog.seat) continue;
          t.owner = null;
          t.wet = false;
          t.claimedTurn = -1;
          reverted += 1;
        }
        cog.wallsHeld = 0;
        events.push({ kind: "eliminated", seat: cog.seat, tilesReverted: reverted });
      }
    } else if (cog.life === "staggered") {
      cog.life = "steady";
      events.push({ kind: "recovered", seat: cog.seat });
    }
    cog.struckThisTurn = false;
  }

  return { state: { ...state, cogs, ...(tiles ? { tiles } : {}) }, events };
}
