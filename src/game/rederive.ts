// REPLAY RE-DERIVATION — replay the recorded EVENTS through the sim and rebuild
// every frame from them, rather than reading the recorded snapshots back.
//
// The design note's pin is that `(seed, variant, ordersByTurn)` reproduces a game
// byte for byte, "which is what lets the same module be compiled into the viewer
// bundle by vite and re-derive every frame in the browser". This module is that
// re-derivation, and importing it from `src/client/App.tsx` is what puts the
// engine's rule modules in the REPLAY bundle rather than only in the fixture one.
//
// What the recorded frames supply:
//   * the first `snapshot` frame — `seed`, `variant`, `turns` (the seed is in
//     `config` AND in every snapshot);
//   * one `actPrompt` frame per seat per turn — its accepted attempt's `response`
//     IS that seat's submission for that turn, and `usedFallback` marks the turns
//     the host substituted `baselineDecision` itself.
//
// From those two it drives the PURE ENGINE the host drove, replicating exactly
// what `TerritoryGame.applyDecision` does around it: bounce a set the board would
// reject, count a `fallback` submission against the seat, then `stepTurn` over the
// gathered set once every living seat is in. (It deliberately does NOT import the
// game seam: `src/game/game.ts` pulls in `@cogweb/core`, whose index reaches
// express and `node:fs`, and the viewer bundle must stay browser-only.)
//
// Nothing here reads a recorded snapshot except to CHECK the re-derivation against
// it, frame by frame; the first divergence is reported rather than hidden.
import type { ServerMessage } from "@cogweb/protocol";

import { gameSnapshotSchema } from "../shared/protocol.js";
import { SubmissionSchema, type Submission } from "../shared/engine/orders.js";
import { isFinished, newGame, stepTurn } from "../shared/engine/game.js";
import { rejectionReason } from "../shared/engine/resolve.js";
import type { GameState } from "../shared/engine/types.js";
import { toSnapshot, type GameSnapshot } from "../shared/snapshot.js";

/** Canonical form for a frame-by-frame comparison: the strict snapshot schema
 *  emits its keys in schema order, so two structurally-equal snapshots always
 *  stringify identically regardless of how they were built. */
const canon = (snap: GameSnapshot): string => JSON.stringify(gameSnapshotSchema.parse(snap));

/** The host's own always-legal hold, flagged the way `baselineDecision` flags it. */
const baseline = (): Submission => ({ orders: [], messages: [], fallback: true });

export interface Rederivation {
  /** The re-derived snapshots, one per recorded snapshot turn, in turn order. */
  snapshots: GameSnapshot[];
  /** How many recorded snapshots the re-derivation reproduced exactly. */
  verified: number;
  /** The first recorded turn that did NOT reproduce, described; null when all did. */
  mismatch: string | null;
}

/** The recorded snapshots, ONE PER TURN (the last frame recorded for a turn is
 *  that turn's settled state), ascending by turn. */
function recordedSnapshots(frames: readonly ServerMessage[]): GameSnapshot[] {
  const byTurn = new Map<number, GameSnapshot>();
  for (const frame of frames) {
    if (frame.type !== "snapshot") continue;
    const parsed = gameSnapshotSchema.safeParse(frame.snapshot.state);
    if (!parsed.success) continue;
    byTurn.set(parsed.data.turn, parsed.data);
  }
  return [...byTurn.entries()].sort(([a], [b]) => a - b).map(([, snap]) => snap);
}

/**
 * The submission each seat played on each turn, keyed `"<turn>:<seat>"`.
 *
 * `usedFallback` means the RUNNER substituted `baselineDecision` for that seat (a
 * reply timeout, or a decision rejected on every attempt), so no recorded response
 * was applied — those seats are left absent here and the caller plays the same
 * baseline. Otherwise the applied decision is the attempt that carried no error; a
 * player-side fallback (the model was unreachable and the scripted move played)
 * rides that response with its own `fallback: true`.
 */
function submissionsFrom(frames: readonly ServerMessage[]): Map<string, Submission> {
  const out = new Map<string, Submission>();
  for (const frame of frames) {
    if (frame.type !== "actPrompt") continue;
    const wire = frame.actPrompt;
    if (wire.usedFallback) continue;
    for (const attempt of wire.attempts) {
      if (attempt.error !== null || attempt.response === "") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(attempt.response);
      } catch {
        continue; // not a decision payload; a later attempt may be
      }
      const parsed = SubmissionSchema.safeParse(raw);
      if (parsed.success) out.set(`${wire.turn}:${wire.seat}`, parsed.data);
    }
  }
  return out;
}

/**
 * Re-derive every frame of a recorded episode from its recorded events.
 *
 * Never throws: an episode this module cannot reproduce (no snapshot frames, a
 * recorded decision the re-derived board rejects, an early settle whose orders
 * were never recorded) comes back with a `mismatch` string and however many frames
 * it managed.
 */
export function rederiveReplay(frames: readonly ServerMessage[]): Rederivation {
  const recorded = recordedSnapshots(frames);
  if (recorded.length === 0) return { snapshots: [], verified: 0, mismatch: "no snapshot frames" };

  const first = recorded[0]!;
  const submissions = submissionsFrom(frames);
  let state: GameState = newGame(first.seed, first.variant, first.turns);

  const snapshots: GameSnapshot[] = [];
  let verified = 0;
  let mismatch: string | null = null;

  for (const want of recorded) {
    // Play forward until the re-derivation stands on the recorded turn.
    while (mismatch === null && state.turn < want.turn && !isFinished(state)) {
      const turn = state.turn;
      const living = state.cogOrder.filter((s) => state.cogs[s]!.life !== "eliminated");
      const gathered: Record<number, Submission> = {};
      let fallbacks: GameState["cogs"] = state.cogs;
      for (const seat of living) {
        const decision = submissions.get(`${turn}:${seat}`) ?? baseline();
        const reason = rejectionReason(state, seat, decision.orders);
        if (reason !== null) {
          mismatch = `turn ${turn} seat ${seat}: the re-derived board rejects the recorded orders (${reason})`;
          break;
        }
        gathered[seat] = decision;
        // The seam counts every fallback — host-side hold or player-side scripted
        // move — on the seat, and the snapshot carries that counter.
        if (decision.fallback) {
          fallbacks = fallbacks.map((c) => (c.seat === seat ? { ...c, fallbacks: c.fallbacks + 1 } : c));
        }
      }
      if (mismatch !== null) break;
      state = stepTurn({ ...state, cogs: fallbacks }, gathered);
      if (state.turn === turn) break; // no progress: stop rather than spin
    }
    const got = toSnapshot(state);
    snapshots.push(got);
    if (mismatch === null && canon(got) !== canon(want)) {
      mismatch = `turn ${want.turn} differs from the recorded snapshot`;
    }
    if (mismatch === null) verified += 1;
  }

  return { snapshots, verified, mismatch };
}
