// TEST 3 — the numbered resolution order.
//
// Razes precede claims (a partner razes and you claim the freed tile in the SAME
// turn); two razes in one turn make rubble and any same-turn claim on it is voided
// WITH THE PAINT STILL SPENT; two claimants smear the tile and both are charged;
// one illegal entry bounces the whole set; and the charge never underflows.
import { describe, it, expect } from "vitest";

import { newGame, stepTurn } from "./game";
import { resolve } from "./resolve";
import { key } from "./hex";
import type { GameState, HexKey } from "./types";
import type { Submission } from "./orders";
import { legalClaimTargets } from "./orders";
import { CLAIM_COST, HEARTHS, RAZE_OPEN_TURN, SALVAGE_MULT } from "./constants";

/** A state at `turn` with rich seats, so affordability never masks a rule. */
function rich(turn = RAZE_OPEN_TURN, variant: GameState["variant"] = "open"): GameState {
  const base = newGame(7, variant);
  return { ...base, turn, cogs: base.cogs.map((c) => ({ ...c, paint: 300 })) };
}

const hold = (): Submission => ({ orders: [], messages: [] });

/** Force a tile into a known shape so a rule can be tested in isolation. */
function withTile(s: GameState, k: HexKey, patch: Partial<GameState["tiles"][string]>): GameState {
  return { ...s, tiles: { ...s.tiles, [k]: { ...s.tiles[k]!, ...patch } } };
}

