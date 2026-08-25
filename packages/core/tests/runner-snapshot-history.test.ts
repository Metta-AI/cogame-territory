// The runner retains a per-turn snapshot timeline so the websocket can backfill it
// on connect. Without it a viewer who joins (or reloads) mid-game only receives the
// current snapshot — so the scrubber (gated on snapshots.length > 1) stays hidden
// until another turn streams in live, and can never scrub to turns before connect.

import { describe, it, expect } from "vitest";
import { z } from "zod";

import { GameRunner } from "../src/runner.js";
import type { SeatPilot } from "../src/runner.js";
import { ScriptedPilot } from "../src/scripted-pilot.js";
import type { Game, GameModule } from "../src/game.js";

type S = { turn: number; secret: number };
type D = { go: true };

// A minimal game that advances one turn per decision for 3 turns. `secret` is shown
// only to a seat (hidden in the public view) so the test can prove per-seat redaction
// runs over the WHOLE history, not just the current snapshot.
const countGame: Game<S, D> = {
  id: "count",
  minPlayers: 1,
  maxPlayers: 1,
  newGame: () => ({ turn: 0, secret: 7 }),
  turnOf: (s) => s.turn,
  pendingActors: (s) => (s.turn < 3 ? [0] : []),
  decisionSchema: () => z.object({ go: z.literal(true) }),
  applyDecision: (s) => ({ state: { turn: s.turn + 1, secret: s.secret } }),
  isFinished: (s) => s.turn >= 3,
  score: () => ({}),
  redact: (s, seat) => (seat === null ? { ...s, secret: 0 } : s),
  baselineDecision: () => ({ go: true }),
};
const gameModule: GameModule<S, D> = { game: countGame };

const seat = (): SeatPilot<S, D> => ({ pilot: new ScriptedPilot(), guidance: "", model: null, name: "" });

describe("GameRunner snapshot history", () => {
  it("records one snapshot per turn, in turn order, for connect-time backfill", async () => {
    const r = new GameRunner(gameModule, new Map([[0, seat()]]));
    await r.start();
    const history = r.snapshotHistory();
    // Turns 0 (start) → 1 → 2 → 3 (finished): four entries, ascending.
    expect(history.map((s) => s.turn)).toEqual([0, 1, 2, 3]);
  });

  it("redacts the whole history to the requested seat", async () => {
    const r = new GameRunner(gameModule, new Map([[0, seat()]]));
    await r.start();
    // Public view hides `secret` on every turn; the seat sees it on every turn.
    expect(r.snapshotHistory(null).every((s) => (s.state as S).secret === 0)).toBe(true);
    expect(r.snapshotHistory(0).every((s) => (s.state as S).secret === 7)).toBe(true);
  });

  it("clears the history on reset so a fresh game starts a fresh timeline", async () => {
    const r = new GameRunner(gameModule, new Map([[0, seat()]]));
    await r.start();
    expect(r.snapshotHistory().length).toBe(4);
    r.reset();
    // Reset deals a fresh game and emits its first snapshot: timeline is just turn 0.
    expect(r.snapshotHistory().map((s) => s.turn)).toEqual([0]);
    expect(r.snapshotHistory()[0]!.generation).toBe(1);
  });
});
