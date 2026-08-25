// A non-LLM decision source: plays the game's baseline move (or a supplied
// chooser). Used for headless evaluation, deterministic tests, and as a cheap
// stand-in bot. Like every Pilot it routes its choice through ctx.validate, so
// even a scripted move is schema- and legality-checked.

import type { Pilot, DecideContext } from "./pilot";

export class ScriptedPilot<State, Decision> implements Pilot<State, Decision> {
  readonly kind = "scripted" as const;
  readonly #choose: (ctx: DecideContext<State, Decision>) => unknown;

  constructor(choose?: (ctx: DecideContext<State, Decision>) => unknown) {
    this.#choose = choose ?? ((ctx) => ctx.game.baselineDecision(ctx.state, ctx.seat));
  }

  async decide(ctx: DecideContext<State, Decision>): Promise<Decision> {
    return ctx.validate(this.#choose(ctx));
  }
}
