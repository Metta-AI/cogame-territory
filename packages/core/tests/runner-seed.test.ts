// A new game must get a NEW board. The runner deals via `newGame({ seed })`; when
// the host pins no seed (the live hub — no game descriptor sets one) every game
// must still get a fresh board, and a reset ("deal a fresh game") must re-deal a
// DIFFERENT one. A pinned seed (coworld league / deterministic eval) stays exact.
import { describe, it, expect } from "vitest";

import { GameRunner } from "../src/runner.js";
import type { Game, GameModule } from "../src/game.js";

// Minimal fake engine: the only state is the seed it was dealt, so a test can read
// back exactly which seed each game ran on.
const seedGame: Game<{ seed: string }, never> = {
  id: "seed-probe",
  minPlayers: 0,
  maxPlayers: 4,
  newGame: ({ seed }) => ({ seed }),
  turnOf: () => 0,
  pendingActors: () => [],
  decisionSchema: () => {
    throw new Error("unused");
  },
  applyDecision: (state) => ({ state }),
  isFinished: () => true,
  score: () => ({}),
  redact: (state) => state,
  baselineDecision: () => {
    throw new Error("unused");
  },
};
const gameModule: GameModule<{ seed: string }, never> = { game: seedGame };

const seedOf = (r: GameRunner<{ seed: string }, never>): string => r.state.seed;

describe("GameRunner seed", () => {
  it("deals a fresh board for each game when no seed is pinned", () => {
    const seeds = new Set(Array.from({ length: 8 }, () => seedOf(new GameRunner(gameModule, new Map()))));
    // The live hub pins no seed; the buggy default dealt every game on the constant
    // "0", collapsing all 8 onto one board. Distinct seeds prove per-game variety.
    expect(seeds.size).toBeGreaterThan(1);
  });

  it("re-deals a different board on reset when no seed is pinned", () => {
    const r = new GameRunner(gameModule, new Map());
    const first = seedOf(r);
    r.reset();
    expect(seedOf(r)).not.toBe(first);
  });

  it("honors a pinned seed at construction and across reset", () => {
    const r = new GameRunner(gameModule, new Map(), { seed: "42" });
    expect(seedOf(r)).toBe("42");
    r.reset();
    expect(seedOf(r)).toBe("42");
  });

  it("mints a high-entropy (128-bit) seed when unpinned, not a 32-bit value", () => {
    // A game can derive hidden per-seat info from the seed (e.g. agricogla's dealt
    // hands). A 32-bit `Math.random()` seed was brute-forceable; the unpinned seed
    // must now be 128 bits of CSPRNG entropy so the deal can't be enumerated.
    const seed = seedOf(new GameRunner(gameModule, new Map()));
    expect(seed).toMatch(/^[0-9a-f]{32}$/);
  });
});
