// The coworld player wire protocol (`cogweb.player.v1`). The game runnable runs
// a `/player` websocket SERVER, one socket per slot, token-authenticated. An
// external player policy is a websocket CLIENT that drives one slot.
//
// Flow (mirrors the cogsul/cogherence coworlds):
//   game → player  welcome      once on connect: slot identity + public config
//   game → player  observation  per turn: the seat's REDACTED view, correlated
//   player → game  reply        the decision for that observation, by id
//   game → player  reject       a reply failed validation; re-decide with reason
//   game → player  final        the episode ended with per-slot scores
//
// State/decision/view ride as opaque JSON; each game validates at its boundary.
//
// Cheap talk rides alongside: each `observation` carries the seat's visible inbox
// (`messages`), and each `reply` may post 0+ outbound lines (`messages`). The host
// routes them through a per-episode message bus — the engine never reads them, so a
// policy that ignores talk is unaffected (it just sends/receives an empty list).
import { z } from "zod";
import { Audience } from "@cogweb/protocol";

export const PROTOCOL = "cogweb.player.v1";

/** One line in a seat's visible inbox (public chatter + DMs to/from it). Mirrors
 *  @cogweb/core's `ObservedMessage`; the host fills it from the episode bus. */
export const InboxMessage = z.object({
  from: z.number().int(),
  to: Audience,
  text: z.string(),
  turn: z.number().int(),
});
export type InboxMessage = z.infer<typeof InboxMessage>;

/** One outbound cheap-talk line a player posts with a reply: a public broadcast
 *  (`to` null/absent) or a private aside to one seat. */
export const TalkLine = z.object({
  to: z.number().int().nullable().default(null),
  text: z.string(),
});
export type TalkLine = z.infer<typeof TalkLine>;

// ── game → player ─────────────────────────────────────────────────────────────

export const WelcomeMessage = z.object({
  type: z.literal("welcome"),
  protocol: z.literal(PROTOCOL),
  slot: z.number().int(),
  /** Public (non-secret) episode config the player may use to set up. */
  config: z.unknown(),
});
export type WelcomeMessage = z.infer<typeof WelcomeMessage>;

export const ObservationMessage = z.object({
  type: z.literal("observation"),
  /** Correlation id; the reply must echo it. */
  id: z.number().int(),
  seat: z.number().int(),
  turn: z.number().int(),
  /** The seat's redacted view (game.redact(state, seat)). */
  view: z.unknown(),
  /** The seat's visible inbox (public chatter + DMs to/from it), oldest first. */
  messages: z.array(InboxMessage).default([]),
  /** Set on a re-request: why the previous reply was rejected. */
  reason: z.string().nullable().default(null),
  /** Chess clock: this policy's REMAINING total wall-clock thinking budget for the
   *  whole episode, in ms. The host decrements it by the time each turn takes; when
   *  it reaches 0 the host stops asking and plays random legal moves for the seat.
   *  `null` when no chess clock is configured (the seat has an unbounded budget). */
  timeLeftMs: z.number().nullable().default(null),
});
export type ObservationMessage = z.infer<typeof ObservationMessage>;

export const FinalMessage = z.object({
  type: z.literal("final"),
  /** Per-slot scores in slot order. */
  scores: z.array(z.number()),
});
export type FinalMessage = z.infer<typeof FinalMessage>;

export const GameToPlayer = z.discriminatedUnion("type", [
  WelcomeMessage,
  ObservationMessage,
  FinalMessage,
]);
export type GameToPlayer = z.infer<typeof GameToPlayer>;

// ── player → game ─────────────────────────────────────────────────────────────

export const ReplyMessage = z.object({
  type: z.literal("reply"),
  /** Echoes the observation id this answers. */
  id: z.number().int(),
  /** The game-specific decision payload (validated by the game's schema). */
  decision: z.unknown(),
  /** 0+ cheap-talk lines to post alongside this reply (the host routes them to the
   *  episode bus). Empty for a policy that doesn't talk. */
  messages: z.array(TalkLine).default([]),
});
export type ReplyMessage = z.infer<typeof ReplyMessage>;

export const PlayerToGame = z.discriminatedUnion("type", [ReplyMessage]);
export type PlayerToGame = z.infer<typeof PlayerToGame>;

export function parseGameToPlayer(raw: unknown): GameToPlayer {
  return GameToPlayer.parse(raw);
}

export function parsePlayerToGame(raw: unknown): PlayerToGame {
  return PlayerToGame.parse(raw);
}
