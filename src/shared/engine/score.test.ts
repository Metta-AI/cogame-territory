// TEST 6 — scoring, sign, and what the league ranks by.
//
// `score = Σ income + Σ salvage`, monotone non-decreasing, HIGHER IS BETTER, in
// SEAT ORDER; the displayed tie-break is score -> fewer razes -> lower seat index.
import { describe, it, expect } from "vitest";

import { newGame, rankSeats, razesBySeat, scoreGame, stepTurn } from "./game";
import type { GameState } from "./types";
import type { Submission } from "./orders";
import { legalClaimTargets } from "./orders";
import { SEATS } from "./constants";

describe("scoreGame", () => {
  it("is seat-ordered and nine long", () => {
    const s = newGame(7);
    const scores = scoreGame(s);
    expect(scores).toHaveLength(SEATS);
    expect(scores.every((v) => v === 0)).toBe(true);
    // Seat order, not rank order: index i IS seat i.
    const seeded: GameState = { ...s, cogs: s.cogs.map((c) => ({ ...c, banked: c.seat * 10 })) };
    expect(scoreGame(seeded)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it("is monotone non-decreasing across a whole game — spending never lowers it", () => {
    let s = newGame(21);
    let prev = scoreGame(s);
    for (let t = 0; t < 18 && s.settled === null; t++) {
      const submissions: Record<number, Submission> = {};
      for (const seat of s.cogOrder) {
        const reach = legalClaimTargets(s, seat);
        const pick = reach[t % Math.max(1, reach.length)];
        submissions[seat] = { orders: pick ? [{ type: "claim", tile: pick }] : [], messages: [] };
      }
      s = stepTurn(s, submissions);
      const now = scoreGame(s);
      for (let i = 0; i < SEATS; i++) expect(now[i]!).toBeGreaterThanOrEqual(prev[i]!);
      prev = now;
    }
    // Somebody actually earned something, or the test proves nothing.
    expect(prev.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("equals Σ income + Σ salvage exactly", () => {
    let s = newGame(5);
    for (let t = 0; t < 8 && s.settled === null; t++) {
      const submissions: Record<number, Submission> = {};
      for (const seat of s.cogOrder) {
        const reach = legalClaimTargets(s, seat);
        const pick = reach[(t + seat) % Math.max(1, reach.length)];
        submissions[seat] = { orders: pick ? [{ type: "claim", tile: pick }] : [], messages: [] };
      }
      s = stepTurn(s, submissions);
    }
    const earned = s.cogOrder.map(() => 0);
    for (const rec of s.log) {
      for (const ev of rec.events) {
        if (ev.kind === "income") earned[ev.seat] = (earned[ev.seat] ?? 0) + ev.paint;
        if (ev.kind === "salvage") earned[ev.seat] = (earned[ev.seat] ?? 0) + ev.paint;
      }
    }
    expect(scoreGame(s)).toEqual(earned);
  });

  it("breaks the DISPLAYED tie by fewer razes, then lower seat index", () => {
    const base = newGame(7);
    const s: GameState = {
      ...base,
      cogs: base.cogs.map((c) => ({
        ...c,
        banked: c.seat <= 2 ? 50 : 10,
        razesMade: c.seat === 0 ? 4 : c.seat === 1 ? 1 : 1,
      })),
    };
    // Seats 1 and 2 tie on score AND razes -> lower seat first; seat 0 razed more.
    expect(rankSeats(s).slice(0, 3)).toEqual([1, 2, 0]);
    expect(razesBySeat(s)).toHaveLength(SEATS);
  });
});
