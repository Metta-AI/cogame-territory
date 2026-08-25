// The agent-facing order vocabulary — a zod-validated `Order` discriminated
// union parsed at the reply boundary so untrusted LLM/player input is rejected
// before it reaches Resolve — plus the board-rule legality predicates Resolve
// uses and the two EXPORTED set builders the observation ships as `reach` /
// `razeReach`.
//
// The set builders are the escrow-0.1.3 precomputed-choice-set guarantee: they
// are computed by the SAME predicate the validator applies, so the model never
// has to derive the legal set and a formal-output fallback storm cannot happen.
// orders.test.ts asserts the sets equal exactly what the validator accepts over
// 200 seeded states.

import { z } from "zod";
import { distance, key } from "./hex";
import type { GameState, HexKey } from "./types";
import {
  CLAIM_COST,
  FLING_RANGE,
  HEARTHS,
  MAX_LINES,
  MAX_NOTE_LEN,
  MAX_ORDERS_PER_TURN,
  MAX_SAY_LEN,
  RAZE_COST,
  RAZE_HOME_COST,
  RAZE_OPEN_TURN,
  TRANSFER_FEE,
} from "./constants";

/** A tile address, `"q,r"` with one or two digits per axis. */
export const TileKey = z.string().regex(/^-?\d{1,2},-?\d{1,2}$/, "tile must look like \"3,-2\"");

/** Paint a wall you can reach. */
const ClaimOrder = z.object({ type: z.literal("claim"), tile: TileKey });
/** Strip a claim and halve a wall's yield forever; twice makes it rubble. */
const RazeOrder = z.object({ type: z.literal("raze"), tile: TileKey });
/** Move paint to another living seat, by ALIAS. Lands as their next-turn money. */
const TransferOrder = z.object({
  type: z.literal("transfer"),
  to: z.string().min(1),
  amount: z.number().int().positive(),
});

export const OrderSchema = z.discriminatedUnion("type", [ClaimOrder, RazeOrder, TransferOrder]);
export type Order = z.infer<typeof OrderSchema>;

/** One outbound cheap-talk line. `to` null (or an unknown/self alias) is public. */
export const TalkLineSchema = z.object({
  to: z.string().nullable().default(null),
  text: z.string(),
});
export type TalkLineIn = z.input<typeof TalkLineSchema>;

/**
 * The whole reply contract — the `submit_turn` tool input, and the `decision` a
 * scripted player sends. Caps are enforced on the way in: entries past
 * `MAX_LINES` are DROPPED (not rejected); `text` and `note` are TRUNCATED on
 * rune boundaries. Anything else that violates the schema bounces the whole set.
 */
export const SubmissionSchema = z.object({
  orders: z.array(OrderSchema).max(MAX_ORDERS_PER_TURN).default([]),
  messages: z.array(TalkLineSchema).default([]),
  note: z.string().optional(),
  /** Set by a player (or the host baseline) that could not think this turn. */
  fallback: z.boolean().optional(),
});
export type Submission = z.infer<typeof SubmissionSchema>;

/** The reply caps, re-exported for the prompt and the tool schema. */
export const REPLY_CAPS = { orders: MAX_ORDERS_PER_TURN, messages: MAX_LINES, text: MAX_SAY_LEN, note: MAX_NOTE_LEN };

// ── spatial predicates ────────────────────────────────────────────────────────

/** The tiles `seat` currently owns. Rubble is never owned (a raze clears the
 *  owner), so it never conducts adjacency. */
export const ownedKeys = (state: GameState, seat: number): HexKey[] =>
  Object.entries(state.tiles)
    .filter(([, t]) => t.owner === seat)
    .map(([k]) => k);

/**
 * Hex distance from `tile` to the seat's nearest OWNED tile, or — when it owns
 * nothing at all — from its hearth (the projection origin of last resort).
 * Infinity when the tile is off-board.
 */
export function claimDistance(state: GameState, seat: number, tile: HexKey): number {
  const target = state.tiles[tile];
  if (!target) return Infinity;
  const owned = ownedKeys(state, seat);
  if (owned.length === 0) return distance(target.hex, HEARTHS[seat]!);
  let best = Infinity;
  for (const k of owned) best = Math.min(best, distance(target.hex, state.tiles[k]!.hex));
  return best;
}

/** True iff `seat` may claim `tile` right now (spatial + tile-state legality). */
export function isLegalClaim(state: GameState, seat: number, tile: HexKey): boolean {
  const t = state.tiles[tile];
  if (!t) return false;
  if (t.state === "rubble") return false;
  if (t.owner !== null) return false;
  return claimDistance(state, seat, tile) <= FLING_RANGE;
}

/** True iff `seat` may raze `tile` right now. Razes are illegal in turns 1–3. */
export function isLegalRaze(state: GameState, seat: number, tile: HexKey): boolean {
  if (state.turn < RAZE_OPEN_TURN) return false;
  const t = state.tiles[tile];
  if (!t) return false;
  if (t.state === "rubble") return false;
  return claimDistance(state, seat, tile) <= FLING_RANGE;
}

/** `RAZE_HOME_COST` iff the target is within distance 1 of ANOTHER LIVING seat's
 *  hearth, else `RAZE_COST`. Razing near your own hearth is never surcharged. */
export function razeCost(state: GameState, seat: number, tile: HexKey): number {
  const t = state.tiles[tile];
  if (!t) return RAZE_COST;
  for (const cog of state.cogs) {
    if (cog.seat === seat || cog.life === "eliminated") continue;
    if (distance(t.hex, cog.hearth) <= 1) return RAZE_HOME_COST;
  }
  return RAZE_COST;
}

/** The paint a single order costs, charged win or lose. */
export function orderCost(state: GameState, seat: number, order: Order): number {
  if (order.type === "claim") return CLAIM_COST(claimDistance(state, seat, order.tile));
  if (order.type === "raze") return razeCost(state, seat, order.tile);
  return order.amount + TRANSFER_FEE;
}

/** Every tile `seat` may claim this turn, lexicographically ordered. Shipped in
 *  the observation as `reach`. */
export const legalClaimTargets = (state: GameState, seat: number): HexKey[] =>
  Object.keys(state.tiles)
    .filter((k) => isLegalClaim(state, seat, k))
    .sort();

/** Every tile `seat` may raze this turn, lexicographically ordered. Shipped in
 *  the observation as `razeReach`. Empty before `RAZE_OPEN_TURN`. */
export const legalRazeTargets = (state: GameState, seat: number): HexKey[] =>
  Object.keys(state.tiles)
    .filter((k) => isLegalRaze(state, seat, k))
    .sort();

/** Resolve an alias to its seat index, or null. Case-insensitive, trimmed. */
export function seatOfAlias(state: GameState, alias: string): number | null {
  const want = alias.trim().toLowerCase();
  const hit = state.cogs.find((c) => c.alias.toLowerCase() === want);
  return hit ? hit.seat : null;
}

/** The key of a hex, re-exported so callers need not import hex.ts too. */
export { key as tileKeyOf };
