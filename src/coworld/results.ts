// The episode results artifact, matching `src/game/coworld.ts`'s `results_schema`
// (the manifest contract). `writeResults` (from @cogweb/coworld) validates against
// this zod schema before writing it to `COGAME_RESULTS_URI`.
//
// `scores` is gross paint EARNED per seat, in SEAT ORDER, and the league ranks by
// exactly that number. `reason` has exactly three legal values. Everything else is
// the deadweight-loss read-out phase 60 reports.
import { z } from "zod";
import { SEATS } from "../shared/engine/constants.js";
import type { GameState } from "../shared/engine/types.js";
import { incomePool } from "../shared/engine/board.js";
import {
  eliminatedSeats,
  fallbacksBySeat,
  razesBySeat,
  scoreGame,
} from "../shared/engine/game.js";

export const territoryResultsSchema = z
  .object({
    scores: z.array(z.number()).length(SEATS),
    reason: z.enum(["complete", "elimination", "deadline"]),
    turnsPlayed: z.number().int().nonnegative(),
    fallbacks: z.array(z.number().int()).length(SEATS),
    eliminated: z.array(z.number().int()).max(SEATS),
    razes: z.array(z.number().int()).length(SEATS),
    destroyed: z.number().int().nonnegative(),
    poolStart: z.number(),
    poolEnd: z.number(),
    replayUri: z.string().optional(),
  })
  .strict();

export type TerritoryResults = z.infer<typeof territoryResultsSchema>;

/** Assemble the results artifact from the final engine state. A host crash writes
 *  nothing; every settle — including `deadline` — writes this. */
export function buildResults(scores: number[], engine: GameState): TerritoryResults {
  return territoryResultsSchema.parse({
    scores: scores.length === SEATS ? scores : scoreGame(engine),
    reason: engine.settled ?? "deadline",
    turnsPlayed: engine.turnsPlayed,
    fallbacks: fallbacksBySeat(engine),
    eliminated: eliminatedSeats(engine),
    razes: razesBySeat(engine),
    destroyed: engine.destroyed,
    poolStart: engine.poolStart,
    poolEnd: incomePool(engine.tiles),
  });
}
