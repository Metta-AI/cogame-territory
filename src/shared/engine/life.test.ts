// TEST 4 — the strike machine and the elimination revert.
//
// A raze OUTSIDE the home ring never strikes; inside it does. Strikes in turns 5
// and 6 eliminate; strikes in 5 and 7 do not (the seat recovered in 6). On
// elimination every claim reverts with the TILE STATE PRESERVED, paint is zeroed,
// the score freezes, and the seat leaves `pendingActors` — but it still gets `final`.
import { describe, it, expect } from "vitest";

import { newGame, stepTurn } from "./game";
import { homeRing } from "./board";
import { key } from "./hex";
import { living } from "./life";
import type { GameState, HexKey } from "./types";
import type { Submission } from "./orders";
import { legalRazeTargets } from "./orders";
import { HEARTHS, RAZE_OPEN_TURN } from "./constants";
import { territoryGame } from "../../game/game";

const VICTIM = 1;
const ATTACKER = 0;

/** A board where `ATTACKER` owns a foothold beside `VICTIM`'s home ring and every
 *  seat is rich, at `turn`. */
function siege(turn = RAZE_OPEN_TURN): { state: GameState; ringTile: HexKey; outsideTile: HexKey } {
  const base = newGame(7);
  const ring = homeRing(VICTIM);
  // The victim owns its whole home ring; the attacker owns one of the ring's
  // neighbours so its razes are in range.
  let tiles = { ...base.tiles };
  for (const k of ring) tiles[k] = { ...tiles[k]!, owner: VICTIM, wet: false, claimedTurn: 1, state: "wall", yield: 2 };
  // An attacker foothold: any tile at distance <= 2 of the hearth but outside the ring.
  const hearth = HEARTHS[VICTIM]!;
  const foothold = Object.keys(tiles).find((k) => {
    if (ring.includes(k)) return false;
    const [q, r] = k.split(",").map(Number);
    const d = (Math.abs(q! - hearth.q) + Math.abs(r! - hearth.r) + Math.abs(q! + r! - hearth.q - hearth.r)) / 2;
    return d === 2;
  })!;
  tiles[foothold] = { ...tiles[foothold]!, owner: ATTACKER, wet: false, claimedTurn: 1, state: "wall", yield: 1 };
  // Something outside the home ring the attacker can also reach.
  const outside = Object.keys(tiles).find((k) => {
    if (ring.includes(k) || k === foothold) return false;
    const [q, r] = k.split(",").map(Number);
    const d = (Math.abs(q! - hearth.q) + Math.abs(r! - hearth.r) + Math.abs(q! + r! - hearth.q - hearth.r)) / 2;
    return d === 2 && tiles[k]!.owner === null;
  })!;
  tiles = { ...tiles, [outside]: { ...tiles[outside]!, owner: VICTIM, wet: false, claimedTurn: 1 } };
  return {
    state: { ...base, turn, tiles, cogs: base.cogs.map((c) => ({ ...c, paint: 400 })) },
    ringTile: key(hearth),
    outsideTile: outside,
  };
}

const raze = (tile: HexKey): Submission => ({ orders: [{ type: "raze", tile }], messages: [] });

/** A home-ring tile of `VICTIM` that `VICTIM` still owns and `ATTACKER` can reach
 *  right now — the only kind of raze that can strike. */
function strikeTarget(state: GameState, exclude: HexKey[] = []): HexKey {
  const ring = new Set(homeRing(VICTIM));
  const hit = legalRazeTargets(state, ATTACKER).find(
    (k) => ring.has(k) && state.tiles[k]!.owner === VICTIM && !exclude.includes(k),
  );
  if (!hit) throw new Error("test fixture: no reachable home-ring tile");
  return hit;
}

