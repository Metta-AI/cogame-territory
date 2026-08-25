// TEST 5 — income, drying and salvage.
//
// A tile claimed in turn T pays 0 in T and its effective yield from T+1; `cracked`
// pays floor(y/2); `rubble` pays 0; salvage is 4 x effYield and lands as NEXT-turn
// money; and the per-tick identity `effYield × 25 × 0.04 === effYield` holds — that
// identity is the whole reason those three constants are what they are.
import { describe, it, expect } from "vitest";

import { newGame, stepTurn } from "./game";
import { key } from "./hex";
import type { GameState, HexKey } from "./types";
import { effYield, HEARTHS, INCOME_PER_TICK_PER_YIELD, incomePerTurn, SALVAGE_MULT, TICKS_PER_TURN } from "./constants";
import { legalClaimTargets } from "./orders";

const flatten = (s: GameState, patch: Partial<GameState["tiles"][string]>, k: HexKey): GameState => ({
  ...s,
  tiles: { ...s.tiles, [k]: { ...s.tiles[k]!, ...patch } },
});

describe("the per-tick identity", () => {
  it("effYield × TICKS_PER_TURN × INCOME_PER_TICK_PER_YIELD === effYield", () => {
    expect(TICKS_PER_TURN).toBe(25);
    expect(INCOME_PER_TICK_PER_YIELD).toBeCloseTo(0.04, 10);
    for (const y of [0, 1, 2, 3]) {
      expect(y * TICKS_PER_TURN * INCOME_PER_TICK_PER_YIELD).toBeCloseTo(y, 10);
      expect(incomePerTurn(y)).toBe(y);
    }
  });
});

describe("effective yield", () => {
  it("halves once cracked and zeroes once rubble", () => {
    for (const y of [0, 1, 2, 3]) {
      expect(effYield({ state: "wall", yield: y })).toBe(y);
      expect(effYield({ state: "cracked", yield: y })).toBe(Math.floor(y / 2));
      expect(effYield({ state: "rubble", yield: y })).toBe(0);
    }
  });
});

describe("drying and income", () => {
  it("a tile claimed in turn T pays 0 in T and effYield from T+1", () => {
    const base = newGame(7);
    // Make seat 0's hearth worth nothing so the only income is the new claim.
    let s = flatten(base, { yield: 0 }, key(HEARTHS[0]!));
    const target = legalClaimTargets(s, 0).find((k) => s.tiles[k]!.yield === 3)!;
    s = { ...s, cogs: s.cogs.map((c) => (c.seat === 0 ? { ...c, paint: 100 } : c)) };

    const t1 = stepTurn(s, { 0: { orders: [{ type: "claim", tile: target }], messages: [] } });
    // Wet in the turn it was claimed => no income from it this turn.
    expect(t1.cogs[0]!.incomeLastTurn).toBe(0);
    // It dried in that same Upkeep.
    expect(t1.tiles[target]!.wet).toBe(false);
    expect(t1.tiles[target]!.owner).toBe(0);

    const t2 = stepTurn(t1, {});
    expect(t2.cogs[0]!.incomeLastTurn).toBe(3);
    expect(t2.cogs[0]!.banked).toBe(3);
  });

  it("cracked pays floor(y/2) and rubble pays nothing", () => {
    const base = newGame(7);
    const home = key(HEARTHS[0]!);
    const cracked = stepTurn(flatten(base, { yield: 3, state: "cracked" }, home), {});
    expect(cracked.cogs[0]!.incomeLastTurn).toBe(1);

    // Rubble can never be owned (a raze clears the owner), so a rubble tile
    // contributes nothing by construction — assert both the arithmetic and that.
    expect(effYield({ state: "rubble", yield: 3 })).toBe(0);
    const rubble = stepTurn(flatten(base, { yield: 3, state: "rubble" }, home), {});
    expect(rubble.cogs[0]!.incomeLastTurn).toBe(0);
  });

  it("an eliminated seat earns nothing more", () => {
    const base = newGame(7);
    const dead: GameState = {
      ...base,
      cogs: base.cogs.map((c) => (c.seat === 0 ? { ...c, life: "eliminated" as const } : c)),
    };
    const next = stepTurn(dead, {});
    expect(next.cogs[0]!.incomeLastTurn).toBe(0);
    expect(next.cogs[0]!.banked).toBe(0);
  });
});

describe("salvage and next-turn money", () => {
  it("pays 4 × effYield, banks it as score, and only makes it SPENDABLE next turn", () => {
    const base = newGame(7, "open");
    const home = key(HEARTHS[0]!);
    const seeded: GameState = {
      ...flatten(base, { yield: 3, state: "wall" }, home),
      turn: 5,
      cogs: base.cogs.map((c) => (c.seat === 0 ? { ...c, paint: 20 } : c)),
    };
    const next = stepTurn(seeded, { 0: { orders: [{ type: "raze", tile: home }], messages: [] } });
    const salvage = SALVAGE_MULT * 3;
    expect(next.log[0]!.events.find((e) => e.kind === "salvage")).toMatchObject({ paint: salvage });
    // 20 stored − 5 raze cost + 12 salvage credited in Upkeep = 27.
    expect(next.cogs[0]!.paint).toBe(20 - 5 + salvage);
    expect(next.cogs[0]!.banked).toBe(salvage); // it was EARNED, so it scores
    expect(next.credit[0]).toBe(0); // the credit was consumed
  });

  it("a transfer lands as the recipient's next-turn money and never scores", () => {
    const base = newGame(7);
    const seeded: GameState = { ...base, cogs: base.cogs.map((c) => ({ ...c, paint: 30 })) };
    const next = stepTurn(seeded, {
      0: { orders: [{ type: "transfer", to: "Ochre", amount: 5 }], messages: [] },
    });
    // Sender paid 5 + 1 fee.
    expect(next.cogs[0]!.paint).toBe(30 - 6 + next.cogs[0]!.incomeLastTurn);
    // Recipient banked no SCORE from it, only spending power.
    expect(next.cogs[1]!.paint).toBe(30 + 5 + next.cogs[1]!.incomeLastTurn);
    expect(next.cogs[1]!.banked).toBe(next.cogs[1]!.incomeLastTurn);
  });
});
