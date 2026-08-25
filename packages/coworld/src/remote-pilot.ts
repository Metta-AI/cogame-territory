// The GAME side of the coworld player protocol. `RemotePlayerPilot` is a
// `Pilot` (kind "remote") the run loop asks for a seat's decision; it forwards
// the seat's redacted observation to an external player over a per-slot
// websocket and awaits the reply.
//
// `decide` runs the reply through `ctx.validate` (schema + legality). On a
// validation throw it re-requests the player up to MAX_ATTEMPTS times, each time
// forwarding the rejection reason so the player can correct. If every attempt
// fails (or the player times out / the socket drops), it throws — the runner
// then falls back to `game.baselineDecision`. Every attempt is recorded via
// `ctx.recordAttempt` for the autopilot transcript.
//
// Circuit breaker: a player that connects but stops replying would otherwise
// cost the FULL act-timeout on every remaining decision. Across an episode that
// sums to decisions × actTimeoutMs (e.g. ~37 decisions × 20s ≈ 12 min per dead
// seat) which blows the dispatch wall-clock and fails the whole episode with no
// scores. After GIVE_UP_AFTER_TIMEOUTS consecutive reply-timeouts we treat the
// slot as gone and fail fast for the rest of the episode, so the runner uses the
// baseline immediately — bounded degradation instead of a killed episode. A
// single live reply resets the breaker, so a merely slow (but answering) player
// is never benched.
import { WebSocket } from "ws";
import type { Pilot, DecideContext } from "@cogweb/core";
import { PlayerToGame, type InboxMessage, type ObservationMessage, type TalkLine } from "./protocol";

const MAX_ATTEMPTS = 3;
const GIVE_UP_AFTER_TIMEOUTS = 3;

export interface RemotePlayerPilotOpts {
  /** Base `/player` websocket URL, e.g. "ws://host:8080/player". */
  url: string;
  /** This pilot's slot; appended as the `slot` query param. */
  slot: number;
  /** The slot's auth token; appended as the `token` query param. */
  token: string;
  /** How long to wait for one reply before treating it as a failure. */
  actTimeoutMs?: number;
  /** How long to wait for the socket to open before failing. */
  connectTimeoutMs?: number;
  /** The seat's visible inbox, attached to each observation so the player sees the
   *  table talk it's entitled to. Defaults to an empty inbox (no comms). */
  inboxFor?: (seat: number) => InboxMessage[];
  /** Sink for cheap-talk lines a player posts with its reply: the host routes them
   *  to the episode bus + spectator feed. Omitted when the game has no comms. */
  onTalk?: (seat: number, turn: number, lines: TalkLine[]) => void;
  /** Chess clock: the INITIAL wall-clock thinking bank (ms) for this policy. The
   *  pilot tells the policy its remaining bank on every observation (`timeLeftMs`),
   *  decrements it by the time each turn takes, and once it is spent stops asking
   *  and plays the game's `randomDecision` (falling back to `baselineDecision`)
   *  for the seat for the rest of the game. Omit (or undefined) for an unbounded
   *  budget — the per-turn `actTimeoutMs` + circuit breaker still bound a dead
   *  socket. */
  chessClockMs?: number;
  /** Fischer-increment hook: called before each decision request with the current
   *  state + seat; the returned ms are CREDITED to the seat's bank (unused time
   *  banks for future turns). The game decides what counts as "a turn" (e.g.
   *  cogtan credits at each setup/preroll request). Only meaningful with
   *  `chessClockMs` set. */
  chessClockCreditFor?: (state: unknown, seat: number) => number;
}

export class RemotePlayerPilot<State, Decision> implements Pilot<State, Decision> {
  readonly kind = "remote" as const;

  readonly #url: string;
  readonly #slot: number;
  readonly #actTimeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #inboxFor: (seat: number) => InboxMessage[];
  readonly #onTalk: ((seat: number, turn: number, lines: TalkLine[]) => void) | null;
  /** Configured chess-clock budget (ms), or null for an unbounded budget. */
  readonly #clockMs: number | null;
  /** Per-turn credit hook (Fischer increment), or null for a fixed total budget. */
  readonly #creditFor: ((state: unknown, seat: number) => number) | null;
  /** Remaining thinking budget (ms); only meaningful when `#clockMs` is set. */
  #bankMs: number;

