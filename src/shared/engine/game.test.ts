// TEST 7 — a whole episode, and the three end reasons.
//
// A full 9-seat 18-turn scripted game is byte-identical across two runs for one
// seed and ends `complete` with `turnsPlayed: 18`; a fixture that eliminates eight
// seats ends `elimination` at that turn; and a settle past the deadline ends
// `deadline` WITH ARTIFACTS WRITTEN (here: with the endcard and the results the
// artifact is built from).
import { describe, it, expect } from "vitest";

import { endReason, isFinished, newGame, scoreGame, settleEarly, stepTurn } from "./game";
import { homeRing } from "./board";
import type { GameState } from "./types";
import type { Submission } from "./orders";
import { legalRazeTargets } from "./orders";
import { MAX_TURNS, SEATS } from "./constants";
import { observe } from "../../game/redact";
import { homesteader, raider } from "../../game/scripted";
import { buildResults } from "../../coworld/results";

/** Play a whole scripted episode: five homesteaders and four raiders, the exact
 *  certification seat mix. */
function playFullGame(seed: number): GameState {
  let s = newGame(seed, "open");
  while (s.settled === null) {
    const submissions: Record<number, Submission> = {};
    for (const seat of s.cogOrder) {
      if (s.cogs[seat]!.life === "eliminated") continue;
      const view = observe(s, seat);
      submissions[seat] = seat >= 5 ? raider(view) : homesteader(view);
    }
    s = stepTurn(s, submissions);
  }
  return s;
}

describe("a full episode", () => {
  it("is byte-identical across two runs for one seed and ends `complete`", () => {
    const a = playFullGame(7);
    const b = playFullGame(7);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(endReason(a)).toBe("complete");
    expect(a.turnsPlayed).toBe(MAX_TURNS);
    expect(a.turn).toBe(MAX_TURNS + 1);
    expect(isFinished(a)).toBe(true);
    expect(scoreGame(a)).toHaveLength(SEATS);
    // Somebody earned something on a real board.
    expect(scoreGame(a).reduce((x, y) => x + y, 0)).toBeGreaterThan(0);
    // The endcard is emitted exactly once, at the end.
    const endcards = a.log.flatMap((r) => r.events.filter((e) => e.kind === "endcard"));
    expect(endcards).toHaveLength(1);
    expect(endcards[0]).toMatchObject({ reason: "complete", turnsPlayed: MAX_TURNS });
  });

  it("a different seed deals a different game", () => {
    expect(JSON.stringify(playFullGame(7))).not.toBe(JSON.stringify(playFullGame(8)));
  });

  it("the board only ever gets poorer: poolEnd <= poolStart", () => {
    const a = playFullGame(7);
    const card = a.log.flatMap((r) => r.events.filter((e) => e.kind === "endcard"))[0]!;
    if (card.kind !== "endcard") throw new Error("no endcard");
    expect(card.poolEnd).toBeLessThanOrEqual(card.poolStart);
    expect(card.poolStart).toBe(a.poolStart);
  });

  it("ends `elimination` the moment at most one seat is left", () => {
    // Eliminate eight seats directly: the machine has been exercised turn by turn
    // in life.test.ts; here the END CONDITION is the subject.
    const base = newGame(7);
    const nearlyDead: GameState = {
      ...base,
      cogs: base.cogs.map((c) => (c.seat === 0 ? c : { ...c, life: "staggered" as const, struckThisTurn: true })),
    };
    const next = stepTurn(nearlyDead, {});
    expect(next.cogs.filter((c) => c.life === "eliminated")).toHaveLength(8);
    expect(endReason(next)).toBe("elimination");
    expect(next.turnsPlayed).toBe(1);
    // That turn's Upkeep completed before the episode ended.
    expect(next.log[0]!.events.some((e) => e.kind === "income")).toBe(true);
    expect(next.log[0]!.events.find((e) => e.kind === "endcard")).toMatchObject({ reason: "elimination" });
  });

  it("settles `deadline` mid-game WITH artifacts written", () => {
    let s = newGame(7);
    for (let t = 0; t < 6; t++) s = stepTurn(s, {});
    expect(s.settled).toBeNull();

    // The host's guard trips: settle now, score as-is, record how far it got.
    const settled = settleEarly(s, "deadline");
    expect(endReason(settled)).toBe("deadline");
    expect(isFinished(settled)).toBe(true);
    expect(settled.turnsPlayed).toBe(6);
    expect(settled.log[settled.log.length - 1]!.events.find((e) => e.kind === "endcard")).toMatchObject({
      reason: "deadline",
      turnsPlayed: 6,
    });
    // The results artifact — what `COGAME_RESULTS_URI` receives — validates.
    const results = buildResults(scoreGame(settled), settled);
    expect(results.reason).toBe("deadline");
    expect(results.scores).toHaveLength(SEATS);
    expect(results.turnsPlayed).toBe(6);
    // Settling twice is a no-op, so a double trip cannot corrupt the artifact.
    expect(settleEarly(settled, "complete")).toBe(settled);
  });

  it("a razed seat can still be found in razeReach — the counter is real", () => {
    // The besieged seat's counter is to raze the attacker's nearest foothold; this
    // pins that razeReach is non-empty from turn 4, so the counter always exists.
    let s = newGame(7);
    for (let t = 0; t < 4; t++) s = stepTurn(s, {});
    expect(s.turn).toBeGreaterThanOrEqual(4);
    for (const seat of s.cogOrder) {
      expect(legalRazeTargets(s, seat).length).toBeGreaterThan(0);
      expect(homeRing(seat)).toHaveLength(7);
    }
  });
});
