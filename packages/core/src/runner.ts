// The live run loop, generic over any Game + a seat→Pilot map. Per pending
// actor it builds a DecideContext (whose validate() runs the game's schema then
// a dry-run applyDecision so a GameError surfaces as a re-promptable reason),
// asks the seat's pilot to decide, falls back to baselineDecision on
// throw/timeout, applies the decision for real, then broadcasts the resulting
// snapshot + events + status. Supports pause/resume and reset; the generation
// guard lets a reset abandon an in-flight loop cleanly.

import type {
  ServerMessage,
  FeedEvent,
  RunStatus,
  SeatStatus,
  Snapshot,
  ActAttempt,
  ActPromptWire,
  LobbyPhase,
} from "@cogweb/protocol";
import { GameError } from "./game";
import type { Game, GameModule, ApplyResult } from "./game";
import type { Pilot, DecideContext } from "./pilot";

export type RunMessageListener = (m: ServerMessage) => void;

// ── recorded-transcript caps ──────────────────────────────────────────────────
// Every `actPrompt` attempt is emitted as a replay frame, so every string on one
// is a string that reaches the replay and must be truncated ON RUNE BOUNDARIES (a
// byte- or UTF-16-boundary cut renders fine in a browser and fails a strict JSON
// parser). The caps are deliberately generous — they bound a pathological reply,
// a 1 MB note or a runaway error message, not a normal turn.
const PROMPT_CAP_RUNES = 16_000;
const RESPONSE_CAP_RUNES = 4_000;
const ERROR_CAP_RUNES = 500;

/** The first `cap` CODE POINTS of `s`, with `…` inside the cap when it was cut.
 *  Never splits a surrogate pair. */
function capRunes(s: string, cap: number): string {
  const runes = Array.from(s);
  if (runes.length <= cap) return s;
  return `${runes.slice(0, Math.max(0, cap - 1)).join("")}\u2026`;
}

/** One recorded attempt, with every field rune-capped for the replay. */
const capAttempt = (a: ActAttempt): ActAttempt => ({
  prompt: capRunes(a.prompt, PROMPT_CAP_RUNES),
  response: capRunes(a.response, RESPONSE_CAP_RUNES),
  error: a.error === null ? null : capRunes(a.error, ERROR_CAP_RUNES),
});

/** The unified live-advance policy. When `enabled`, a pending seat that does not
 *  decide within `maxTimeMs` is moved on with a `baselineDecision`; when disabled,
 *  the runner waits for the seat's pilot however long it takes (a human sets their
 *  own pace; a bot is still protected by its own LLM-layer timeout, which surfaces
 *  as a throw the runner already falls back on). Toggleable live via
 *  {@link GameRunner.setAutoAdvance}. */
export interface AutoAdvance {
  enabled: boolean;
  maxTimeMs: number;
}

export interface GameRunnerOptions {
  seed?: string;
  /** The lobby's chosen per-game rule values ({@link Game.ruleOptions}), handed
   *  to `newGame` on every deal (start and reset). Omitted = no rule knobs. */
  rules?: Record<string, string>;
  /** The generation this run is stamped with — the TABLE's generation (the lobby's),
   *  so the client (which keys snapshot freshness on the lobby generation) keeps the
   *  frames. A runner built after N resets must start at N, not 0, or every snapshot
   *  is dropped as stale and the board never renders. Defaults to 0 (fresh table). */
  generation?: number;
  /** The live-advance policy. Defaults to `{ enabled: true, maxTimeMs: 30_000 }`
   *  (an all-bot / headless game keeps moving and never hangs on a stalled seat). */
  autoAdvance?: AutoAdvance;
  /** Paces live games so spectators can watch; 0 = run flat out (tests). */
  stepDelayMs?: number;
  /**
   * SIMULTANEOUS games only ({@link Game.simultaneous}): a floor on the spacing
   * between batch STARTS, in ms. A turn costs `max(batch, this)`, so a fast batch
   * still leaves spectators time to read the board and the Bedrock sidecar's
   * per-episode request cap is respected. 0 (the default, and what the
   * certification fixture pins) adds no delay at all.
   */
  simultaneousPaceMs?: number;
  /**
   * SIMULTANEOUS games only: the episode wall-clock guard, in ms. After each
   * batch, if `elapsed + 2 × maxTimeMs` would exceed this the loop stops and
   * calls {@link Game.settleEarly}(state, "deadline") — so the episode settles
   * with artifacts written instead of overrunning the dispatch budget. Omit for
   * no guard.
   */
  episodeDeadlineMs?: number;
  /** Injectable clock, so a test can drive the deadline guard without waiting. */
  now?: () => number;
  /** Override the engine's open-phase ({@link Game.openPhase}) wall-clock budget.
   *  A deterministic/eval host (coworld) sets `0` to collapse the discussion window
   *  to an instant — no real wait — so episodes stay reproducible; the live hub
   *  omits it and uses the engine's value. */
  openPhaseTimeoutMs?: number;
  /** Notified when the game finishes (the lobby flips to "finished"). */
  onFinished?: (scores: Record<number, number>) => void;
}

