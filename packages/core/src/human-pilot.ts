// The human decision source. Unlike the LLM/remote pilots, a human doesn't
// compute a decision on demand — they submit it over the websocket whenever
// they choose. So `decide` returns a promise parked in a per-seat registry; the
// websocket layer calls `submit(seat, decision)` when a "decision" frame lands,
// which validates it through the same ctx.validate gate every pilot uses and
// resolves the parked promise (or surfaces the rejection reason to retry).

import type { Pilot, DecideContext } from "./pilot";

/** A parked human turn: its validate gate and the resolve/reject of decide(). */
interface Pending<Decision> {
  validate: (candidate: unknown) => Decision;
  resolve: (decision: Decision) => void;
  reject: (reason: Error) => void;
}

export class HumanPilot<State, Decision> implements Pilot<State, Decision> {
  readonly kind = "human" as const;
  readonly #pending = new Map<number, Pending<Decision>>();
  // A decision that arrived BEFORE its turn was parked — the human acted in the
  // window where the runner hasn't called decide() yet (most often at game start,
  // where the loop first awaits every bot's `intro` LLM call). Held per seat (a
  // newer raced submit replaces an older) and delivered the instant decide() parks,
  // so a raced submit is honored instead of silently dropped.
  readonly #early = new Map<number, unknown>();

  decide(ctx: DecideContext<State, Decision>): Promise<Decision> {
    return new Promise<Decision>((resolve, reject) => {
      this.#pending.set(ctx.seat, { validate: ctx.validate, resolve, reject });
      const early = this.#early.get(ctx.seat);
      if (early === undefined) return;
      this.#early.delete(ctx.seat);
      // Deliver the raced submit through the normal validated path. An illegal
      // raced move throws a re-promptable reason (validate's documented control
      // flow) — drop it and leave the turn parked for a fresh attempt rather than
      // rejecting this decide() (which would baseline-fallback the human's turn).
      try {
        this.submit(ctx.seat, early);
      } catch {
        // illegal raced submit: turn stays parked for the human to re-submit
      }
    });
  }

  /**
   * Deliver a human's raw decision for `seat`. If the turn is parked, validates it
   * through the turn's gate (schema + legality dry-run): on success the parked turn
   * resolves; on a rejection the reason is thrown so the client can re-prompt and
   * the turn stays parked. If the turn is NOT parked yet (the human raced ahead of
   * the runner parking it), the submission is buffered and returns `undefined`;
   * decide() delivers it when the turn parks.
   */
  submit(seat: number, candidate: unknown): Decision | undefined {
    const pending = this.#pending.get(seat);
    if (!pending) {
      this.#early.set(seat, candidate);
      return undefined;
    }
    const decision = pending.validate(candidate);
    this.#pending.delete(seat);
    pending.resolve(decision);
    return decision;
  }

  /** True while `seat`'s human turn is parked awaiting a submission. */
  isAwaiting(seat: number): boolean {
    return this.#pending.has(seat);
  }

  /** Pilot.abort: the runner abandons this seat (auto-advance fired). Same as
   *  cancel — settle the parked promise so it isn't leaked. */
  abort(seat: number): void {
    this.cancel(seat);
  }

  /** Cancel a parked turn (e.g. on reset) so its decide() promise rejects, and drop
   *  any buffered raced submit so it can't leak into a later turn/generation. */
  cancel(seat: number): void {
    this.#early.delete(seat);
    const pending = this.#pending.get(seat);
    if (!pending) return;
    this.#pending.delete(seat);
    pending.reject(new Error("turn cancelled"));
  }

  /** Cancel every parked turn and drop every buffered submit (reset / shutdown). */
  cancelAll(): void {
    for (const seat of [...this.#pending.keys()]) this.cancel(seat);
    this.#early.clear();
  }
}
