// The replay envelope this game writes and the viewer reads. REPLAY BYTES ARE
// SELF-SUFFICIENT: the envelope carries everything the viewer needs, so the page
// contacts nothing but S3 for the `.replay` file.
//
//   { "protocol": "cogweb.replay.v1",
//     "players": [{seat, alias, policy, player}],   // REAL names — spectator-side only
//     "config":  {seats, turns, variant, seed, ticksPerTurn, razeOpensTurn,
//                 flingRange, salvageMult},
//     "results": {scores, reason, turnsPlayed, fallbacks, eliminated, razes,
//                 destroyed, poolStart, poolEnd},
//     "frames":  [lobby, snapshot(turn 1), …, event…, snapshot(turn 19)],
//     "usage":   {…bedrock totals…} }
//
// `ReplayArtifact` in @cogweb/protocol is `.passthrough()`, so players/config/
// results ride alongside `frames` without a schema change.
import { z } from "zod";
import { ServerMessage as CogwebMessage } from "@cogweb/protocol";

export const ReplayPlayer = z
  .object({
    seat: z.number().int(),
    /** The anonymous in-game alias — the ONLY name the agents ever saw. */
    alias: z.string(),
    /** The real policy name, from the host's one-shot roster frame. */
    policy: z.string(),
    /** The owning player identity, when the platform supplied one. */
    player: z.string().nullable().default(null),
  })
  .strict();
export type ReplayPlayer = z.infer<typeof ReplayPlayer>;

export const ReplayConfig = z
  .object({
    seats: z.number().int(),
    turns: z.number().int(),
    variant: z.enum(["open", "rooms", "inside_out"]),
    seed: z.number(),
    ticksPerTurn: z.number().int(),
    razeOpensTurn: z.number().int(),
    flingRange: z.number().int(),
    salvageMult: z.number().int(),
  })
  .strict();
export type ReplayConfig = z.infer<typeof ReplayConfig>;

export const TerritoryReplay = z
  .object({
    protocol: z.literal("cogweb.replay.v1"),
    players: z.array(ReplayPlayer),
    config: ReplayConfig,
    results: z.record(z.string(), z.unknown()),
    frames: z.array(CogwebMessage).min(1),
    usage: z.unknown().optional(),
  })
  .passthrough();
export type TerritoryReplay = z.infer<typeof TerritoryReplay>;

/** The shape `App` accepts when a replay is injected directly (tests/embeds). */
export interface Replay {
  players?: ReplayPlayer[];
  config?: ReplayConfig;
  results?: Record<string, unknown>;
  frames: z.infer<typeof CogwebMessage>[];
}
