// THE BASELINE GRID HARNESS. The scripted baselines have three free numbers
// between them (`homesteader.maxClaims`, `raider.maxClaims`, `raider.minYield`),
// and this is where they come from: a deterministic sweep of the grid over seeded
// nine-seat 18-turn episodes of the certification mix (five homesteaders, four
// raiders), scoring each candidate by the mean banked score of the seats that
// played it.
//
// Everything here is pure and seeded — the same sweep gives the same table on any
// machine, which is what lets `src/game/tune.test.ts` assert the shipped constants
// are the argmax and `scripts/sweep-baselines.ts` commit the table to
// `docs/baseline-sweep.md`.

import { newGame, scoreGame, stepTurn } from "../shared/engine/game.js";
import { MAX_TURNS, SEATS } from "../shared/engine/constants.js";
import type { Submission } from "../shared/engine/orders.js";
import { observe } from "./redact.js";
import {
  HOMESTEADER_PARAMS,
  RAIDER_PARAMS,
  homesteader,
  raider,
  type HomesteaderParams,
  type RaiderParams,
} from "./scripted.js";

// THE FIELD EACH CANDIDATE IS MEASURED AGAINST IS FIXED. Holding the opponent at
// the SHIPPED values would make the sweep chase its own tail — tune one policy,
// the other policy's table moves, and the "argmax" depends on which order you
// swept in. The reference field is the pre-tuning baseline (the design note's
// numbers), so every row of every table is comparable and the harness has a fixed
// point by construction.
export const REFERENCE_HOMESTEADER: HomesteaderParams = { maxClaims: 3 };
export const REFERENCE_RAIDER: RaiderParams = { maxClaims: 3, minYield: 2 };

/** The certification seat mix: seats 0-4 homestead, seats 5-8 raid. */
export const HOMESTEADER_SEATS = [0, 1, 2, 3, 4];
export const RAIDER_SEATS = [5, 6, 7, 8];

/** The seeds the committed table (and the CI assertion) sweep over. */
export const SWEEP_SEEDS = [1, 7, 13, 29, 101];

// The candidate grid — the whole meaningful range of each number, not a window
// chosen after the fact: claims are bounded by `MAX_ORDERS_PER_TURN = 8` and a
// tile's yield is 0..3, so this IS the space.
export const CLAIM_GRID = [1, 2, 3, 4, 5, 6, 7, 8];
export const MIN_YIELD_GRID = [1, 2, 3];

/** The selection band. Above `maxClaims = 3` the score curve is flat — the extra
 *  claims are rarely affordable — so the harness takes the SMALLEST parameters
 *  inside this band rather than the raw argmax: these are certification/filler
 *  policies, and a shorter order list is cheaper on the wire and in the prompt. */
export const TOLERANCE = 0.03;

/** One full scripted episode. Returns the banked score per seat, in seat order. */
export function playEpisode(seed: number, h: HomesteaderParams, r: RaiderParams, turns = MAX_TURNS): number[] {
  let state = newGame(seed, "open", turns);
  while (state.settled === null) {
    const submissions: Record<number, Submission> = {};
    for (const seat of state.cogOrder) {
      if (state.cogs[seat]!.life === "eliminated") continue;
      const view = observe(state, seat);
      submissions[seat] = HOMESTEADER_SEATS.includes(seat) ? homesteader(view, h) : raider(view, r);
    }
    state = stepTurn(state, submissions);
  }
  return scoreGame(state);
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Mean banked score of `seats` across `seeds`, for one point of the grid. */
export function scoreCandidate(
  seats: number[],
  seeds: number[],
  h: HomesteaderParams,
  r: RaiderParams,
): number {
  const perSeed = seeds.map((seed) => {
    const scores = playEpisode(seed, h, r);
    return mean(seats.map((s) => scores[s] ?? 0));
  });
  return mean(perSeed);
}

export interface SweepRow {
  /** The candidate's parameters, printed. */
  label: string;
  params: HomesteaderParams | RaiderParams;
  /** Mean banked score of the seats playing this candidate. */
  score: number;
  /** True for the shipped constants. */
  shipped: boolean;
}

const round = (x: number): number => Math.round(x * 100) / 100;

/**
 * Sweep `homesteader.maxClaims` with the raiders held at the shipped constants:
 * the five homesteading seats play the candidate, and the candidate is scored by
 * what those five bank.
 */
export function sweepHomesteader(seeds: number[] = SWEEP_SEEDS): SweepRow[] {
  return CLAIM_GRID.map((maxClaims) => ({
    label: `maxClaims=${maxClaims}`,
    params: { maxClaims },
    score: round(scoreCandidate(HOMESTEADER_SEATS, seeds, { maxClaims }, REFERENCE_RAIDER)),
    shipped: maxClaims === HOMESTEADER_PARAMS.maxClaims,
  }));
}

/** Sweep the raider's two numbers with the homesteaders held at the REFERENCE
 *  field, scored by what the four raiding seats bank. */
export function sweepRaider(seeds: number[] = SWEEP_SEEDS): SweepRow[] {
  const rows: SweepRow[] = [];
  for (const maxClaims of CLAIM_GRID) {
    for (const minYield of MIN_YIELD_GRID) {
      rows.push({
        label: `maxClaims=${maxClaims} minYield=${minYield}`,
        params: { maxClaims, minYield },
        score: round(scoreCandidate(RAIDER_SEATS, seeds, REFERENCE_HOMESTEADER, { maxClaims, minYield })),
        shipped: maxClaims === RAIDER_PARAMS.maxClaims && minYield === RAIDER_PARAMS.minYield,
      });
    }
  }
  return rows;
}

/** The best row of a sweep: highest score, ties broken by the smaller parameters
 *  (a cheaper policy wins a tie), then by label for total determinism. */
export function bestRow(rows: SweepRow[]): SweepRow {
  return [...rows].sort(
    (a, b) =>
      b.score - a.score ||
      a.params.maxClaims - b.params.maxClaims ||
      (("minYield" in a.params ? a.params.minYield : 0) - ("minYield" in b.params ? b.params.minYield : 0)) ||
      (a.label < b.label ? -1 : 1),
  )[0]!;
}

/**
 * The harness's CHOICE for a sweep: among the rows within `TOLERANCE` of the best,
 * the one with the fewest claims (then the highest score at that claim count, then
 * the label). This is the rule `docs/baseline-sweep.md` states and
 * `src/game/tune.test.ts` asserts the shipped constants satisfy.
 */
export function selectRow(rows: SweepRow[]): SweepRow {
  const floor = bestRow(rows).score * (1 - TOLERANCE);
  const band = rows.filter((r) => r.score >= floor);
  return [...band].sort(
    (a, b) =>
      a.params.maxClaims - b.params.maxClaims ||
      b.score - a.score ||
      (a.label < b.label ? -1 : 1),
  )[0]!;
}

/** Sanity constants for the harness itself. */
export const SWEEP_META = { seats: SEATS, turns: MAX_TURNS, seeds: SWEEP_SEEDS };
