// HumanPilot races: a player may submit a decision in the brief window BEFORE the
// runner parks their turn (at game start the loop first awaits every bot's intro).
// Such a submit must be buffered and honored when the turn parks, not dropped.

import { describe, it, expect } from "vitest";
import { HumanPilot } from "../src/human-pilot";
import type { DecideContext } from "../src/pilot";

type D = { ok: boolean };

// A minimal DecideContext: HumanPilot only reads `seat` and `validate`. The gate
// accepts a legal move and throws a re-promptable reason for an illegal one.
function ctx(seat: number): DecideContext<unknown, D> {
  return {
    seat,
    validate: (c: unknown): D => {
      if (c && typeof c === "object" && (c as D).ok) return c as D;
      throw new Error("illegal move");
    },
  } as unknown as DecideContext<unknown, D>;
}

describe("HumanPilot raced submit", () => {
  it("buffers a submit that arrives before the turn is parked and resolves on park", async () => {
    const pilot = new HumanPilot<unknown, D>();
    // Submit BEFORE decide() — the turn is not parked yet.
    expect(pilot.isAwaiting(0)).toBe(false);
    expect(pilot.submit(0, { ok: true })).toBeUndefined(); // buffered, not delivered
    // decide() parks the turn and immediately delivers the buffered submit.
    await expect(pilot.decide(ctx(0))).resolves.toEqual({ ok: true });
  });

  it("delivers normally when the turn is already parked", async () => {
    const pilot = new HumanPilot<unknown, D>();
    const decided = pilot.decide(ctx(0));
    expect(pilot.isAwaiting(0)).toBe(true);
    expect(pilot.submit(0, { ok: true })).toEqual({ ok: true });
    await expect(decided).resolves.toEqual({ ok: true });
  });

  it("drops an ILLEGAL raced submit and leaves the turn parked for a fresh attempt", async () => {
    const pilot = new HumanPilot<unknown, D>();
    pilot.submit(0, { ok: false }); // illegal, buffered
    const decided = pilot.decide(ctx(0));
    // The illegal buffered move did not resolve the turn — it stays parked.
    expect(pilot.isAwaiting(0)).toBe(true);
    // A subsequent legal submit resolves it.
    pilot.submit(0, { ok: true });
    await expect(decided).resolves.toEqual({ ok: true });
  });

  it("does not leak a buffered submit across a cancel (reset)", async () => {
    const pilot = new HumanPilot<unknown, D>();
    pilot.submit(0, { ok: true }); // buffered
    pilot.cancel(0); // reset before the turn ever parked
    // The next turn must NOT auto-resolve from the stale buffer; it stays parked.
    const decided = pilot.decide(ctx(0));
    expect(pilot.isAwaiting(0)).toBe(true);
    pilot.cancel(0);
    await expect(decided).rejects.toThrow();
  });
});
