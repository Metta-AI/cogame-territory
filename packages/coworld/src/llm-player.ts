// The standard LLM coworld player: a Bedrock-driven policy for a coworld slot,
// the player-side counterpart of @cogweb/llm's LlmPilot (which drives a live
// seat). A game gets it for free from its `Autopilot` — no per-game LLM plumbing.
//
// The player only ever holds its OWN redacted view (the host redacts per slot,
// so an operative never receives the key). It therefore validates a decision
// against the schema ONLY; the game HOST checks legality and, on rejection,
// re-requests with a `reason` that the next observation surfaces for a retry.

import { BedrockLlmClient, robustDecide } from "@cogweb/llm";
import type { GameModule } from "@cogweb/core";
import { runCoworldPlayer } from "./player-runtime.js";
import type { PlayerDecideContext } from "./player-runtime.js";

export interface LlmCoworldPlayerOpts<State, Decision, View> {
  /** The game module; MUST carry an `autopilot` (its prompts drive the model). */
  module: GameModule<State, Decision, View>;
  /** A Bedrock client; defaults to one built from env (optionally `prefix`ed). */
  client?: BedrockLlmClient;
  /** Env prefix for the default client (e.g. "COGNAMES" → COGNAMES_BEDROCK_*). */
  prefix?: string;
  /** Socket URL; defaults to COWORLD_PLAYER_WS_URL. */
  connect?: string;
  /** Operator guidance to fold into the prompt, per seat. */
  guidanceFor?: (seat: number) => string;
  /** Retries per decision before falling back to the baseline. */
  maxAttempts?: number;
}

/** Build the LLM `decide` callback for a coworld player from a game's autopilot.
 *  Exposed (not just `runLlmCoworldPlayer`) so it can be unit-tested with a fake
 *  Bedrock client and reused in a custom player loop. */
export function makeLlmCoworldDecide<State, Decision, View>(
  opts: LlmCoworldPlayerOpts<State, Decision, View>,
): (ctx: PlayerDecideContext<State, Decision, View>) => Promise<Decision> {
  const { game, autopilot } = opts.module;
  if (!autopilot) throw new Error("makeLlmCoworldDecide requires module.autopilot");
  const client = opts.client ?? new BedrockLlmClient({ prefix: opts.prefix });

  return ({ view, seat, reason, messages, timeLeftMs }) => {
    // The redacted view IS this player's working state: the autopilot, schema,
    // and baseline read only view-available fields. (Legality needs the full
    // state and is the host's job — hence schema-only validate here.)
    const state = view as unknown as State;
    const guidance = opts.guidanceFor?.(seat) ?? "";
    return robustDecide<Decision>({
      client,
      system: autopilot.systemPrompt({ game, seat }),
      renderUser: (rejection) => {
        // Fold the seat's visible inbox into the prompt so the policy reacts to the
        // table talk it's entitled to (empty for a game with no comms).
        const observation = autopilot.renderObservation(state, seat, { guidance, messages });
        // Chess clock: tell the model its remaining whole-episode thinking budget so
        // it can pace itself; at 0 the host plays random for it. Omitted with no clock.
        const clock =
          timeLeftMs == null
            ? ""
            : `\n\n⏱ Time left this game: ${(timeLeftMs / 1000).toFixed(1)}s. When it runs out, random moves are played for you.`;
        const hostReason = reason
          ? `\n\nThe game rejected your previous move: ${reason}. Choose a different legal move.`
          : "";
        const parseReason = rejection ? `\n\n${rejection}` : "";
        return observation + clock + hostReason + parseReason;
      },
      validate: (candidate) => game.decisionSchema(state, seat).parse(candidate),
      baseline: () => game.baselineDecision(state, seat),
      tool: autopilot.tool?.(state, seat),
      recordAttempt: () => {},
      maxAttempts: opts.maxAttempts,
    });
  };
}

/** Run an LLM-piloted coworld player slot to completion (resolves with the final
 *  per-slot scores). Drop-in replacement for a baseline `runCoworldPlayer`. */
export function runLlmCoworldPlayer<State, Decision, View>(
  opts: LlmCoworldPlayerOpts<State, Decision, View>,
): Promise<number[]> {
  return runCoworldPlayer<State, Decision, View>({
    module: opts.module,
    connect: opts.connect,
    decide: makeLlmCoworldDecide(opts),
  });
}