/** The runner's view of one seat's pilot plus its operator guidance. */
export interface SeatPilot<State, Decision> {
  pilot: Pilot<State, Decision>;
  guidance: string;
  /** Surfaced in the autopilot transcript (actPrompt) so the UI shows the model. */
  model: string | null;
  /** The seat's display name from the lobby roster, fed to `newGame` so a game can
   *  use it as the agent's identity. "" when the seat has no human name. */
  name: string;
}

export class GameRunner<State, Decision> {
  readonly #game: Game<State, Decision>;
  readonly #pilots: Map<number, SeatPilot<State, Decision>>;
  readonly #listeners = new Set<RunMessageListener>();
  readonly #stepDelayMs: number;
  readonly #simultaneousPaceMs: number;
  readonly #episodeDeadlineMs: number | null;
  readonly #now: () => number;
  /** Epoch-ms the episode's first batch started, for the deadline guard. */
  #episodeStartedAt: number | null = null;
  /** True once {@link Game.settleEarly} stopped the episode on the wall clock. */
  #settledEarly = false;
  readonly #openPhaseTimeoutMs?: number;
  readonly #onFinished?: (scores: Record<number, number>) => void;
  /** The seed a host pinned (coworld league / deterministic eval), or undefined
   *  when none was pinned — in which case each game gets a fresh random seed. */
  readonly #pinnedSeed: string | undefined;
  /** The CURRENT game's seed; re-minted for each new game (see {@link #nextSeed}). */
  #seed: string;
  /** The lobby's chosen rule values, re-handed to `newGame` on every deal. */
  readonly #rules: Record<string, string> | undefined;

  /** The live-advance policy; `#autoAdvance` is mutable (live toggle). */
  #autoAdvance: boolean;
  #maxTimeMs: number;
  /** Epoch-ms the acting seat is on the clock until, or null when nobody is armed. */
  #deadline: number | null = null;
  /** The armed auto-advance timer + its trigger, for the seat currently deciding. */
  #advanceTimer: ReturnType<typeof setTimeout> | null = null;
  #fireAdvance: (() => void) | null = null;
  /** While the loop is parked in an open (timed, decision-free) phase: the wall-clock
   *  timer + the resolve that wakes the wait early (end, pause, or reset). */
  #openTimer: ReturnType<typeof setTimeout> | null = null;
  #openWaitResolve: (() => void) | null = null;
  /** The current open phase's wall-clock budget, so the window timer can be armed/
   *  disarmed live when auto-advance is toggled mid-discussion. */
  #openTimeoutMs = 0;
  /** Seats that marked themselves READY to end an open (timed) phase early. */
  #ready = new Set<number>();

  #state: State;
  #paused = false;
  /** Bumped on reset; a running loop exits once its captured generation is stale. */
  #generation = 0;
  /** The generation whose pilot intros have already been emitted, so a paused/
   *  resumed or restarted loop announces each seat exactly once per game. */
  #introducedGen = -1;
  /** Seats whose pilot is currently deciding (drives the UI spinner). */
  #thinking = new Set<number>();
  #loopPromise: Promise<void> | null = null;
  #resumeWaiters: Array<() => void> = [];
  /** Every feed event emitted this generation, in order — replayed (audience-
   *  filtered) to a client on connect so a late/reconnecting viewer sees the full
   *  log (e.g. a one-shot start-of-game persona announcement), not just live frames.
   *  Cleared on reset so a new game starts with an empty log. */
  #feedLog: FeedEvent[] = [];
  /** The latest full state at each turn this generation (mid-turn snapshots
   *  collapse to one entry per turn, mirroring the client timeline). Backfilled —
   *  redacted per seat — to a client on connect, so a viewer who joins or reloads
   *  mid-game gets the whole scrubber timeline, not just turns broadcast since it
   *  connected. Cleared on reset. */
  #stateByTurn = new Map<number, State>();

