// TEST 9 — the scripted baselines are bounded, always legal, and deterministic.
//
// Over 200 seeded mid-game views (varying turn, paint, ownership, damage and
// elimination), for BOTH baselines: every emitted set has
// `orders.length <= MAX_ORDERS_PER_TURN`, `messages.length === 0`, passes the
// engine's legality predicates AND the affordability gate, and is accepted by
// `resolve()` without a `rejected` event. The same view twice gives the identical
// order list.
import { describe, it, expect } from "vitest";

import { newGame, stepTurn } from "../shared/engine/game";
import { resolve, rejectionReason } from "../shared/engine/resolve";
import { legalClaimTargets, legalRazeTargets, orderCost } from "../shared/engine/orders";
import type { GameState } from "../shared/engine/types";
import type { Submission } from "../shared/engine/orders";
import { MAX_ORDERS_PER_TURN, RAZE_OPEN_TURN, SEATS } from "../shared/engine/constants";
import { observe } from "./redact";
import { homesteader, raider, scriptedDecide, RAIDER_PARAMS } from "./scripted";

/** A varied mid-game state: different variants, turns, paint, damage and a
 *  couple of eliminated seats once the game is old enough. */
function midGame(seed: number): GameState {
  const variant = seed % 3 === 0 ? "rooms" : seed % 3 === 1 ? "open" : "inside_out";
  let s = newGame(seed, variant);
  const turns = 1 + (seed % 9);
  for (let t = 0; t < turns && s.settled === null; t++) {
    const submissions: Record<number, Submission> = {};
    for (const seat of s.cogOrder) {
      if (s.cogs[seat]!.life === "eliminated") continue;
      submissions[seat] = seat % 2 === 0 ? homesteader(observe(s, seat)) : raider(observe(s, seat));
    }
    s = stepTurn(s, submissions);
  }
  // Vary paint hard: some seats broke, some flush.
  let tiles = s.tiles;
  if (s.turn > RAZE_OPEN_TURN) {
    // Scar some of the board so `cracked` and `rubble` appear in the views.
    const keys = Object.keys(tiles).sort();
    for (let i = seed % 5; i < keys.length; i += 11) {
      const k = keys[i]!;
      tiles = { ...tiles, [k]: { ...tiles[k]!, state: i % 2 === 0 ? "cracked" : "rubble", owner: null, wet: false } };
    }
  }
  return {
    ...s,
    tiles,
    cogs: s.cogs.map((c) => ({
      ...c,
      paint: (seed * 7 + c.seat * 13) % 40,
      life: s.turn > 5 && c.seat === (seed % SEATS) ? "eliminated" : c.life,
    })),
  };
}

describe("scripted baselines", () => {
  it("are bounded, legal, affordable and accepted over 200 seeded views", () => {
    let checked = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const s = midGame(seed);
      for (const seat of s.cogOrder) {
        if (s.cogs[seat]!.life === "eliminated") continue;
        const view = observe(s, seat);
        for (const name of ["homesteader", "raider"] as const) {
          const move = scriptedDecide(name, view);
          expect(move.orders.length).toBeLessThanOrEqual(MAX_ORDERS_PER_TURN);
          expect(move.messages).toHaveLength(0);
          // Spatial legality, per order.
          for (const o of move.orders) {
            if (o.type === "claim") expect(legalClaimTargets(s, seat)).toContain(o.tile);
            if (o.type === "raze") expect(legalRazeTargets(s, seat)).toContain(o.tile);
          }
          // Affordability, as a set.
          const spend = move.orders.reduce((sum, o) => sum + orderCost(s, seat, o), 0);
          expect(spend).toBeLessThanOrEqual(s.cogs[seat]!.paint);
          // And the engine itself accepts it.
          expect(rejectionReason(s, seat, move.orders)).toBeNull();
          const out = resolve(s, { [seat]: move });
          expect(out.events.filter((e) => e.kind === "rejected" && e.seat === seat)).toHaveLength(0);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(200);
  });

  it("are deterministic: the same view twice gives the identical order list", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const s = midGame(seed);
      for (const seat of s.cogOrder) {
        if (s.cogs[seat]!.life === "eliminated") continue;
        const a = observe(s, seat);
        const b = observe(s, seat);
        expect(homesteader(a)).toEqual(homesteader(b));
        expect(raider(a)).toEqual(raider(b));
      }
    }
  });

  it("homesteader claims the RICHEST reachable wall it can afford and never razes", () => {
    const s = newGame(7);
    const view = observe(s, 0);
    const move = homesteader(view);
    expect(move.orders.every((o) => o.type === "claim")).toBe(true);
    expect(move.orders.length).toBeGreaterThan(0);
    expect(move.orders.length).toBeLessThanOrEqual(3);
    const picked = move.orders.map((o) => (o.type === "claim" ? o.tile : ""));
    const bestAvailable = Math.max(...view.reach.map((k) => view.tiles.find((t) => t.t === k)!.yield));
    const bestPicked = Math.max(...picked.map((k) => view.tiles.find((t) => t.t === k)!.yield));
    expect(bestPicked).toBe(bestAvailable);
  });

  it("raider homesteads before turn 4, then razes the leader's richest reachable wall", () => {
    let s = newGame(7);
    // Turns 1-3: exactly homesteader.
    for (let t = 0; t < 3; t++) {
      for (const seat of s.cogOrder) {
        const view = observe(s, seat);
        expect(raider(view)).toEqual(homesteader(view));
      }
      s = stepTurn(
        s,
        Object.fromEntries(s.cogOrder.map((seat) => [seat, homesteader(observe(s, seat))])),
      );
    }
    expect(s.turn).toBe(4);

    // Make seat 1 the runaway leader, and put a rich tile of its inside seat 0's
    // raze reach so the raid has a target.
    // At the raider's TUNED threshold (docs/baseline-sweep.md), not a literal.
    const target = legalRazeTargets(s, 0).find((k) => s.tiles[k]!.yield >= RAIDER_PARAMS.minYield)!;
    const seeded: GameState = {
      ...s,
      tiles: { ...s.tiles, [target]: { ...s.tiles[target]!, owner: 1, wet: false, claimedTurn: 1 } },
      cogs: s.cogs.map((c) => ({ ...c, banked: c.seat === 1 ? 500 : 1, paint: 60 })),
    };
    const move = raider(observe(seeded, 0));
    expect(move.orders[0]).toEqual({ type: "raze", tile: target });
    expect(rejectionReason(seeded, 0, move.orders)).toBeNull();
  });

  it("holds when nothing is affordable rather than emitting an illegal order", () => {
    const s = newGame(7);
    const broke: GameState = { ...s, cogs: s.cogs.map((c) => ({ ...c, paint: 0 })) };
    for (const seat of broke.cogOrder) {
      const view = observe(broke, seat);
      expect(homesteader(view)).toEqual({ orders: [], messages: [] });
      expect(raider(view)).toEqual({ orders: [], messages: [] });
    }
  });
});
