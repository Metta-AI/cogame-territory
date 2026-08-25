// The LLM autopilot: a `Pilot` (kind "llm") that drives a seat with a model. It
// builds the system prompt and the rendered observation from the game's
// `Autopilot`, folds in operator guidance and the seat's visible messages, and
// delegates the retry-then-fallback to `robustDecide`. The runner owns
// validate/baseline/recordAttempt via `DecideContext`; this pilot owns the
// prompt and the model call.
import type { Autopilot, ObservedMessage } from "@cogweb/core";
import type { DecideContext, Pilot } from "@cogweb/core";
import type { BedrockLlmClient, ToolSpec } from "./bedrock.js";
import { robustDecide } from "./robust-decide.js";

export interface LlmPilotOpts<State, Decision> {
  client: BedrockLlmClient;
  autopilot: Autopilot<State, Decision>;
  /** Per-seat model id (operator-selectable); empty/undefined uses the client's. */
  modelFor: (seat: number) => string;
  /** The seat's visible inbox (public + sent/received), folded into the prompt. */
  messagesFor: (seat: number) => ObservedMessage[];
}

export class LlmPilot<State, Decision> implements Pilot<State, Decision> {
  readonly kind = "llm" as const;
  readonly #client: BedrockLlmClient;
  readonly #autopilot: Autopilot<State, Decision>;
  readonly #modelFor: (seat: number) => string;
  readonly #messagesFor: (seat: number) => ObservedMessage[];

  constructor(opts: LlmPilotOpts<State, Decision>) {
    this.#client = opts.client;
    this.#autopilot = opts.autopilot;
    this.#modelFor = opts.modelFor;
    this.#messagesFor = opts.messagesFor;
  }

  async decide(ctx: DecideContext<State, Decision>): Promise<Decision> {
    const { game, state, seat, guidance } = ctx;
    const system = this.#autopilot.systemPrompt({ game, seat });
    const messages = this.#messagesFor(seat);
    const spec = this.#autopilot.tool?.(state, seat);
    const tool: ToolSpec | undefined = spec
      ? { name: spec.name, description: spec.description, inputSchema: spec.inputSchema }
      : undefined;

    return robustDecide<Decision>({
      client: this.#client,
      system,
      // Re-render each attempt: the game's renderObservation folds in the
      // operator guidance; on a retry we append the prior rejection so the model
      // re-states and fixes the error.
      renderUser: (rejection) => {
        const base = this.#autopilot.renderObservation(state, seat, { guidance, messages });
        if (!rejection) return base;
        return `${base}\n\nYour previous reply was rejected: ${rejection}\nFix it and answer again.`;
      },
      validate: ctx.validate,
      baseline: () => game.baselineDecision(state, seat),
      recordAttempt: ctx.recordAttempt,
      tool,
    });
  }

  /** The model id this pilot will use for `seat` (drives the UI picker). */
  modelOf(seat: number): string {
    return this.#modelFor(seat) || this.#client.model;
  }
}
