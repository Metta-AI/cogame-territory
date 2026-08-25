// The decision-source seam. The run loop drives `pendingActors` and asks a
// `Pilot` for each seat's decision. Three implementations exist: an LLM
// autopilot (@cogweb/llm), a remote coworld player (@cogweb/coworld), and a
// human over the websocket (@cogweb/core). The runner is generic over all of
// them and centralizes validate-then-apply-or-fallback.

import type { ActAttempt, FeedEvent } from "@cogweb/protocol";
import type { Game } from "./game";

export interface DecideContext<State, Decision> {
  readonly game: Game<State, Decision>;
  readonly state: State;
  readonly seat: number;
  /** Operator/human guidance steering an LLM pilot (empty for non-LLM). */
  readonly guidance: string;
  /**
   * Validate a candidate against schema AND legality (a dry-run applyDecision).
   * Returns the typed decision, or throws with a human-readable reason suitable
   * for re-prompting an LLM. Pilots SHOULD call this and may retry on throw.
   */
  validate(candidate: unknown): Decision;
  /** Record one attempt for the autopilot transcript surfaced in the UI. */
  recordAttempt(attempt: ActAttempt): void;
}

export interface Pilot<State, Decision> {
  readonly kind: "llm" | "remote" | "human" | "scripted";
  /**
   * Produce a decision for `ctx.seat`. May throw or reject; the runner falls
   * back to `game.baselineDecision` after exhausting the pilot.
   */
  decide(ctx: DecideContext<State, Decision>): Promise<Decision>;
  /**
   * Abandon `seat`'s in-flight decision, if any. The runner calls this when it
   * stops awaiting a seat (auto-advance fired) so a pilot parking a turn — the
   * human pilot waiting on a websocket submit — can settle its promise instead of
   * leaking it. Pilots that compute on demand (LLM/scripted) need not implement it.
   */
  abort?(seat: number): void;
  /**
   * Announce `seat` once, at episode start — before the first decision. The runner
   * calls this exactly once per game (in parallel across seats) and broadcasts the
   * returned feed event through its normal stream, so it lands in the live
   * spectator feed AND the recorded replay with no per-host plumbing. Return `null`
   * to stay silent. Use it for a seat identity a pilot establishes up front (e.g. a
   * generated persona); the runner stamps the current `turn`. Pilots with no intro
   * need not implement it.
   */
  intro?(seat: number): Promise<Omit<FeedEvent, "turn"> | null>;
}
