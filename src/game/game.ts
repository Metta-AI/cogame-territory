// TERRITORY on the shared @cogweb/core `Game` seam.
//
// Territory is SIMULTANEOUS: every living seat acts every turn, and the runner
// (forked in packages/core/src/runner.ts) issues all nine decisions as ONE
// PARALLEL BATCH per turn — `simultaneous: true` below is what selects that path.
// The seam is still pull-based, so we BUFFER each seat's submission as it arrives
// and, when the last living seat's arrives, run the pure `stepTurn` over the
// collected set: sequential application after a parallel gather is exactly the
// engine's own simultaneity.
//
// The engine is reused verbatim; no rule is reimplemented here.

import { z } from "zod";
import { GameError } from "@cogweb/core";
import type { ApplyResult, Game, GameModule } from "@cogweb/core";
import type { FeedEvent } from "@cogweb/protocol";

import type { EndReason, GameState } from "../shared/engine/types.js";
import type { TurnEvent, TurnRecord } from "../shared/engine/log.js";
import type { Submission } from "../shared/engine/orders.js";
import { SubmissionSchema } from "../shared/engine/orders.js";
import { rejectionReason, capNote } from "../shared/engine/resolve.js";
import {
  endReason,
  fallbacksBySeat,
  isFinished,
  newGame,
  scoreGame,
  settleEarly,
  stepTurn,
} from "../shared/engine/game.js";
import { MAX_TURNS, SEATS } from "../shared/engine/constants.js";
import { renderResolveEvent, renderUpkeepEvent } from "../shared/engine/text.js";
import { toSnapshot, type GameSnapshot } from "../shared/snapshot.js";
import { observe, type TerritoryObservation } from "./redact.js";

/** A turn's decision: the seat's whole reply (orders + talk + note). */
export type TerritoryDecision = Submission;

/** The seam state: the pure engine state plus this turn's submission buffer. */
export interface TerritorySeamState {
  engine: GameState;
  /** Living seats (in seat order) yet to submit THIS turn. */
  pending: number[];
  submissions: Record<number, Submission>;
}

/** What a seat receives (`redact(state, seat)`) or a spectator does (seat null). */
export type TerritoryView = GameSnapshot | TerritoryObservation;

/** The board-generation variant an episode runs. */
export interface TerritoryRules {
  variant: GameState["variant"];
  turns: number;
}

const RESOLVE_KINDS = new Set([
  "order",
  "rejected",
  "talk",
  "raze",
  "salvage",
  "struck",
  "claim",
  "smear",
  "voided",
  "transfer",
]);

/** The seat an event is "about", when one applies. */
function eventSeat(ev: TurnEvent): number | null {
  if (ev.kind === "transfer") return ev.from;
  if (ev.kind === "smear" || ev.kind === "dried" || ev.kind === "endcard") return null;
  return ev.seat;
}

/** Lower one completed turn's TurnRecord to FeedEvents (the runner stamps `turn`). */
function lowerRecord(state: GameState, record: TurnRecord): Array<Omit<FeedEvent, "turn">> {
  const alias = (s: number): string => state.cogs[s]?.alias ?? `seat ${s}`;
  return record.events.map((ev) => ({
    seat: eventSeat(ev),
    kind: ev.kind,
    text: RESOLVE_KINDS.has(ev.kind)
      ? renderResolveEvent(ev as Parameters<typeof renderResolveEvent>[0], alias)
      : renderUpkeepEvent(ev as Parameters<typeof renderUpkeepEvent>[0], alias),
    // A DM is addressed to one seat: the /global spectator feed (and therefore
    // the replay) sees it, no player ever reads that feed.
    to: ev.kind === "talk" && ev.to !== null ? [ev.to] : ("public" as const),
    data: ev,
  }));
}

/** Seed coercion: the seam hands a string, the engine wants a number. */
function seedToNumber(seed: string): number {
  const n = Number(seed);
  if (Number.isFinite(n)) return Math.trunc(n);
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  return h;
}

const livingPending = (engine: GameState): number[] =>
  engine.cogOrder.filter((s) => engine.cogs[s]!.life !== "eliminated");