  constructor(module: GameModule<State, Decision>, pilots: Map<number, SeatPilot<State, Decision>>, opts: GameRunnerOptions = {}) {
    this.#game = module.game;
    this.#pilots = pilots;
    this.#generation = opts.generation ?? 0;
    this.#autoAdvance = opts.autoAdvance?.enabled ?? true;
    this.#maxTimeMs = opts.autoAdvance?.maxTimeMs ?? 30_000;
    this.#stepDelayMs = opts.stepDelayMs ?? 0;
    this.#simultaneousPaceMs = opts.simultaneousPaceMs ?? 0;
    this.#episodeDeadlineMs = opts.episodeDeadlineMs ?? null;
    this.#now = opts.now ?? (() => Date.now());
    this.#openPhaseTimeoutMs = opts.openPhaseTimeoutMs;
    this.#onFinished = opts.onFinished;
    this.#pinnedSeed = opts.seed;
    this.#rules = opts.rules;
    this.#seed = this.#nextSeed();
    this.#state = this.#game.newGame({ seed: this.#seed, playerCount: this.#pilots.size, seatNames: this.#seatNames(), rules: this.#rules });
  }

  /** The seed for the next game. A host that pinned a seed (coworld league /
   *  deterministic eval) gets that exact seed for every game, so its episodes and
   *  replays stay reproducible. With no pinned seed (the live hub — no game
   *  descriptor sets one) each game gets a FRESH random seed, so starting a new
   *  game (and every reset) deals a different board instead of re-dealing the
   *  constant default forever. */
  #nextSeed(): string {
    if (this.#pinnedSeed !== undefined) return this.#pinnedSeed;
    // Mint a high-entropy seed from a CSPRNG, NOT a 32-bit `Math.random()` value.
    // A game can derive hidden per-seat information (e.g. agricogla's dealt hands)
    // from the seed; a small/low-entropy seed lets a player brute-force the whole
    // space and match a candidate against their own visible cards to recover the
    // seed — and then everyone's hidden state. 128 bits makes that infeasible.
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** The seats' display names in seat order (0..n-1), fed to `newGame`. Pilots are
   *  keyed by their seat number, so sorting by key yields names indexed by seat. */
  #seatNames(): string[] {
    return [...this.#pilots.entries()].sort(([a], [b]) => a - b).map(([, p]) => p.name);
  }

  get state(): State {
    return this.#state;
  }

  get generation(): number {
    return this.#generation;
  }

  onMessage(cb: RunMessageListener): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  /** Swap a seat's pilot live (a human takes over a bot, or hands it back). The
   *  loop reads the pilot per turn, so the swap takes effect on the seat's next
   *  decision; a status frame is emitted at once so the roster indicator updates.
   *  The seat must already be one the runner drives (it was in the locked roster). */
  setSeatPilot(seat: number, seatPilot: SeatPilot<State, Decision>): void {
    if (!this.#pilots.has(seat)) throw new Error(`cannot swap pilot for unpiloted seat ${seat}`);
    this.#pilots.set(seat, seatPilot);
    this.#emit({ type: "status", status: this.status() });
  }

  /** Toggle the live auto-advance clock. Turning it ON while a seat is already on
   *  the clock arms that seat at once (deadline = now + maxTimeMs); turning it OFF
   *  disarms it so the table waits for the seat. A status frame broadcasts the new
   *  flag/deadline so the in-game toggle + countdown update immediately. */
  setAutoAdvance(on: boolean): void {
    if (this.#autoAdvance === on) return;
    this.#autoAdvance = on;
    // `#fireAdvance` is non-null only while a seat is mid-decide: arm/disarm that
    // in-flight wait so the toggle takes effect without waiting for the next turn.
    if (on) {
      if (this.#fireAdvance && this.#advanceTimer === null) this.#armAdvance();
      this.#armOpenTimer(); // start the discussion-window clock if one is parked
    } else {
      this.#disarmAdvance();
      this.#disarmOpenTimer(); // stop the window clock — wait for READY instead
    }
    this.#emit({ type: "status", status: this.status() });
  }

  /** Start the auto-advance countdown for the seat currently deciding. */
  #armAdvance(): void {
    if (this.#advanceTimer !== null) return;
    this.#deadline = Date.now() + this.#maxTimeMs;
    this.#advanceTimer = setTimeout(() => {
      this.#advanceTimer = null;
      this.#fireAdvance?.();
    }, this.#maxTimeMs);
  }

  /** Clear any armed countdown (toggled off, or the seat resolved). */
  #disarmAdvance(): void {
    if (this.#advanceTimer !== null) {
      clearTimeout(this.#advanceTimer);
      this.#advanceTimer = null;
    }
    this.#deadline = null;
  }

  #emit(m: ServerMessage): void {
    if (m.type === "event") this.#feedLog.push(m.event);
    for (const fn of this.#listeners) fn(m);
  }

  /** Record the current state by turn (latest wins — mid-turn emits collapse to
   *  one entry per turn) and broadcast the public snapshot. Every snapshot emit
   *  routes through here so the per-turn history that connect-time backfill
   *  replays stays complete. */
  #emitSnapshot(): void {
    this.#stateByTurn.set(this.#game.turnOf(this.#state), this.#state);
    this.#emit({ type: "snapshot", snapshot: this.snapshot() });
  }

  // ---- run state for newly-connected clients --------------------------------

  /** The feed events emitted so far this generation, for replay on connect. */
  feedLog(): readonly FeedEvent[] {
    return this.#feedLog;
  }

  /** The per-turn snapshot history this generation, redacted to `seat`, in turn
   *  order. Backfilled on connect so a viewer who joins (or reloads) mid-game gets
   *  the full scrubber timeline, not just the turns broadcast since it connected. */
  snapshotHistory(seat: number | null = null): Snapshot[] {
    return [...this.#stateByTurn.entries()]
      .sort(([a], [b]) => a - b)
      .map(([turn, state]) => ({ turn, generation: this.#generation, state: this.#game.redact(state, seat) }));
  }

  /** The public (seat=null) redacted snapshot at the current turn. */
  snapshot(seat: number | null = null): Snapshot {
    return {
      turn: this.#game.turnOf(this.#state),
      generation: this.#generation,
      state: this.#game.redact(this.#state, seat),
    };
  }

  status(): RunStatus {
    const finished = this.#game.isFinished(this.#state);
    const phase: LobbyPhase = finished ? "finished" : "running";
    return {
      phase,
      turn: this.#game.turnOf(this.#state),
      live: !this.#paused && !finished,
      thinking: [...this.#thinking].sort((a, b) => a - b),
      seatStatus: this.#seatStatus(finished),
      scores: stringKeyScores(this.#game.score(this.#state)),
      autoAdvance: this.#autoAdvance,
      maxTimeMs: this.#maxTimeMs,
      deadline: this.#deadline,
      ready: [...this.#ready].sort((a, b) => a - b),
    };
  }

  /** The per-seat run status for every piloted seat (the roster indicator). A
   *  finished game leaves every seat `waiting`; while running a seat is `thinking`
   *  when its pilot is composing, `acting` when it is a pending actor that has not
   *  begun, else `waiting`. */
  #seatStatus(finished: boolean): Record<string, SeatStatus> {
    const pending = finished ? new Set<number>() : new Set(this.#game.pendingActors(this.#state));
    const out: Record<string, SeatStatus> = {};
    for (const seat of this.#pilots.keys()) {
      out[String(seat)] = this.#thinking.has(seat) ? "thinking" : pending.has(seat) ? "acting" : "waiting";
    }
    return out;
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Begin (or resume) driving the loop. Idempotent: a second call returns the
   *  in-flight loop's promise rather than starting a second loop. */
  start(): Promise<void> {
    if (this.#loopPromise) return this.#loopPromise;
    this.#paused = false;
    this.#loopPromise = this.#run().finally(() => {
      this.#loopPromise = null;
    });
    return this.#loopPromise;
  }

  pause(): void {
    this.#paused = true;
    this.#wakeOpenWait();
    this.#emit({ type: "status", status: this.status() });
  }

  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#releaseWaiters();
    this.#emit({ type: "status", status: this.status() });
    void this.start();
  }

  /** Abandon the current game and deal a fresh one. The generation bump makes any
   *  in-flight loop exit at its next guard; a fresh "reset" frame tells clients to
   *  drop stale snapshots. */
  reset(): void {
    this.#generation += 1;
    this.#paused = false;
    this.#thinking.clear();
    this.#ready.clear();
    this.#feedLog = [];
    this.#stateByTurn.clear();
    this.#releaseWaiters();
    this.#wakeOpenWait();
    this.#seed = this.#nextSeed();
    this.#state = this.#game.newGame({ seed: this.#seed, playerCount: this.#pilots.size, seatNames: this.#seatNames(), rules: this.#rules });
    this.#emit({ type: "reset", generation: this.#generation });
    this.#emitSnapshot();
    this.#emit({ type: "status", status: this.status() });
  }

  #releaseWaiters(): void {
    const waiters = this.#resumeWaiters;
    this.#resumeWaiters = [];
    for (const w of waiters) w();
  }

  /** Park the loop while paused; wakes on resume or when its generation goes stale. */
  async #waitWhilePaused(gen: number): Promise<void> {
    while (this.#paused && gen === this.#generation) {
      await new Promise<void>((resolve) => this.#resumeWaiters.push(resolve));
    }
  }

  // ---- the loop -------------------------------------------------------------

  async #run(): Promise<void> {
    const gen = this.#generation;
    this.#emitSnapshot();
    this.#emit({ type: "status", status: this.status() });
    await this.#emitIntros(gen);
    if (gen !== this.#generation) return;

    while (!this.#game.isFinished(this.#state) && gen === this.#generation) {
      await this.#waitWhilePaused(gen);
      if (gen !== this.#generation) return;

      const pending = this.#game.pendingActors(this.#state);
      if (pending.length === 0) {
        const open = this.#game.openPhase?.(this.#state) ?? null;
        if (open && this.#game.advanceOpenPhase) {
          // A free-form timed phase (e.g. discussion): no seat owes a decision.
          // Wait the window (talk flows over the say channel), then advance. A
          // deterministic host pins the window to 0 to skip the wall-clock.
          await this.#runOpenPhase(this.#openPhaseTimeoutMs ?? open.timeoutMs, gen);
          continue;
        }
        // Between phases with nothing to decide: the engine resolves phases inside
        // applyDecision, so an empty pendingActors on an unfinished, non-open game
        // means a malformed game; stop.
        break;
      }

      if (this.#game.simultaneous) {
        if (await this.#runBatch(pending, gen)) return;
        continue;
      }

      for (const seat of pending) {
        if (gen !== this.#generation) return;
        await this.#driveSeat(seat, gen);
        if (gen !== this.#generation) return;
        this.#emitSnapshot();
        this.#emit({ type: "status", status: this.status() });
        if (this.#stepDelayMs > 0 && !this.#game.isFinished(this.#state)) {
          await new Promise((r) => setTimeout(r, this.#stepDelayMs));
        }
        if (this.#game.isFinished(this.#state)) break;
      }
    }
    if (gen === this.#generation && this.#game.isFinished(this.#state)) {
      const scores = this.#game.score(this.#state);
      this.#emit({ type: "status", status: this.status() });
      this.#onFinished?.(scores);
    }
  }

  /** True once the wall-clock guard settled the episode via `Game.settleEarly`. */
  get settledEarly(): boolean {
    return this.#settledEarly;
  }

  /**
   * SIMULTANEOUS turn: issue every pending seat's decision as ONE PARALLEL BATCH
   * against the identical pre-batch state, then apply the gathered decisions in
   * SEAT ORDER. Because `applyDecision` only buffers a seat's submission (and
   * steps the engine when the last seat's arrives), sequential application after a
   * parallel gather is exactly the engine's own simultaneity — and exactly one
   * engine step happens per turn.
   *
   * Then the pace floor, then the episode wall-clock guard. Returns true when the
   * caller should abandon the loop (its generation went stale).
   */
  async #runBatch(pending: number[], gen: number): Promise<boolean> {
    const stateAtTurn = this.#state;
    const startedAt = this.#now();
    if (this.#episodeStartedAt === null) this.#episodeStartedAt = startedAt;

    for (const seat of pending) {
      const sp = this.#pilots.get(seat);
      if (sp && sp.pilot.kind !== "human") this.#thinking.add(seat);
    }
    this.#emit({ type: "status", status: this.status() });

    // Every DecideContext is built against the SAME pre-batch state, so all nine
    // seats' dry-run validations see the identical board. Each decide is
    // individually guarded, so one seat that throws or never resolves degrades to
    // `baselineDecision` while the others are applied normally.
    const outcomes = await Promise.all(pending.map((seat) => this.#decideSeat(seat, stateAtTurn)));
    for (const seat of pending) this.#thinking.delete(seat);
    if (gen !== this.#generation) return true;

    for (const outcome of outcomes) {
      if (outcome.wire) this.#emit({ type: "actPrompt", actPrompt: outcome.wire });
      this.#apply(outcome.seat, outcome.decision);
      if (this.#game.isFinished(this.#state)) break;
    }
    this.#emitSnapshot();
    this.#emit({ type: "status", status: this.status() });
    if (this.#game.isFinished(this.#state)) return false;

    // Pace floor on the spacing between batch STARTS (0 adds no delay).
    const remaining = this.#simultaneousPaceMs - (this.#now() - startedAt);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    if (gen !== this.#generation) return true;

    // The episode wall-clock guard. `settleEarly` writes the reason into the state
    // so results + replay are still produced; a settle is never an overrun.
    if (this.#episodeDeadlineMs !== null && this.#game.settleEarly) {
      const spent = this.#now() - (this.#episodeStartedAt ?? startedAt);
      if (spent + 2 * this.#maxTimeMs > this.#episodeDeadlineMs) {
        this.#state = this.#game.settleEarly(this.#state, "deadline");
        this.#settledEarly = true;
        this.#emitSnapshot();
        this.#emit({ type: "status", status: this.status() });
      }
    }
    return false;
  }

  /** Ask one seat's pilot for a decision, bounded and never throwing: a reject or
   *  a silence past `maxTimeMs` resolves to `baselineDecision` for that seat only. */
  async #decideSeat(
    seat: number,
    stateAtTurn: State,
  ): Promise<{ seat: number; decision: Decision; wire: ActPromptWire | null }> {
    const seatPilot = this.#pilots.get(seat);
    if (!seatPilot) {
      return { seat, decision: this.#game.baselineDecision(stateAtTurn, seat), wire: null };
    }
    const attempts: ActAttempt[] = [];
    const ctx = this.#makeContext(seat, stateAtTurn, seatPilot.guidance, attempts);
    const timer: { id: ReturnType<typeof setTimeout> | null } = { id: null };
    let decision: Decision;
    let usedFallback = false;
    try {
      const decided = seatPilot.pilot.decide(ctx).then(
        (d) => ({ ok: true as const, d }),
        (e) => ({ ok: false as const, e }),
      );
      const guard = this.#autoAdvance
        ? new Promise<"advance">((resolve) => {
            timer.id = setTimeout(() => resolve("advance"), this.#maxTimeMs);
          })
        : null;
      const outcome = guard ? await Promise.race([decided, guard]) : await decided;
      if (outcome === "advance") {
        usedFallback = true;
        seatPilot.pilot.abort?.(seat);
        attempts.push(capAttempt({ prompt: "", response: "", error: `no reply within ${this.#maxTimeMs}ms; holding` }));
        decision = this.#game.baselineDecision(stateAtTurn, seat);
      } else if (outcome.ok) {
        decision = outcome.d;
      } else {
        usedFallback = true;
        attempts.push(capAttempt({ prompt: "", response: "", error: errorMessage(outcome.e) }));
        decision = this.#game.baselineDecision(stateAtTurn, seat);
      }
    } finally {
      if (timer.id !== null) clearTimeout(timer.id);
    }
    const wire: ActPromptWire | null =
      seatPilot.model !== null || attempts.length > 0
        ? {
            turn: this.#game.turnOf(stateAtTurn),
            seat,
            phase: null,
            attempts,
            usedFallback,
            model: seatPilot.model,
          }
        : null;
    return { seat, decision, wire };
  }

  /** Park the loop in a free-form timed phase: broadcast a countdown (via
   *  `status.deadline`), wait the window — or an early end / pause / reset that
   *  wakes it (see {@link #wakeOpenWait}) — then apply the engine's open-phase
   *  transition and broadcast the result. Talk happens out-of-band over the say
   *  channel, so the loop owns only the clock, not the conversation. */
  async #runOpenPhase(timeoutMs: number, gen: number): Promise<void> {
    this.#openTimeoutMs = timeoutMs;
    this.#deadline = null;
    const done = new Promise<void>((resolve) => {
      this.#openWaitResolve = resolve;
    });
    // The window's wall-clock timer runs ONLY when auto-advance is on; with it off
    // the table waits for every human seat to hit READY (no timer). Toggling
    // auto-advance mid-window arms/disarms this clock via setAutoAdvance.
    if (this.#autoAdvance) this.#armOpenTimer();
    this.#emit({ type: "status", status: this.status() });
    await done;
    this.#disarmOpenTimer();
    this.#openWaitResolve = null;
    this.#ready.clear(); // the window's ready set is per-phase
    // Woken by reset (stale gen) or pause: don't advance — let the loop re-evaluate.
    if (gen !== this.#generation || this.#paused) return;
    const turn = this.#game.turnOf(this.#state);
    const result = this.#game.advanceOpenPhase!(this.#state);
    this.#state = result.state;
    for (const ev of result.events ?? []) this.#emit({ type: "event", event: { ...ev, turn } });
    this.#emitSnapshot();
    this.#emit({ type: "status", status: this.status() });
  }

  /** Arm the discussion-window clock for a parked open phase (no-op if no open phase
   *  is parked, or the timer is already running). Firing resolves the parked wait. */
  #armOpenTimer(): void {
    if (this.#openWaitResolve === null || this.#openTimer !== null) return;
    this.#deadline = Date.now() + this.#openTimeoutMs;
    this.#openTimer = setTimeout(this.#openWaitResolve, this.#openTimeoutMs);
  }

  /** Stop the discussion-window clock without ending the phase — the wait continues
   *  (e.g. waiting for READY with auto-advance off). */
  #disarmOpenTimer(): void {
    if (this.#openTimer !== null) {
      clearTimeout(this.#openTimer);
      this.#openTimer = null;
    }
    this.#deadline = null;
  }

  /** Wake a parked open-phase wait (its timer, or end/pause/reset). The post-wait
   *  guard in {@link #runOpenPhase} decides whether to advance (a natural/early end)
   *  or bail (paused, or reset bumped the generation). */
  #wakeOpenWait(): void {
    if (this.#openTimer !== null) {
      clearTimeout(this.#openTimer);
      this.#openTimer = null;
    }
    const resolve = this.#openWaitResolve;
    this.#openWaitResolve = null;
    resolve?.();
  }

  /** End an in-progress open (timed) phase early — e.g. a human "call the vote".
   *  No-op when the loop is not parked in an open phase. */
  endOpenPhase(): void {
    this.#wakeOpenWait();
  }

  /** Apply a decision from OUTSIDE the pilot loop — the seam for a game whose
   *  moves happen in an EXTERNAL engine (e.g. cogtank's real-time Nim server).
   *  Such a game has no pendingActors, so the run loop exits immediately and the
   *  hosting wiring feeds room bindings / final results back through here. The
   *  candidate is validated against the game's decisionSchema, applied, and
   *  broadcast; a decision that finishes the game fires onFinished exactly like
   *  the loop does. Must only be used for games the loop is not driving. */
  applyServerDecision(seat: number, decision: unknown): void {
    const parsed = this.#game.decisionSchema(this.#state, seat).parse(decision);
    this.#apply(seat, parsed);
    this.#emitSnapshot();
    this.#emit({ type: "status", status: this.status() });
    if (this.#game.isFinished(this.#state)) this.#onFinished?.(this.#game.score(this.#state));
  }

  /** A seated human toggles READY during an open (timed) phase. When EVERY
   *  human-controlled seat is ready, end the window early (don't wait the clock).
   *  Broadcasts the ready set so the UI shows "N/M ready". No-op for an unpiloted
   *  seat; an all-bot table just runs the window to its timer. */
  setReady(seat: number, ready: boolean): void {
    if (!this.#pilots.has(seat)) return;
    if (ready) this.#ready.add(seat);
    else this.#ready.delete(seat);
    this.#emit({ type: "status", status: this.status() });
    if (this.#openWaitResolve) {
      const humans = [...this.#pilots.entries()].filter(([, p]) => p.pilot.kind === "human").map(([s]) => s);
      if (humans.length > 0 && humans.every((s) => this.#ready.has(s))) this.endOpenPhase();
    }
  }

  /** Emit each pilot's start-of-game intro once per generation (in parallel), in
   *  seat order, through the normal feed stream — so a seat-identity announcement
   *  (e.g. a generated persona) reaches live spectators and the recorded replay
   *  alike. A pilot with no `intro` (or one returning null) is silent. Intros are
   *  best-effort and must not throw; the runner does not guard them. */
  async #emitIntros(gen: number): Promise<void> {
    if (this.#introducedGen === gen) return;
    this.#introducedGen = gen;
    const turn = this.#game.turnOf(this.#state);
    const intros = await Promise.all(
      [...this.#pilots.entries()]
        .sort(([a], [b]) => a - b)
        .map(async ([seat, sp]) => await sp.pilot.intro?.(seat)),
    );
    if (gen !== this.#generation) return;
    for (const ev of intros) {
      if (ev) this.#emit({ type: "event", event: { ...ev, turn } });
    }
  }

  /** Ask `seat`'s pilot for a decision (validated), fall back to baseline on
   *  failure/timeout, then apply it and broadcast its events. */
  async #driveSeat(seat: number, gen: number): Promise<void> {
    const stateAtTurn = this.#state;

    // Re-drive loop: swapping a seat's pilot mid-decide (autopilot toggled onto a seat
    // whose turn is already pending) settles the in-flight decide via the old pilot's
    // cancel/abort. That rejection is a HANDOFF, not a failure — so when the registered
    // pilot has changed underneath us we re-drive THIS turn with the freshly-installed
    // pilot instead of burning the turn on baseline. Every other reject/timeout still
    // falls back. A swap installs a bot whose decide resolves, so the loop runs at most
    // one extra iteration per handoff.
    for (;;) {
      const seatPilot = this.#pilots.get(seat);
      if (!seatPilot) throw new Error(`no pilot registered for pending seat ${seat}`);

      const attempts: ActAttempt[] = [];
      const ctx = this.#makeContext(seat, stateAtTurn, seatPilot.guidance, attempts);

      // A human pilot is parked awaiting the player's input (it's their turn), not
      // composing a move — keep it OUT of #thinking so the roster shows "acting"
      // ("your turn"), not a thinking spinner. Bots compute on demand → "thinking".
      if (seatPilot.pilot.kind !== "human") this.#thinking.add(seat);
      // Park an auto-advance gate for this seat. It resolves to "advance" if the
      // countdown fires; `#fireAdvance` lets a live setAutoAdvance(true) arm an
      // already-waiting seat. The timer is only armed while auto-advance is on.
      const advanceGate = new Promise<"advance">((resolve) => {
        this.#fireAdvance = () => resolve("advance");
      });
      if (this.#autoAdvance) this.#armAdvance();
      this.#emit({ type: "status", status: this.status() });

      let decision: Decision;
      let usedFallback = false;
      try {
        // Race the pilot against the auto-advance countdown. A pilot throw/reject is
        // folded into the result (not a race rejection) so it's handled the same as a
        // timeout: fall back to an always-legal baseline so the game never stalls.
        const decided = seatPilot.pilot.decide(ctx).then(
          (d) => ({ ok: true as const, d }),
          (e) => ({ ok: false as const, e }),
        );
        const outcome = await Promise.race([decided, advanceGate]);
        if (outcome === "advance") {
          // The clock won: abandon the seat's in-flight decision and play baseline.
          usedFallback = true;
          seatPilot.pilot.abort?.(seat);
          decision = this.#game.baselineDecision(stateAtTurn, seat);
        } else if (outcome.ok) {
          decision = outcome.d;
        } else if (gen === this.#generation && this.#pilots.get(seat) !== seatPilot) {
          // The pilot was swapped live (handoff) — re-drive with the new pilot rather
          // than treating its cancel/abort as a failed move. The finally below settles
          // this iteration's gate/thinking before the loop restarts.
          continue;
        } else {
          usedFallback = true;
          attempts.push(capAttempt({ prompt: "", response: "", error: errorMessage(outcome.e) }));
          decision = this.#game.baselineDecision(stateAtTurn, seat);
        }
      } finally {
        this.#disarmAdvance();
        this.#fireAdvance = null;
        this.#thinking.delete(seat);
      }

      if (gen !== this.#generation) return;

      // Emit the autopilot transcript for piloted seats (model present) so the UI
      // can show what the model saw and decided.
      if (seatPilot.model !== null || attempts.length > 0) {
        const wire: ActPromptWire = {
          turn: this.#game.turnOf(stateAtTurn),
          seat,
          phase: null,
          attempts,
          usedFallback,
          model: seatPilot.model,
        };
        this.#emit({ type: "actPrompt", actPrompt: wire });
      }

      this.#apply(seat, decision);
      return;
    }
  }

  /** Apply an already-validated decision for real and broadcast its events,
   *  stamped with the turn the decision was MADE in (read before applying). A
   *  decision that ends the turn (e.g. a cognames guess that hits a bystander)
   *  advances `turnOf` as part of `applyDecision`; reading the turn afterwards
   *  would push that decision's own events into the NEXT turn, splitting them
   *  from the rest of the turn in the feed. The events belong to the turn they
   *  occurred in, which is the pre-apply turn. */
  #apply(seat: number, decision: Decision): void {
    const turn = this.#game.turnOf(this.#state);
    const result: ApplyResult<State> = this.#game.applyDecision(this.#state, seat, decision);
    this.#state = result.state;
    for (const ev of result.events ?? []) {
      const event: FeedEvent = { ...ev, turn };
      this.#emit({ type: "event", event });
    }
  }

  /** Build the DecideContext handed to a seat's pilot. Its validate() runs the
   *  game's decisionSchema then a dry-run applyDecision, so an illegal-but-typed
   *  move surfaces its GameError as a re-promptable reason — the single gate
   *  every pilot (LLM, remote, human) shares. */
  #makeContext(seat: number, state: State, guidance: string, attempts: ActAttempt[]): DecideContext<State, Decision> {
    const game = this.#game;
    return {
      game,
      state,
      seat,
      guidance,
      validate(candidate: unknown): Decision {
        // Schema first (throws ZodError on shape mismatch), then a dry-run apply
        // so an illegal-but-well-typed move surfaces its GameError reason. Both
        // are re-promptable: the pilot may catch and retry.
        const parsed = game.decisionSchema(state, seat).parse(candidate);
        try {
          game.applyDecision(state, seat, parsed);
        } catch (err) {
          if (err instanceof GameError) throw new Error(err.message);
          throw err;
        }
        return parsed;
      },
      recordAttempt(attempt: ActAttempt): void {
        // Rune-capped HERE, the single choke point every transcript passes on its
        // way to an `actPrompt` replay frame.
        attempts.push(capAttempt(attempt));
      },
    };
  }
}

/** Convert the engine's numeric-keyed scores to the wire's string-keyed record. */
function stringKeyScores(scores: Record<number, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [seat, value] of Object.entries(scores)) out[seat] = value;
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