  #ws: WebSocket | null = null;
  #seq = 0;
  /** The seat + turn of the in-flight observation, so a reply's cheap-talk lines
   *  can be attributed when they arrive (the bridge is per-slot, one act at a time). */
  #cur: { seat: number; turn: number } = { seat: 0, turn: 0 };
  /** The single in-flight observation's reply resolver, keyed by id. */
  #pending: { id: number; resolve: (decision: unknown) => void } | null = null;
  /** Consecutive reply-timeouts; reset by any live reply. Trips the breaker. */
  #consecutiveTimeouts = 0;
  /** Once tripped, every decide fails fast (the runner uses the baseline). */
  #unresponsive = false;

  constructor(opts: RemotePlayerPilotOpts) {
    const u = new URL(opts.url);
    u.searchParams.set("slot", String(opts.slot));
    u.searchParams.set("token", opts.token);
    this.#url = u.toString();
    this.#slot = opts.slot;
    this.#actTimeoutMs = opts.actTimeoutMs ?? 120_000;
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
    this.#inboxFor = opts.inboxFor ?? (() => []);
    this.#onTalk = opts.onTalk ?? null;
    this.#clockMs = opts.chessClockMs ?? null;
    this.#creditFor = opts.chessClockCreditFor ?? null;
    this.#bankMs = opts.chessClockMs ?? 0;
  }

