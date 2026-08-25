// The turn loop, the end conditions, and scoring. `stepTurn` wires Resolve ->
// Upkeep -> Life -> Advance into one turn and appends a TurnRecord for the
// replay. Everything is pure and deterministic, so `(seed, variant,
// submissionsByTurn)` reproduces a game byte for byte — which is exactly what
// lets the same module be compiled into the viewer bundle by vite.

import type { EndReason, GameState, Variant } from "./types";
import type { TurnEvent, TurnRecord, UpkeepEvent } from "./log";
import type { Submission } from "./orders";
import { generateBoard, incomePool } from "./board";
import { resolve } from "./resolve";
import { upkeep } from "./upkeep";
import { living } from "./life";
import { MAX_TURNS } from "./constants";

/** A fresh game at turn 1. */
export function newGame(seed: number, variant: Variant = "open", turns: number = MAX_TURNS): GameState {
  return generateBoard(seed, variant, turns);
}

/** Gross paint EARNED per seat, in SEAT ORDER: `Σ income + Σ salvage`. Higher is
 *  better; monotone non-decreasing per seat; frozen on elimination. This is the
 *  number written to `results.scores[]` and the number the league ranks by. */
export const scoreGame = (state: GameState): number[] => state.cogOrder.map((s) => state.cogs[s]!.banked);

/** Owned wall count per seat, in seat order (the endcard's `walls`). */
export const wallsBySeat = (state: GameState): number[] => state.cogOrder.map((s) => state.cogs[s]!.wallsHeld);

/** Cumulative razes committed per seat, in seat order (`results.razes`). */
export const razesBySeat = (state: GameState): number[] => state.cogOrder.map((s) => state.cogs[s]!.razesMade);

/** Fallback count per seat, in seat order (`results.fallbacks`). */
export const fallbacksBySeat = (state: GameState): number[] => state.cogOrder.map((s) => state.cogs[s]!.fallbacks);

/** Eliminated seats, ascending (`results.eliminated`). */
export const eliminatedSeats = (state: GameState): number[] =>
  state.cogs.filter((c) => c.life === "eliminated").map((c) => c.seat);

/** Displayed winner tie-break (cosmetic; the ladder only sees the score):
 *  higher score -> FEWER razes committed -> lower seat index. */
export const rankSeats = (state: GameState): number[] =>
  [...state.cogOrder].sort(
    (a, b) =>
      state.cogs[b]!.banked - state.cogs[a]!.banked ||
      state.cogs[a]!.razesMade - state.cogs[b]!.razesMade ||
      a - b,
  );

/** The episode's end reason, or null while it is still running. */
export const endReason = (state: GameState): EndReason | null => state.settled;

export const isFinished = (state: GameState): boolean => state.settled !== null;

/** The endcard event — emitted once, so the final panel needs no derivation. */
export function endcardEvent(state: GameState, reason: EndReason): UpkeepEvent {
  return {
    kind: "endcard",
    reason,
    turnsPlayed: state.turnsPlayed,
    scores: scoreGame(state),
    walls: wallsBySeat(state),
    destroyed: state.destroyed,
    poolStart: state.poolStart,
    poolEnd: incomePool(state.tiles),
    warsStarted: state.wars.length,
  };
}

/**
 * Stop the episode early with `reason` (the host's wall-clock guard trips at
 * `EPISODE_DEADLINE_MS`). A settle is never an overrun: results and the replay
 * are always written, the scores are the banked totals at the last COMPLETED
 * turn, and `turnsPlayed` records how far it got.
 */
export function settleEarly(state: GameState, reason: EndReason): GameState {
  if (state.settled !== null) return state;
  const settled: GameState = { ...state, settled: reason };
  const record: TurnRecord = {
    turn: state.turn,
    events: [endcardEvent(settled, reason)],
    banked: scoreGame(settled),
  };
  return { ...settled, log: [...settled.log, record] };
}

/** Run one full turn: Resolve -> Upkeep -> Life -> Advance, appending a
 *  TurnRecord. Pure. */
export function stepTurn(state: GameState, submissions: Record<number, Submission>): GameState {
  if (state.settled !== null) return state;

  const r = resolve(state, submissions);
  const u = upkeep(r.state);
  const events: TurnEvent[] = [...r.events, ...u.events];

  // 9e. advance.
  let next: GameState = {
    ...u.state,
    phase: "commit",
    turn: state.turn + 1,
    turnsPlayed: state.turn,
  };

  // End conditions, in the note's order. `elimination` ends the episode
  // immediately, that turn's Upkeep having completed.
  let reason: EndReason | null = null;
  if (living(next).length <= 1) reason = "elimination";
  else if (next.turn > next.turns) reason = "complete";
  if (reason !== null) {
    next = { ...next, settled: reason };
    events.push(endcardEvent(next, reason));
  }

  const record: TurnRecord = { turn: state.turn, events, banked: scoreGame(next) };
  return { ...next, log: [...next.log, record] };
}

/** An always-legal hold for any seat, any turn. */
export const holdSubmission = (): Submission => ({ orders: [], messages: [] });