describe("resolve order", () => {
  it("applies razes BEFORE claims: a raze cracks the wall and the same-turn claim takes it cracked", () => {
    const s = rich();
    // The target must be legal at VALIDATION time, which runs against the
    // pre-batch board — so it is an unowned wall inside seat 1's reach. The raze
    // lands first and the claim then resolves against the POST-RAZE board.
    const target = legalClaimTargets(s, 1).find((k) => s.tiles[k]!.yield >= 2)!;
    expect(s.tiles[target]!.state).toBe("wall");

    const out = resolve(s, {
      1: { orders: [{ type: "raze", tile: target }, { type: "claim", tile: target }], messages: [] },
    });
    const raze = out.events.find((e) => e.kind === "raze");
    const claim = out.events.find((e) => e.kind === "claim");
    expect(raze).toMatchObject({ seat: 1, tile: target, from_state: "wall", to_state: "cracked" });
    expect(claim).toMatchObject({ seat: 1, tile: target });
    expect(out.state.tiles[target]!.state).toBe("cracked");
    expect(out.state.tiles[target]!.owner).toBe(1);
    expect(out.state.tiles[target]!.wet).toBe(true);
    // The claim took the HALVED yield, which is the whole point of the ordering.
    expect(claim && claim.kind === "claim" ? claim.yield : -1).toBe(Math.floor(s.tiles[target]!.yield / 2));
  });

  it("a raze strips a rival's claim, and the ground is claimable again NEXT turn", () => {
    let s = rich();
    const victimTile = legalClaimTargets(s, 1)[0]!;
    s = withTile(s, victimTile, { owner: 0, wet: false, claimedTurn: 1, state: "wall", yield: 2 });
    // While seat 0 holds it, seat 1 cannot claim it — the whole set would bounce.
    expect(legalClaimTargets(s, 1)).not.toContain(victimTile);

    const razed = resolve(s, { 1: { orders: [{ type: "raze", tile: victimTile }], messages: [] } });
    expect(razed.state.tiles[victimTile]!.owner).toBeNull();
    expect(razed.state.tiles[victimTile]!.state).toBe("cracked");
    // Now it is open ground again, at half the yield, forever.
    expect(legalClaimTargets(razed.state, 1)).toContain(victimTile);
  });

  it("two razes in one turn make RUBBLE, and a same-turn claim on it is voided with the paint spent", () => {
    const s = rich();
    const target = legalClaimTargets(s, 1).find((k) => s.tiles[k]!.yield >= 1)!;
    const paintBefore = s.cogs[1]!.paint;

    const out = resolve(s, {
      1: {
        orders: [
          { type: "raze", tile: target },
          { type: "raze", tile: target },
          { type: "claim", tile: target },
        ],
        messages: [],
      },
    });
    expect(out.state.tiles[target]!.state).toBe("rubble");
    expect(out.state.destroyed).toBe(1);
    expect(out.events.find((e) => e.kind === "voided")).toEqual({
      kind: "voided",
      seat: 1,
      tile: target,
      reason: "rubble",
    });
    // Every order was charged: two razes AND the void claim.
    const spent = out.events.reduce((sum, e) => sum + (e.kind === "order" ? e.cost : 0), 0);
    expect(out.events.filter((e) => e.kind === "order")).toHaveLength(3);
    expect(paintBefore - out.state.cogs[1]!.paint).toBe(spent);
  });

  it("two claimants SMEAR the tile: nobody holds it and both pay in full", () => {
    const s = rich(1);
    // Find a tile both seat 0 and seat 1 can reach... hearths are >= 3 apart, so
    // instead give seat 1 a foothold beside seat 0's reach.
    const target = legalClaimTargets(s, 0)[0]!;
    const seeded = withTile({ ...s }, target, { owner: null, state: "wall" });
    const neighbourOfTarget = Object.keys(seeded.tiles).find(
      (k) => k !== target && legalClaimTargets(withTile(seeded, k, { owner: 1 }), 1).includes(target),
    )!;
    const board = withTile(seeded, neighbourOfTarget, { owner: 1, wet: false, claimedTurn: 1 });

    const before0 = board.cogs[0]!.paint;
    const before1 = board.cogs[1]!.paint;
    const out = resolve(board, {
      0: { orders: [{ type: "claim", tile: target }], messages: [] },
      1: { orders: [{ type: "claim", tile: target }], messages: [] },
    });
    const smear = out.events.find((e) => e.kind === "smear");
    expect(smear).toEqual({ kind: "smear", tile: target, seats: [0, 1] });
    expect(out.state.tiles[target]!.owner).toBeNull();
    expect(out.state.tiles[target]!.wet).toBe(false);
    expect(out.state.cogs[0]!.paint).toBeLessThan(before0);
    expect(out.state.cogs[1]!.paint).toBeLessThan(before1);
  });

  it("bounces the WHOLE set on one illegal entry — no partial application", () => {
    const s = rich(1);
    const good = legalClaimTargets(s, 0)[0]!;
    const out = resolve(s, {
      0: { orders: [{ type: "claim", tile: good }, { type: "claim", tile: "40,40" }], messages: [] },
    });
    expect(out.events.find((e) => e.kind === "rejected")).toMatchObject({ seat: 0 });
    expect(out.events.some((e) => e.kind === "claim")).toBe(false);
    expect(out.state.tiles[good]!.owner).toBeNull();
    expect(out.state.cogs[0]!.paint).toBe(s.cogs[0]!.paint);
  });

  it("pays salvage on the FIRST raze of your own wall only, as next-turn money", () => {
    let s = rich();
    const own = key(HEARTHS[0]!);
    s = withTile(s, own, { owner: 0, state: "wall", yield: 3, wet: false, claimedTurn: 1 });
    const out = resolve(s, { 0: { orders: [{ type: "raze", tile: own }], messages: [] } });
    const salvage = out.events.find((e) => e.kind === "salvage");
    expect(salvage).toMatchObject({ kind: "salvage", seat: 0, tile: own, paint: SALVAGE_MULT * 3 });
    // Salvage is NEXT-turn money: it lands in `credit`, not in `paint`.
    expect(out.state.credit[0]).toBe(SALVAGE_MULT * 3);
    // But it counts toward the score immediately — it was EARNED.
    expect(out.state.cogs[0]!.banked).toBe(SALVAGE_MULT * 3);

    // A second raze, now on a cracked tile the seat no longer owns, pays nothing.
    const again = resolve(out.state, { 0: { orders: [{ type: "raze", tile: own }], messages: [] } });
    expect(again.events.some((e) => e.kind === "salvage")).toBe(false);
    expect(again.state.tiles[own]!.state).toBe("rubble");
  });

  it("never underflows the charge (the affordability invariant)", () => {
    // Rejected sets are the gate; a plan that survives step 2 always affords.
    let s = newGame(11);
    for (let t = 0; t < 12 && s.settled === null; t++) {
      const submissions: Record<number, Submission> = {};
      for (const seat of s.cogOrder) {
        const reach = legalClaimTargets(s, seat);
        const affordable = reach.filter((k) => CLAIM_COST(1) <= s.cogs[seat]!.paint).slice(0, 2);
        submissions[seat] = { orders: affordable.map((tile) => ({ type: "claim", tile })), messages: [] };
      }
      s = stepTurn(s, submissions);
      for (const cog of s.cogs) expect(cog.paint).toBeGreaterThanOrEqual(0);
    }
  });

  it("posts talk even for a seat whose orders bounced, capped and rune-safe", () => {
    const s = rich(1);
    const out = resolve(s, {
      0: {
        orders: [{ type: "claim", tile: "40,40" }],
        messages: [
          { to: null, text: "border at the ridge" },
          { to: "Ochre", text: "pay me" },
          { to: "Nobody", text: "unknown alias becomes public" },
          { to: null, text: "this fourth line is dropped" },
        ],
      },
    });
    const talk = out.events.filter((e) => e.kind === "talk");
    expect(talk).toHaveLength(3); // the fourth entry is DROPPED, not rejected
    expect(talk[0]).toMatchObject({ seat: 0, to: null });
    expect(talk[1]).toMatchObject({ seat: 0, to: 1 });
    expect(talk[2]).toMatchObject({ seat: 0, to: null }); // unknown alias -> public
    expect(out.events.some((e) => e.kind === "rejected")).toBe(true);
  });

  it("holds an empty order set for any seat, any turn", () => {
    const s = newGame(3);
    const out = resolve(s, Object.fromEntries(s.cogOrder.map((seat) => [seat, hold()])));
    expect(out.events.some((e) => e.kind === "rejected")).toBe(false);
    expect(out.events.some((e) => e.kind === "order")).toBe(false);
  });
});
