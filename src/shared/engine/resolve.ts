// The Resolve phase — steps 2 through 8 of the design note's resolution order,
// executed in exactly that order:
//
//   2. validate + budget, per seat in seat order   (wholesale rejection)
//   3. talk                                        (public + DMs, capped)
//   4. raze                                        (one destruction step each)
//   5. strike bookkeeping                          (home-ring hits)
//   6. claim                                       (post-raze board, simultaneous)
//   7. transfer                                    (next-turn money)
//   8. charge                                      (actual spend, asserted)
//
// PURE: the input GameState is never mutated; a new state is returned.
//
// Two invariants drive the design, and both are restated as assertions:
//  - AFFORDABILITY MONOTONICITY — step 2 gates the worst-case spend against
//    STORED paint, so the step-8 charge can never underflow. It throws if it
//    ever does, rather than silently minting paint.
//  - NEXT-TURN MONEY — salvage and incoming transfers are added to `credit` and
//    only land in `paint` in Upkeep (9c), so they cannot fund this turn's spend.

import { homeRing } from "./board";
import type { GameState, HexKey, Tile, TileState } from "./types";
import type { ResolveEvent } from "./log";
import type { Order, Submission } from "./orders";
import {
  claimDistance,
  isLegalClaim,
  isLegalRaze,
  orderCost,
  seatOfAlias,
} from "./orders";
import {
  effYield,
  MAX_LINES,
  MAX_NOTE_LEN,
  MAX_ORDERS_PER_TURN,
  MAX_SAY_LEN,
  RAZE_OPEN_TURN,
  SALVAGE_MULT,
} from "./constants";
import { capText } from "./text";

/** One seat's validated, affordable intent, ready to apply in the locked order. */
interface Plan {
  razes: HexKey[];
  claims: HexKey[];
  transfers: Array<{ to: number; amount: number }>;
  /** Total paint this set costs; charged win or lose. */
  spend: number;
}

/** The next state in the irreversible destruction ladder. */
const razeStep = (s: TileState): TileState => (s === "wall" ? "cracked" : "rubble");

/** Why this seat's whole order set bounces, or null when it is legal + funded. */
export function rejectionReason(state: GameState, seat: number, orders: Order[]): string | null {
  const cog = state.cogs[seat];
  if (!cog) return `no seat ${seat}`;
  if (cog.life === "eliminated") return "eliminated seats do not act";
  if (orders.length > MAX_ORDERS_PER_TURN) {
    return `${orders.length} orders exceeds the cap of ${MAX_ORDERS_PER_TURN}`;
  }
  let spend = 0;
  for (const o of orders) {
    if (o.type === "claim") {
      if (!isLegalClaim(state, seat, o.tile)) {
        const t = state.tiles[o.tile];
        if (!t) return `claim ${o.tile}: no such tile`;
        if (t.state === "rubble") return `claim ${o.tile}: rubble is never claimable again`;
        if (t.owner !== null) return `claim ${o.tile}: already held`;
        return `claim ${o.tile}: out of fling range (distance ${claimDistance(state, seat, o.tile)})`;
      }
    } else if (o.type === "raze") {
      if (state.turn < RAZE_OPEN_TURN) return `raze ${o.tile}: razing opens on turn ${RAZE_OPEN_TURN}`;
      if (!isLegalRaze(state, seat, o.tile)) {
        const t = state.tiles[o.tile];
        if (!t) return `raze ${o.tile}: no such tile`;
        if (t.state === "rubble") return `raze ${o.tile}: already rubble`;
        return `raze ${o.tile}: out of fling range (distance ${claimDistance(state, seat, o.tile)})`;
      }
    } else {
      const to = seatOfAlias(state, o.to);
      if (to === null) return `transfer to ${o.to}: no such cog`;
      if (to === seat) return "transfer to yourself is not a move";
      if (state.cogs[to]!.life === "eliminated") return `transfer to ${o.to}: eliminated`;
    }
    spend += orderCost(state, seat, o);
  }
  if (spend > cog.paint) return `cannot afford this set (${spend} paint vs ${cog.paint} stored)`;
  return null;
}

