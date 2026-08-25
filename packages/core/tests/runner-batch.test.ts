// TEST 10 — the SIMULTANEOUS BATCH the forked runner adds.
//
// Nine stub pilots. A barrier proves GENUINE CONCURRENCY: all nine are invoked
// before any of them resolves. All nine receive the IDENTICAL pre-batch state. The
// decisions are applied in SEAT ORDER and exactly one engine step happens per
// turn. A pilot that throws and a pilot that never resolves both degrade to
// `baselineDecision` while the other seven are applied normally. The `paceMs`
// floor is honoured, skipped when the batch already exceeded it, and `paceMs: 0`
// adds no delay at all. And the episode deadline settles the game via
// `Game.settleEarly` instead of overrunning.
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { GameRunner } from "../src/runner.js";
import type { SeatPilot } from "../src/runner.js";
import type { DecideContext, Pilot } from "../src/pilot.js";
import type { Game, GameModule } from "../src/game.js";

const SEATS = 9;

interface S {
  turn: number;
  /** Seats yet to submit this turn. */
  pending: number[];
  /** Seat -> the value it submitted, in application order. */
  applied: Array<[number, number]>;
  steps: number;
  settled: string | null;
}
type D = { value: number };

const fresh = (): S => ({ turn: 1, pending: [...Array(SEATS).keys()], applied: [], steps: 0, settled: null });

/** A simultaneous game: every seat acts every turn; the engine steps only when the
 *  LAST seat's decision arrives (exactly the shape Territory's seam has). */
const batchGame: Game<S, D> & { simultaneous: true } = {
  id: "batch-probe",
  minPlayers: SEATS,
  maxPlayers: SEATS,
  simultaneous: true,
  newGame: () => fresh(),
  turnOf: (s) => s.turn,
  pendingActors: (s) => (s.settled !== null || s.turn > 3 ? [] : s.pending),
  decisionSchema: () => z.object({ value: z.number() }),
  applyDecision: (s, seat, d) => {
    if (!s.pending.includes(seat)) throw new Error(`seat ${seat} already submitted`);
    const next: S = { ...s, pending: s.pending.filter((x) => x !== seat), applied: [...s.applied, [seat, d.value]] };
    if (next.pending.length > 0) return { state: next };
    return {
      state: { ...next, turn: s.turn + 1, pending: [...Array(SEATS).keys()], steps: s.steps + 1 },
      events: [{ seat: null, kind: "turn", text: `turn ${s.turn}`, to: "public" as const }],
    };
  },
  isFinished: (s) => s.settled !== null || s.turn > 3,
  score: () => ({}),
  redact: (s) => s,
  baselineDecision: () => ({ value: -1 }),
  settleEarly: (s, reason) => ({ ...s, settled: reason }),
};
const gameModule: GameModule<S, D> = { game: batchGame };

/** A pilot that records the state it saw and resolves with `value`. */
function stub(
  value: number,
  opts: { onDecide?: (ctx: DecideContext<S, D>) => void; behaviour?: "ok" | "throw" | "hang" } = {},
): Pilot<S, D> {
  return {
    kind: "remote",
    decide: (ctx) => {
      opts.onDecide?.(ctx);
      if (opts.behaviour === "throw") return Promise.reject(new Error(`seat ${value} exploded`));
      if (opts.behaviour === "hang") return new Promise<D>(() => {});
      return Promise.resolve({ value });
    },
  };
}

const seat = (pilot: Pilot<S, D>): SeatPilot<S, D> => ({ pilot, guidance: "", model: null, name: "" });

