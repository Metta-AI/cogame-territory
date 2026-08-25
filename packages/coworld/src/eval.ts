// A pure, headless policy-evaluation harness. Given a GameModule and per-seat
// Pilot factories it runs full games through the real GameRunner (no sockets, no
// listeners, no LLM/network — depends only on @cogweb/core) and tallies scores
// and wins. Use it for deterministic local evals: optimize a policy or autopilot
// prompt, then compare before/after over a fixed seed set.

import { GameRunner } from "@cogweb/core";
import type { GameModule, Pilot, SeatPilot } from "@cogweb/core";

/** Build the pilot for one seat. Called once per seat per game. */
export type PilotFactory<State, Decision> = (seat: number) => Pilot<State, Decision>;

export interface MatchupResult {
  games: number;
  scoreBySeat: Record<number, number>;
  winsBySeat: Record<number, number>;
}

export interface CompareResult {
  a: string;
  b: string;
  games: number;
  winsA: number;
  winsB: number;
  draws: number;
  winRateA: number;
  winRateB: number;
}

/** The seats a game fills: every game uses maxPlayers seats, 0..maxPlayers-1. */
function seatsOf<State, Decision>(module: GameModule<State, Decision>): number[] {
  const seats: number[] = [];
  for (let seat = 0; seat < module.game.maxPlayers; seat++) seats.push(seat);
  return seats;
}

/** Run one full headless game with the given per-seat pilots; return final scores. */
async function playOne<State, Decision>(
  module: GameModule<State, Decision>,
  seats: number[],
  pilotFor: (seat: number) => Pilot<State, Decision>,
  seed: string,
  maxTimeMs: number | undefined,
): Promise<Record<number, number>> {
  const pilots = new Map<number, SeatPilot<State, Decision>>();
  for (const seat of seats) {
    pilots.set(seat, { pilot: pilotFor(seat), guidance: "", model: null, name: "" });
  }
  // Headless self-play is all bots and must terminate: auto-advance is always on,
  // capping a stalled pilot at `maxTimeMs` (default 30s) with a baseline move.
  const runner = new GameRunner(module, pilots, {
    seed,
    stepDelayMs: 0,
    autoAdvance: { enabled: true, maxTimeMs: maxTimeMs ?? 30_000 },
    // Deterministic self-play: any free-form timed phase (Game.openPhase) collapses
    // to an instant — its wall-clock would break reproducibility.
    openPhaseTimeoutMs: 0,
  });
  await runner.start();
  return module.game.score(runner.state);
}

/** Seats that achieved the maximum score in a finished game (ties => multiple). */
function winningSeats(scores: Record<number, number>): number[] {
  const entries = Object.entries(scores).map(([seat, value]) => [Number(seat), value] as const);
  const max = Math.max(...entries.map(([, value]) => value));
  return entries.filter(([, value]) => value === max).map(([seat]) => seat);
}

/**
 * Run `pilots` over every seed and accumulate per-seat score totals and win
 * counts. Each seat is filled by `pilots(seat)`; the same factory drives every
 * seat, so this measures one policy against itself across seeds (useful for a
 * self-play baseline or sanity check).
 */
export async function runMatchup<State, Decision>(
  module: GameModule<State, Decision>,
  pilots: PilotFactory<State, Decision>,
  opts: { seeds: string[]; maxTimeMs?: number },
): Promise<MatchupResult> {
  const seats = seatsOf(module);
  const scoreBySeat: Record<number, number> = {};
  const winsBySeat: Record<number, number> = {};
  for (const seat of seats) {
    scoreBySeat[seat] = 0;
    winsBySeat[seat] = 0;
  }

  for (const seed of opts.seeds) {
    const scores = await playOne(module, seats, pilots, seed, opts.maxTimeMs);
    for (const seat of seats) scoreBySeat[seat] = (scoreBySeat[seat] ?? 0) + (scores[seat] ?? 0);
    for (const seat of winningSeats(scores)) winsBySeat[seat] = (winsBySeat[seat] ?? 0) + 1;
  }

  return { games: opts.seeds.length, scoreBySeat, winsBySeat };
}

/**
 * Compare two policies head to head over a seed set. To cancel first-mover
 * advantage each seed is played TWICE with the seat assignment swapped: once
 * with A on even seats (B on odd), once with A on odd seats (B on even). A game's
 * win is attributed to whichever policy occupied each winning seat. Written to
 * handle maxPlayers by alternating factory-by-seat-parity.
 */
export async function comparePolicies<State, Decision>(
  module: GameModule<State, Decision>,
  a: { name: string; pilot: PilotFactory<State, Decision> },
  b: { name: string; pilot: PilotFactory<State, Decision> },
  opts: { seeds: string[] },
): Promise<CompareResult> {
  const seats = seatsOf(module);
  let winsA = 0;
  let winsB = 0;
  let draws = 0;

  // assignment maps a seat to the policy that occupies it for one game.
  const play = async (seed: string, aOnEven: boolean): Promise<void> => {
    const isPolicyA = (seat: number): boolean => (seat % 2 === 0) === aOnEven;
    const pilotFor = (seat: number): Pilot<State, Decision> =>
      isPolicyA(seat) ? a.pilot(seat) : b.pilot(seat);
    const scores = await playOne(module, seats, pilotFor, seed, undefined);
    const winners = winningSeats(scores);
    const aWon = winners.some((seat) => isPolicyA(seat));
    const bWon = winners.some((seat) => !isPolicyA(seat));
    // A clean win is exactly one policy holding all winning seats; anything else
    // (a tie split across both policies) is a draw.
    if (aWon && !bWon) winsA += 1;
    else if (bWon && !aWon) winsB += 1;
    else draws += 1;
  };

  for (const seed of opts.seeds) {
    await play(seed, true);
    await play(seed, false);
  }

  const games = opts.seeds.length * 2;
  return {
    a: a.name,
    b: b.name,
    games,
    winsA,
    winsB,
    draws,
    winRateA: games === 0 ? 0 : winsA / games,
    winRateB: games === 0 ? 0 : winsB / games,
  };
}