/**
 * Execute one simultaneous Resolve phase. `submissions[seat]` is that seat's
 * whole reply; a missing entry is a hold. Returns a NEW state plus the events.
 */
export function resolve(
  state: GameState,
  submissions: Record<number, Submission>,
): { state: GameState; events: ResolveEvent[] } {
  const events: ResolveEvent[] = [];
  const tiles: Record<HexKey, Tile> = {};
  for (const [k, t] of Object.entries(state.tiles)) tiles[k] = { ...t };
  const cogs = state.cogs.map((c) => ({ ...c }));
  const credit = [...state.credit];
  const talk = [...state.talk];
  const wars = new Set(state.wars);
  let destroyed = state.destroyed;

  // ── 2. validate + budget, per seat in seat order ───────────────────────────
  const plans = new Map<number, Plan>();
  for (const seat of state.cogOrder) {
    const cog = cogs[seat]!;
    if (cog.life === "eliminated") continue;
    const orders = submissions[seat]?.orders ?? [];
    const reason = rejectionReason(state, seat, orders);
    if (reason !== null) {
      events.push({ kind: "rejected", seat, reason });
      continue; // the whole set is discarded — this seat holds
    }
    const plan: Plan = { razes: [], claims: [], transfers: [], spend: 0 };
    for (const o of orders) {
      const cost = orderCost(state, seat, o);
      plan.spend += cost;
      events.push({ kind: "order", seat, order: o, cost });
      if (o.type === "claim") plan.claims.push(o.tile);
      else if (o.type === "raze") plan.razes.push(o.tile);
      else plan.transfers.push({ to: seatOfAlias(state, o.to)!, amount: o.amount });
    }
    plans.set(seat, plan);
  }

  // ── 3. talk ────────────────────────────────────────────────────────────────
  // Cheap talk is not tied to move legality, so it lands even for a seat whose
  // orders bounced. Entries past MAX_LINES are DROPPED; `text` is TRUNCATED on
  // rune boundaries; an unknown/self/absent recipient is treated as PUBLIC.
  for (const seat of state.cogOrder) {
    const cog = cogs[seat]!;
    if (cog.life === "eliminated") continue;
    const lines = submissions[seat]?.messages ?? [];
    for (const line of lines.slice(0, MAX_LINES)) {
      const text = capText(String(line.text ?? "").trim(), MAX_SAY_LEN);
      if (!text) continue;
      const named = line.to === null || line.to === undefined ? null : seatOfAlias(state, line.to);
      const to = named === null || named === seat || cogs[named]!.life === "eliminated" ? null : named;
      talk.push({ turn: state.turn, from: seat, to, text });
      events.push({ kind: "talk", seat, to, text });
    }
  }

  // ── 4. raze, ordered by (seat index, order index) ──────────────────────────
  // Each raze applies ONE destruction step. Two razes on the same tile in the
  // same turn destroy it outright; a third does nothing (the paint is still
  // spent). `ownerAtStart` is captured BEFORE any raze lands, because step 5
  // asks who owned the tile at the start of Resolve.
  const ownerAtStart = new Map<HexKey, number | null>();
  for (const [k, t] of Object.entries(state.tiles)) ownerAtStart.set(k, t.owner);

  const strikesOn = new Map<number, Set<number>>();
  for (const seat of state.cogOrder) {
    const plan = plans.get(seat);
    if (!plan) continue;
    cogs[seat]!.razesMade += plan.razes.length;
    for (const k of plan.razes) {
      const t = tiles[k]!;
      if (t.state === "rubble") continue; // already gone; the paint is still spent
      const victim = ownerAtStart.get(k) ?? null;
      const from_state = t.state;
      const to_state = razeStep(from_state);
      const yield_before = effYield(t);
      t.state = to_state;
      t.owner = null;
      t.wet = false;
      t.claimedTurn = -1;
      if (to_state === "rubble") destroyed += 1;
      events.push({
        kind: "raze",
        seat,
        tile: k,
        from_state,
        to_state,
        victim,
        yield_before,
        yield_after: effYield(t),
      });
      // Salvage: razing a tile YOU own pays 4 × effYield as next-turn money, on
      // the first raze only (a second raze, on your own cracked tile, pays 0).
      if (victim === seat && from_state === "wall") {
        const paint = SALVAGE_MULT * yield_before;
        if (paint > 0) {
          credit[seat] = (credit[seat] ?? 0) + paint;
          cogs[seat]!.banked += paint; // salvage counts toward the score
          events.push({ kind: "salvage", seat, tile: k, paint });
        }
      }
      // The wars-started ledger: the first raze by `seat` on `victim`'s ground.
      if (victim !== null && victim !== seat) wars.add(`${seat}>${victim}`);
      // ── 5. strike bookkeeping (folded in: the raze that lands is the strike)
      for (const target of cogs) {
        if (target.seat === seat || target.life === "eliminated") continue;
        if (ownerAtStart.get(k) !== target.seat) continue;
        if (!homeRing(target.seat).includes(k)) continue;
        const by = strikesOn.get(target.seat) ?? new Set<number>();
        by.add(seat);
        strikesOn.set(target.seat, by);
      }
    }
  }
  for (const seat of state.cogOrder) {
    const by = strikesOn.get(seat);
    if (!by) continue;
    cogs[seat]!.struckThisTurn = true;
    events.push({ kind: "struck", seat, by: [...by].sort((a, b) => a - b) });
  }

  // ── 6. claim, simultaneous against the POST-RAZE board ─────────────────────
  const claimants = new Map<HexKey, number[]>();
  for (const seat of state.cogOrder) {
    const plan = plans.get(seat);
    if (!plan) continue;
    for (const k of plan.claims) {
      const list = claimants.get(k);
      if (list) list.push(seat);
      else claimants.set(k, [seat]);
    }
  }
  for (const [k, seats] of [...claimants.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const t = tiles[k]!;
    if (t.state === "rubble") {
      for (const seat of seats) events.push({ kind: "voided", seat, tile: k, reason: "rubble" });
      continue;
    }
    if (t.owner !== null) {
      for (const seat of seats) events.push({ kind: "voided", seat, tile: k, reason: "owned" });
      continue;
    }
    if (seats.length === 1) {
      const seat = seats[0]!;
      t.owner = seat;
      t.wet = true;
      t.claimedTurn = state.turn;
      events.push({ kind: "claim", seat, tile: k, yield: effYield(t) });
      continue;
    }
    // Wet paint over wet paint SMEARS: the tile stays unclaimed and every
    // claimant pays in full. The only same-turn contest in the game.
    t.owner = null;
    t.wet = false;
    t.claimedTurn = -1;
    events.push({ kind: "smear", tile: k, seats: [...seats].sort((a, b) => a - b) });
  }

  // ── 7. transfer — paint moves as NEXT-TURN money ───────────────────────────
  for (const seat of state.cogOrder) {
    const plan = plans.get(seat);
    if (!plan) continue;
    for (const tr of plan.transfers) {
      credit[tr.to] = (credit[tr.to] ?? 0) + tr.amount;
      events.push({ kind: "transfer", from: seat, to: tr.to, amount: tr.amount });
    }
  }

  // ── 8. charge ──────────────────────────────────────────────────────────────
  for (const seat of state.cogOrder) {
    const plan = plans.get(seat);
    if (!plan) continue;
    const cog = cogs[seat]!;
    if (cog.paint < plan.spend) {
      throw new Error(`resolve: affordability invariant violated for seat ${seat}`);
    }
    cog.paint -= plan.spend;
  }

  // Keep the derived wall counts honest for the observation/scorebug.
  const held = cogs.map(() => 0);
  for (const t of Object.values(tiles)) if (t.owner !== null) held[t.owner] = (held[t.owner] ?? 0) + 1;
  for (const cog of cogs) cog.wallsHeld = held[cog.seat] ?? 0;

  return {
    state: { ...state, phase: "resolve", tiles, cogs, credit, talk, wars: [...wars].sort(), destroyed },
    events,
  };
}

/** Cap a spectator-side `note` with the same rune-safe helper. */
export const capNote = (note: string): string => capText(note, MAX_NOTE_LEN);