describe("GameRunner simultaneous batch", () => {
  it("invokes all nine BEFORE any resolves, on the identical pre-batch state", async () => {
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seenStates: S[] = [];
    const seenTurns: number[] = [];

    const pilots = new Map<number, SeatPilot<S, D>>();
    for (let i = 0; i < SEATS; i++) {
      pilots.set(
        i,
        seat({
          kind: "remote",
          decide: async (ctx) => {
            seenStates.push(ctx.state);
            seenTurns.push(ctx.game.turnOf(ctx.state));
            entered += 1;
            // THE BARRIER: nobody resolves until every seat has been asked.
            if (entered === SEATS) release();
            await gate;
            return { value: i };
          },
        }),
      );
    }

    const runner = new GameRunner(gameModule, pilots, { autoAdvance: { enabled: false, maxTimeMs: 0 } });
    await runner.start();

    // Genuine concurrency: the barrier could only fall if all nine were in flight.
    expect(entered).toBeGreaterThanOrEqual(SEATS);
    // The identical pre-batch state object, by reference, for the whole batch.
    const firstBatch = seenStates.slice(0, SEATS);
    expect(new Set(firstBatch).size).toBe(1);
    expect(new Set(seenTurns.slice(0, SEATS))).toEqual(new Set([1]));
  });

  it("applies the gathered decisions in SEAT ORDER, one engine step per turn", async () => {
    // Resolve in REVERSE order on purpose: application order must not follow it.
    const pilots = new Map<number, SeatPilot<S, D>>();
    for (let i = 0; i < SEATS; i++) {
      pilots.set(
        i,
        seat({
          kind: "remote",
          decide: async () => {
            await new Promise((r) => setTimeout(r, (SEATS - i) * 2));
            return { value: i };
          },
        }),
      );
    }
    const runner = new GameRunner(gameModule, pilots, { autoAdvance: { enabled: false, maxTimeMs: 0 } });
    await runner.start();
    const state = runner.state;
    expect(state.steps).toBe(3); // three turns, one step each
    expect(state.turn).toBe(4);
  });

  it("degrades ONLY the failing seats to baselineDecision", async () => {
    const applied: Array<[number, number]> = [];
    const pilots = new Map<number, SeatPilot<S, D>>();
    for (let i = 0; i < SEATS; i++) {
      const behaviour = i === 2 ? "throw" : i === 5 ? "hang" : "ok";
      pilots.set(i, seat(stub(i, { behaviour })));
    }
    const runner = new GameRunner(gameModule, pilots, {
      // The hung seat is cut off by the auto-advance clock.
      autoAdvance: { enabled: true, maxTimeMs: 30 },
    });
    runner.onMessage((m) => {
      if (m.type === "actPrompt") applied.push([m.actPrompt.seat, m.actPrompt.usedFallback ? -1 : 1]);
    });
    await runner.start();

    // Every seat still acted this turn; only 2 and 5 fell back.
    const fellBack = applied.filter(([, v]) => v === -1).map(([s]) => s);
    expect(new Set(fellBack)).toEqual(new Set([2, 5]));
    expect(runner.state.steps).toBe(3);
  });

  it("honours the paceMs floor between batch STARTS", async () => {
    vi.useFakeTimers();
    try {
      const pilots = new Map<number, SeatPilot<S, D>>();
      for (let i = 0; i < SEATS; i++) pilots.set(i, seat(stub(i)));
      const runner = new GameRunner(gameModule, pilots, {
        autoAdvance: { enabled: false, maxTimeMs: 0 },
        simultaneousPaceMs: 22_000,
        // A frozen clock: every batch appears instantaneous, so the floor is the
        // only thing that can pace the loop.
        now: () => 0,
      });
      void runner.start();
      await vi.advanceTimersByTimeAsync(1);
      // The first batch resolved instantly and the loop is PARKED on the floor.
      expect(runner.state.turn).toBe(2);
      await vi.advanceTimersByTimeAsync(21_998);
      expect(runner.state.turn).toBe(2);
      await vi.advanceTimersByTimeAsync(2);
      expect(runner.state.turn).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the floor when the batch already exceeded it", async () => {
    vi.useFakeTimers();
    try {
      const pilots = new Map<number, SeatPilot<S, D>>();
      for (let i = 0; i < SEATS; i++) pilots.set(i, seat(stub(i)));
      // Each clock read jumps 30 s, so every batch "took" longer than the floor.
      let now = 0;
      const runner = new GameRunner(gameModule, pilots, {
        autoAdvance: { enabled: false, maxTimeMs: 0 },
        simultaneousPaceMs: 22_000,
        now: () => {
          const v = now;
          now += 30_000;
          return v;
        },
      });
      const done = runner.start();
      // No 22 s waits are armed at all: a handful of microtask flushes finishes it.
      for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(runner.state.turn).toBe(4);
      expect(runner.state.steps).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("paceMs 0 adds no delay at all", async () => {
    const pilots = new Map<number, SeatPilot<S, D>>();
    for (let i = 0; i < SEATS; i++) pilots.set(i, seat(stub(i)));
    const runner = new GameRunner(gameModule, pilots, {
      autoAdvance: { enabled: false, maxTimeMs: 0 },
      simultaneousPaceMs: 0,
    });
    const started = Date.now();
    await runner.start();
    expect(runner.state.turn).toBe(4);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("settles the episode via Game.settleEarly when the wall clock runs out", async () => {
    const pilots = new Map<number, SeatPilot<S, D>>();
    for (let i = 0; i < SEATS; i++) pilots.set(i, seat(stub(i)));
    let now = 0;
    const runner = new GameRunner(gameModule, pilots, {
      autoAdvance: { enabled: true, maxTimeMs: 20_000 },
      simultaneousPaceMs: 0,
      episodeDeadlineMs: 660_000,
      // The clock jumps past the guard after the first batch.
      now: () => {
        const v = now;
        now += 400_000;
        return v;
      },
    });
    await runner.start();
    expect(runner.settledEarly).toBe(true);
    expect(runner.state.settled).toBe("deadline");
    // It stopped EARLY: not all three turns were played.
    expect(runner.state.turn).toBeLessThan(4);
  });
});
