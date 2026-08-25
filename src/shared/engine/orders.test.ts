// TEST 2 — the order vocabulary and its legality predicates.
//
// The load-bearing invariant at the end is the escrow-0.1.3 precomputed-choice-set
// guarantee: `legalClaimTargets` / `legalRazeTargets` are EXACTLY the sets the
// validator accepts, over 200 seeded mid-game states. The model never has to
// derive the legal set, so a formal-output fallback storm cannot happen.
import { describe, it, expect } from "vitest";

import { newGame, stepTurn } from "./game";
import { key } from "./hex";
import type { GameState } from "./types";
import {
  claimDistance,
  isLegalClaim,
  isLegalRaze,
  legalClaimTargets,
  legalRazeTargets,
  orderCost,
  razeCost,
} from "./orders";
import { rejectionReason } from "./resolve";
import {
  CLAIM_COST,
  HEARTHS,
  RAZE_COST,
  RAZE_HOME_COST,
  RAZE_OPEN_TURN,
  SEATS,
  TRANSFER_FEE,
} from "./constants";

/** Advance to `turn` with every seat holding, so razing is legal. */
function atTurn(state: GameState, turn: number): GameState {
  let s = state;
  while (s.turn < turn && s.settled === null) s = stepTurn(s, {});
  return s;
}

describe("claim legality", () => {
  const s = newGame(7);

  it("accepts a wall at distance 1 or 2 and prices it 4 / 6", () => {
    const reach = legalClaimTargets(s, 0);
    expect(reach.length).toBeGreaterThan(0);
    for (const k of reach) {
      const d = claimDistance(s, 0, k);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(2);
      expect(orderCost(s, 0, { type: "claim", tile: k })).toBe(CLAIM_COST(d));
    }
    expect(CLAIM_COST(1)).toBe(4);
    expect(CLAIM_COST(2)).toBe(6);
  });

  it("rejects distance 3", () => {
    const far = Object.keys(s.tiles).find((k) => claimDistance(s, 0, k) === 3)!;
    expect(isLegalClaim(s, 0, far)).toBe(false);
    expect(rejectionReason(s, 0, [{ type: "claim", tile: far }])).toMatch(/fling range/);
  });

  it("rejects an owned tile and a nonexistent tile", () => {
    expect(isLegalClaim(s, 0, key(HEARTHS[0]!))).toBe(false);
    expect(rejectionReason(s, 0, [{ type: "claim", tile: key(HEARTHS[0]!) }])).toMatch(/already held/);
    expect(rejectionReason(s, 0, [{ type: "claim", tile: "40,40" }])).toMatch(/no such tile/);
  });

  it("rejects rubble — it is never claimable again", () => {
    const target = legalClaimTargets(s, 0)[0]!;
    const rubbled: GameState = { ...s, tiles: { ...s.tiles, [target]: { ...s.tiles[target]!, state: "rubble" } } };
    expect(isLegalClaim(rubbled, 0, target)).toBe(false);
    expect(rejectionReason(rubbled, 0, [{ type: "claim", tile: target }])).toMatch(/never claimable/);
  });

  it("rejects a set the seat cannot afford", () => {
    const reach = legalClaimTargets(s, 0);
    const orders = reach.slice(0, 4).map((tile) => ({ type: "claim" as const, tile }));
    // Four claims cost at least 16 against 12 stored paint.
    expect(rejectionReason(s, 0, orders)).toMatch(/cannot afford/);
  });
});

describe("raze legality", () => {
  it("is illegal on turn 3 and legal on turn 4", () => {
    const t3 = atTurn(newGame(7), RAZE_OPEN_TURN - 1);
    const target = legalClaimTargets(t3, 0)[0]!;
    expect(t3.turn).toBe(3);
    expect(isLegalRaze(t3, 0, target)).toBe(false);
    expect(rejectionReason(t3, 0, [{ type: "raze", tile: target }])).toMatch(/razing opens on turn 4/);

    const t4 = atTurn(newGame(7), RAZE_OPEN_TURN);
    expect(t4.turn).toBe(4);
    expect(legalRazeTargets(t4, 0).length).toBeGreaterThan(0);
    expect(rejectionReason(t4, 0, [{ type: "raze", tile: legalRazeTargets(t4, 0)[0]! }])).toBeNull();
  });

  it("charges RAZE_HOME_COST iff the target is within 1 of ANOTHER living seat's hearth", () => {
    const s = atTurn(newGame(7), RAZE_OPEN_TURN);
    // Seat 0's own hearth: its own home ring is never surcharged.
    expect(razeCost(s, 0, key(HEARTHS[0]!))).toBe(RAZE_COST);
    // Seat 1's hearth, razed by seat 0: surcharged.
    expect(razeCost(s, 0, key(HEARTHS[1]!))).toBe(RAZE_HOME_COST);
    // And once seat 1 is gone, the surcharge goes with it.
    const dead: GameState = {
      ...s,
      cogs: s.cogs.map((c) => (c.seat === 1 ? { ...c, life: "eliminated" as const } : c)),
    };
    expect(razeCost(dead, 0, key(HEARTHS[1]!))).toBe(RAZE_COST);
  });
});

describe("transfer legality", () => {
  const s = newGame(7);
  it("needs another LIVING seat's alias and costs amount + fee", () => {
    expect(rejectionReason(s, 0, [{ type: "transfer", to: "Ochre", amount: 3 }])).toBeNull();
    expect(orderCost(s, 0, { type: "transfer", to: "Ochre", amount: 3 })).toBe(3 + TRANSFER_FEE);
    expect(rejectionReason(s, 0, [{ type: "transfer", to: "Sable", amount: 1 }])).toMatch(/yourself/);
    expect(rejectionReason(s, 0, [{ type: "transfer", to: "Nobody", amount: 1 }])).toMatch(/no such cog/);
  });
});

describe("the precomputed choice sets ARE the validator's sets", () => {
  it("holds over 200 seeded mid-game states", () => {
    let checked = 0;
    for (let seed = 1; seed <= 25; seed++) {
      let s = newGame(seed, seed % 3 === 0 ? "rooms" : seed % 3 === 1 ? "open" : "inside_out");
      for (let step = 0; step < 8; step++) {
        // Give the seats plenty of paint so affordability never masks legality.
        const rich: GameState = { ...s, cogs: s.cogs.map((c) => ({ ...c, paint: 500 })) };
        for (const seat of [0, 4, 8]) {
          const claims = legalClaimTargets(rich, seat);
          const razes = legalRazeTargets(rich, seat);
          for (const k of Object.keys(rich.tiles)) {
            expect(claims.includes(k)).toBe(rejectionReason(rich, seat, [{ type: "claim", tile: k }]) === null);
            expect(razes.includes(k)).toBe(rejectionReason(rich, seat, [{ type: "raze", tile: k }]) === null);
          }
          checked += 1;
        }
        // Advance with a real, legal move per seat so the states diverge.
        const submissions: Record<number, { orders: Array<{ type: "claim"; tile: string }>; messages: [] }> = {};
        for (const seat of s.cogOrder) {
          const reach = legalClaimTargets(s, seat);
          const pick = reach[(seed + step + seat) % Math.max(1, reach.length)];
          submissions[seat] = { orders: pick ? [{ type: "claim", tile: pick }] : [], messages: [] };
        }
        s = stepTurn(s, submissions);
        if (s.settled !== null) break;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(200);
    expect(SEATS).toBe(9);
  });
});
