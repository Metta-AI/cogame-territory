// The SEAM. Everything in the shared platform is generic over these interfaces;
// a game is the thing that implements them. The platform owns the lobby, server,
// websocket, run loop, coworld remote-player runtime, autopilot loop, and UI
// shell. The game owns rules, state, schema, prompts, and rendering.
//
// Inversion of control: shared code calls INTO these; this file never imports
// from any game.

import type { ZodType } from "zod";
import type { Audience, FeedEvent, RuleOption } from "@cogweb/protocol";

/** Illegal-but-well-typed moves throw this; the run loop / autopilot retries. */
export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameError";
  }
}

/** A message one seat sends to others, surfaced into autopilot observations. */
export interface ObservedMessage {
  from: number;
  to: Audience;
  text: string;
  turn: number;
}

/** Result of applying a decision: the next state plus events to broadcast. */
export interface ApplyResult<State> {
  state: State;
  /** Events emitted by this move; the runner stamps `turn` before broadcast. */
  events?: Array<Omit<FeedEvent, "turn">>;
}

/**
 * The engine seam: pure, synchronous, game-specific rules. No IO, no LLM, no
 * sockets. This is the single source of truth for "what is a legal move and
 * what does it do".
 */
export interface Game<State, Decision, View = unknown> {
  readonly id: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;

  /**
   * OPTIONAL — declarative per-game rule knobs (map size, respawn cap, …) the
   * shared configure screen renders as selects. The lobby seeds its rule values
   * from each option's `default`, validates `setRule` against the choices, and
   * hands the chosen values to {@link newGame} via `opts.rules` at start. A game
   * with no knobs omits this and `opts.rules` arrives empty.
   */
  readonly ruleOptions?: RuleOption[];

  /** Create the initial state for a game with `playerCount` seats. `seatNames[i]`
   *  is seat i's display name from the lobby roster ("" when the seat has no human
   *  name, e.g. a scripted/remote pilot); a game may use these as agent identities
   *  or ignore them. `rules` carries the lobby's chosen {@link ruleOptions} values
   *  (absent for hosts with no lobby, e.g. a coworld episode). */
  newGame(opts: { seed: string; playerCount: number; seatNames: string[]; rules?: Record<string, string> }): State;

  /** The current turn number, used to stamp snapshots and events. */
  turnOf(state: State): number;

  /**
   * Which seats must submit a decision next. One seat for turn-based games,
   * several for simultaneous phases, empty when the game is between phases or
   * finished. The run loop and coworld runtime fan out over this.
   */
  pendingActors(state: State): number[];

  /**
   * The zod schema a decision for (state, seat) must satisfy. Used to validate
   * human input, remote-player payloads, and LLM tool output uniformly.
   */
  decisionSchema(state: State, seat: number): ZodType<Decision>;

  /**
   * Apply an already schema-valid decision. MUST throw {@link GameError} if the
   * move is illegal in the current state (e.g. unaffordable, out of turn) so the
   * retry loop can re-prompt with the reason.
   */
  applyDecision(state: State, seat: number, decision: Decision): ApplyResult<State>;

  isFinished(state: State): boolean;

  /** Final or running scores by seat. */
  score(state: State): Record<number, number>;

  /** Redact full state to a per-seat view; seat=null yields the public view. */
  redact(state: State, seat: number | null): View;

  /** An always-legal move, used as the fallback when a pilot fails or times out. */
  baselineDecision(state: State, seat: number): Decision;

  /**
   * OPTIONAL — an always-legal RANDOM move (uniformly among the legal moves), the
   * coworld chess clock's "out of time" move: when a policy's total per-episode
   * thinking budget is spent the host plays this for the seat for the rest of the
   * game (see {@link CoworldHostOpts.chessClockMs}). A game that defines it degrades
   * a timed-out policy to RANDOM play; a game that omits it falls back to
   * {@link baselineDecision} (its heuristic always-legal move). Define it when a
   * uniformly-random legal move is well-defined for the game (e.g. worker placement);
   * omit it when "random" is ill-defined (e.g. composing a free-text clue).
   */
  randomDecision?(state: State, seat: number): Decision;

  /**
   * OPTIONAL — declare the game SIMULTANEOUS. Every pending actor owes a decision
   * for the same turn against the same board, so the run loop issues them as ONE
   * PARALLEL BATCH (`Promise.all`) and applies the gathered decisions in seat
   * order, instead of driving one seat at a time. At nine LLM seats the
   * sequential path is nine serial round trips per turn and no episode fits any
   * budget; the batch path is one round trip per turn. A game that omits this
   * keeps the turn-based loop unchanged.
   */
  readonly simultaneous?: boolean;

  /**
   * OPTIONAL — stop the episode NOW with a declared reason (the host's wall-clock
   * guard). The returned state must report `isFinished() === true` and must carry
   * the reason into the results artifact. A settle is never an overrun: results
   * and the replay are always written. A game that omits this cannot be settled
   * early and the runner just stops driving it.
   */
  settleEarly?(state: State, reason: string): State;

  /**
   * OPTIONAL — declare the current phase a free-form TIMED window that owes no
   * per-seat decision (e.g. a discussion period). Return its wall-clock budget
   * when the phase is open, else null/undefined. While open, {@link pendingActors}
   * MUST be empty: the run loop waits the budget — broadcasting a countdown via
   * `RunStatus.deadline` — or an early end ({@link GameRunner.endOpenPhase}), then
   * calls {@link advanceOpenPhase} to transition out. Talk during the window flows
   * over the async `say` channel, not decisions. A game with no such phase omits
   * both methods and the default turn-based loop is unchanged.
   */
  openPhase?(state: State): { timeoutMs: number } | null;

  /** Transition out of the open phase (the timer fired or it was ended early). */
  advanceOpenPhase?(state: State): ApplyResult<State>;
}

/**
 * The autopilot seam: how an LLM pilots a seat. Kept separate from {@link Game}
 * so the engine stays free of prompt concerns and so a game can ship without an
 * autopilot (human-only, like cognames).
 */
export interface Autopilot<State, Decision> {
  /** System prompt: rules, strategy, and output-format contract for `seat`. */
  systemPrompt(ctx: { game: Game<State, Decision>; seat: number }): string;

  /** Render the seat's redacted observation + operator guidance + messages. */
  renderObservation(
    state: State,
    seat: number,
    ctx: { guidance: string; messages: ObservedMessage[] },
  ): string;

  /**
   * Optional Bedrock tool spec for structured output. When present the LLM
   * driver uses tool-use; when absent it extracts JSON from the text response.
   */
  tool?(state: State, seat: number): { name: string; description: string; inputSchema: unknown };
}

/** What a game registers with the platform. */
export interface GameModule<State, Decision, View = unknown> {
  game: Game<State, Decision, View>;
  /** Omit for human-only games. */
  autopilot?: Autopilot<State, Decision>;
}