describe("the strike machine", () => {
  it("a raze OUTSIDE the home ring never strikes", () => {
    const { state, outsideTile } = siege();
    const next = stepTurn(state, { [ATTACKER]: raze(outsideTile) });
    expect(next.cogs[VICTIM]!.life).toBe("steady");
    expect(next.log[0]!.events.some((e) => e.kind === "struck")).toBe(false);
  });

  it("a raze INSIDE the home ring on ground the seat owned staggers it", () => {
    const { state } = siege();
    const next = stepTurn(state, { [ATTACKER]: raze(strikeTarget(state)) });
    expect(next.log[0]!.events.find((e) => e.kind === "struck")).toMatchObject({ seat: VICTIM, by: [ATTACKER] });
    expect(next.cogs[VICTIM]!.life).toBe("staggered");
  });

  it("razing your OWN home ring never strikes you", () => {
    const { state, ringTile } = siege();
    const next = stepTurn(state, { [VICTIM]: raze(ringTile) });
    expect(next.cogs[VICTIM]!.life).toBe("steady");
    expect(next.log[0]!.events.some((e) => e.kind === "struck")).toBe(false);
  });

  it("strikes in two CONSECUTIVE turns eliminate; a quiet turn between them does not", () => {
    const { state } = siege(5);
    const first = strikeTarget(state);

    // Turns 5 and 6: eliminated.
    const t5 = stepTurn(state, { [ATTACKER]: raze(first) });
    expect(t5.cogs[VICTIM]!.life).toBe("staggered");
    const t6 = stepTurn(t5, { [ATTACKER]: raze(strikeTarget(t5, [first])) });
    expect(t6.cogs[VICTIM]!.life).toBe("eliminated");

    // Turns 5 and 7, with 6 quiet: recovered in 6, only staggered again in 7.
    const a6 = stepTurn(t5, {});
    expect(a6.cogs[VICTIM]!.life).toBe("steady");
    expect(a6.log[1]!.events.find((e) => e.kind === "recovered")).toMatchObject({ seat: VICTIM });
    const a7 = stepTurn(a6, { [ATTACKER]: raze(strikeTarget(a6, [first])) });
    expect(a7.cogs[VICTIM]!.life).toBe("staggered");
  });

  it("on elimination every claim reverts with the TILE STATE PRESERVED, paint zeroed, score frozen", () => {
    const { state, outsideTile } = siege(5);
    // Crack one of the victim's tiles first, so the revert has state to preserve.
    const seeded: GameState = {
      ...state,
      tiles: { ...state.tiles, [outsideTile]: { ...state.tiles[outsideTile]!, state: "cracked" } },
    };
    const cracked = outsideTile;
    const first = strikeTarget(seeded);
    const t5 = stepTurn(seeded, { [ATTACKER]: raze(first) });
    const frozenScore = t5.cogs[VICTIM]!.banked;
    const t6 = stepTurn(t5, { [ATTACKER]: raze(strikeTarget(t5, [first])) });

    expect(t6.cogs[VICTIM]!.life).toBe("eliminated");
    expect(t6.cogs[VICTIM]!.paint).toBe(0);
    expect(Object.values(t6.tiles).some((t) => t.owner === VICTIM)).toBe(false);
    expect(t6.tiles[cracked]!.state).toBe("cracked"); // state untouched by the revert
    expect(t6.log[1]!.events.find((e) => e.kind === "eliminated")).toMatchObject({ seat: VICTIM });

    // The score FREEZES: further turns add nothing to it.
    const t7 = stepTurn(t6, {});
    expect(t7.cogs[VICTIM]!.banked).toBe(t6.cogs[VICTIM]!.banked);
    expect(t6.cogs[VICTIM]!.banked).toBeGreaterThanOrEqual(frozenScore);

    // It leaves pendingActors — never asked again, so it costs no further LLM
    // calls — but it is still one of nine seats in `score`, so `final` still
    // carries its number.
    const seam = { engine: t7, pending: living(t7), submissions: {} };
    expect(territoryGame.pendingActors(seam)).not.toContain(VICTIM);
    expect(Object.keys(territoryGame.score(seam))).toHaveLength(9);
    expect(living(t7)).not.toContain(VICTIM);
  });
});