export const territoryGame: Game<TerritorySeamState, TerritoryDecision, TerritoryView> & {
  simultaneous: true;
  settleEarly(state: TerritorySeamState, reason: string): TerritorySeamState;
} = {
  id: "territory",
  minPlayers: SEATS,
  maxPlayers: SEATS,
  /** Nine seats' decisions go out as one parallel batch per turn. */
  simultaneous: true,

  newGame({ seed, rules }): TerritorySeamState {
    // The runner's `seatNames` are DELIBERATELY IGNORED: Territory's cogs wear the
    // nine fixed anonymous aliases, so a platform-injected policy name can never
    // reach a prompt. Real names ride the one-shot `lobby` roster frame instead.
    const variant = (rules?.variant as GameState["variant"] | undefined) ?? "open";
    const turns = Number(rules?.turns ?? MAX_TURNS) || MAX_TURNS;
    const engine = newGame(seedToNumber(seed), variant, turns);
    return { engine, pending: livingPending(engine), submissions: {} };
  },

  turnOf(s): number {
    return s.engine.turn;
  },

  pendingActors(s): number[] {
    if (isFinished(s.engine)) return [];
    return s.pending;
  },

  decisionSchema(): z.ZodType<TerritoryDecision> {
    return SubmissionSchema as unknown as z.ZodType<TerritoryDecision>;
  },

  applyDecision(s, seat, decision): ApplyResult<TerritorySeamState> {
    if (!s.pending.includes(seat)) {
      throw new GameError(`seat ${seat} has already submitted this turn`);
    }
    // Validate this seat's set against the PRE-BATCH state with the engine's own
    // predicate, and bounce it with the engine's reason so the remote pilot can
    // re-request once. Wholesale rejection: no partial application.
    const reason = rejectionReason(s.engine, seat, decision.orders);
    if (reason !== null) throw new GameError(reason);

    const submission: Submission = {
      orders: decision.orders,
      messages: decision.messages ?? [],
      ...(decision.note !== undefined ? { note: capNote(decision.note) } : {}),
      ...(decision.fallback ? { fallback: true } : {}),
    };
    // Every fallback — host-side (timeout / illegal twice) or player-side (the
    // model was unreachable and the scripted move played) — is counted here, so
    // phase 60 can read "were the champions actually thinking" out of the replay.
    const engine: GameState = decision.fallback
      ? { ...s.engine, cogs: s.engine.cogs.map((c) => (c.seat === seat ? { ...c, fallbacks: c.fallbacks + 1 } : c)) }
      : s.engine;

    const next: TerritorySeamState = {
      engine,
      pending: s.pending.filter((x) => x !== seat),
      submissions: { ...s.submissions, [seat]: submission },
    };
    if (next.pending.length > 0) return { state: next };

    // Last living seat in: run the simultaneous turn.
    const stepped = stepTurn(next.engine, next.submissions);
    const record = stepped.log[stepped.log.length - 1]!;
    return {
      state: { engine: stepped, pending: livingPending(stepped), submissions: {} },
      events: lowerRecord(stepped, record),
    };
  },

  isFinished(s): boolean {
    return isFinished(s.engine);
  },

  score(s): Record<number, number> {
    const out: Record<number, number> = {};
    const scores = scoreGame(s.engine);
    for (const seat of s.engine.cogOrder) out[seat] = scores[seat] ?? 0;
    return out;
  },

  redact(s, seat): TerritoryView {
    return seat === null ? toSnapshot(s.engine) : observe(s.engine, seat);
  },

  /** An empty order set — a legal hold for any seat, any turn. Flagged as a
   *  fallback so `results.fallbacks[seat]` counts it. */
  baselineDecision(): TerritoryDecision {
    return { orders: [], messages: [], fallback: true };
  },

  /** The host's wall-clock guard: settle now, write everything, never overrun.
   *  The seam declares `reason: string`; only the three declared values ever
   *  reach it (the runner passes "deadline"), and `results_schema` enumerates them. */
  settleEarly(s, reason): TerritorySeamState {
    return { ...s, engine: settleEarly(s.engine, reason as EndReason) };
  },
};

export const territoryModule: GameModule<TerritorySeamState, TerritoryDecision, TerritoryView> = {
  game: territoryGame,
};

export { endReason, fallbacksBySeat, scoreGame };