  async decide(ctx: DecideContext<State, Decision>): Promise<Decision> {
    // Breaker already tripped: don't wait the act-timeout again, fail straight to
    // the baseline so a dead player can't drag the episode past the wall-clock.
    if (this.#unresponsive) {
      throw new Error(`remote player slot ${this.#slot} unresponsive; using baseline`);
    }
    // Fischer increment: credit this decision's turn allowance BEFORE the spent
    // check, so a seat that emptied its bank still gets its per-turn time (the
    // clock model is "5s per turn, bankable", not "one prepaid pool").
    if (this.#clockMs !== null && this.#creditFor) {
      this.#bankMs += Math.max(0, this.#creditFor(ctx.state, ctx.seat));
    }
    // Chess clock spent: don't contact the policy at all — play a random legal
    // move for it (no round trip) until the increment refunds it.
    if (this.#clockMs !== null && this.#bankMs <= 0) return this.#playRandom(ctx);

    const ws = await this.#ensureConnected();
    const view = ctx.game.redact(ctx.state, ctx.seat);
    const turn = ctx.game.turnOf(ctx.state);
    this.#cur = { seat: ctx.seat, turn };

    const startedAt = Date.now();
    const remainingBank = (): number => Math.max(0, this.#bankMs - (Date.now() - startedAt));
    try {
      let reason: string | null = null;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const id = this.#seq++;
        const obs: ObservationMessage = {
          type: "observation",
          id,
          seat: ctx.seat,
          turn,
          view,
          messages: this.#inboxFor(ctx.seat),
          reason,
          // Tell the policy its remaining budget (null = no chess clock).
          timeLeftMs: this.#clockMs !== null ? Math.round(remainingBank()) : null,
        };
        let raw: unknown;
        try {
          // Cap this turn's wait at the smaller of the per-turn act-timeout and the
          // remaining bank, so one turn can never overrun the whole-episode budget.
          const waitMs = this.#clockMs !== null ? Math.min(this.#actTimeoutMs, remainingBank()) : this.#actTimeoutMs;
          raw = await this.#request(ws, obs, waitMs);
        } catch (err) {
          // The bank ran out waiting for this reply: switch to random for the rest of
          // the game (this is the chess clock expiring, not an unresponsive socket).
          if (this.#clockMs !== null && remainingBank() <= 0) return this.#playRandom(ctx);
          // Otherwise a reply timeout / socket drop: count it toward the breaker, then
          // let the runner fall back to the baseline for this decision.
          if (++this.#consecutiveTimeouts >= GIVE_UP_AFTER_TIMEOUTS) this.#unresponsive = true;
          throw err;
        }
        this.#consecutiveTimeouts = 0; // a live reply means the player is alive
        const response = JSON.stringify(raw);
        try {
          const decision = ctx.validate(raw);
          ctx.recordAttempt({ prompt: JSON.stringify(view), response, error: null });
          return decision;
        } catch (err) {
          // Legitimate control flow: a rejected candidate re-prompts the player
          // with the reason. We surface the reason, never swallow it.
          reason = err instanceof Error ? err.message : String(err);
          ctx.recordAttempt({ prompt: JSON.stringify(view), response, error: reason });
        }
      }
      throw new Error(`remote player (slot socket) failed ${MAX_ATTEMPTS} attempts: ${reason}`);
    } finally {
      // Charge this turn's wall-clock to the policy's bank (clamped at 0).
      if (this.#clockMs !== null) this.#bankMs = Math.max(0, this.#bankMs - (Date.now() - startedAt));
    }
  }

  /** Play the chess-clock "out of time" move for the seat: the game's
   *  `randomDecision` (a uniformly-random legal move) when it defines one, else its
   *  always-legal `baselineDecision`. `ctx.validate` (schema + dry-run apply)
   *  re-asserts legality; both seam moves are legal by contract, so this does not
   *  throw in practice. */
  #playRandom(ctx: DecideContext<State, Decision>): Decision {
    const out = ctx.game.randomDecision ?? ctx.game.baselineDecision;
    const candidate = out(ctx.state, ctx.seat);
    const decision = ctx.validate(candidate);
    ctx.recordAttempt({ prompt: "", response: JSON.stringify(candidate), error: "chess clock expired; playing fallback move" });
    return decision;
  }

  /** Open the socket once and reuse it across turns. */
  #ensureConnected(): Promise<WebSocket> {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) return Promise.resolve(this.#ws);
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.#url);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`remote player connect timed out after ${this.#connectTimeoutMs}ms`));
      }, this.#connectTimeoutMs);

      ws.on("open", () => {
        clearTimeout(timer);
        this.#ws = ws;
        resolve(ws);
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on("message", (data: Buffer) => this.#onMessage(data));
      ws.on("close", () => {
        this.#ws = null;
        this.#pending?.resolve(undefined);
        this.#pending = null;
      });
    });
  }

  /** Send one observation and await the player's reply (or a timeout). The wait is
   *  `timeoutMs` — the per-turn act-timeout, clamped down to the remaining chess-clock
   *  bank when a clock is set, so a single turn can't overrun the episode budget. */
  #request(ws: WebSocket, obs: ObservationMessage, timeoutMs: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending = null;
        reject(new Error(`remote player reply timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending = {
        id: obs.id,
        resolve: (decision) => {
          clearTimeout(timer);
          this.#pending = null;
          resolve(decision);
        },
      };
      ws.send(JSON.stringify(obs));
    });
  }

  /** Route an inbound reply to the awaiting request; ignore non-matching ids. The
   *  reply may carry cheap-talk lines — post them to the host bus (cheap talk is not
   *  tied to move legality, so it lands even if the decision is later rejected).
   *
   *  Inbound frames are UNTRUSTED player bytes, so validate-at-the-boundary rather
   *  than parse-and-throw: a frame that isn't JSON or isn't a `cogweb.player.v1`
   *  message (e.g. a player built for a game's pre-cogweb legacy wire) is logged and
   *  DROPPED — the pending request then times out, the consecutive-timeout breaker
   *  trips, and the runner falls back to the baseline. A thrown parse here would be
   *  an uncaught ws-event exception that kills the whole game host (exit 1), failing
   *  the episode for every seat because one player speaks garbage. */
  #onMessage(data: Buffer): void {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      console.error(`[remote-pilot] slot ${this.#slot}: dropping non-JSON player frame`);
      return;
    }
    const parsed = PlayerToGame.safeParse(json);
    if (!parsed.success) {
      console.error(`[remote-pilot] slot ${this.#slot}: dropping unrecognized player frame: ${parsed.error.message}`);
      return;
    }
    const msg = parsed.data;
    if (msg.type === "reply" && this.#pending && msg.id === this.#pending.id) {
      if (msg.messages.length > 0) this.#onTalk?.(this.#cur.seat, this.#cur.turn, msg.messages);
      this.#pending.resolve(msg.decision);
    }
  }

  /** Close the socket (call when the episode ends). */
  close(): void {
    this.#ws?.close();
    this.#ws = null;
  }
}
