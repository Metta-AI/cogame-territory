// The lobby state machine: a roster of `maxPlayers` seats that humans claim,
// fill with bots, and steer (guidance/model/autopilot) before Start. It owns
// only roster + phase; the actual game loop lives in the GameRunner, which the
// lobby hands off to on start(). Generic over any GameModule — the lobby never
// touches game rules, only `module.game.{minPlayers,maxPlayers,id}`.

import type { LobbyState, SeatInfo, BotSpec, LobbyPhase } from "@cogweb/protocol";
import type { GameModule } from "./game";

/** A change subscriber; fired after every mutation with the fresh snapshot. */
export type LobbyListener = (state: LobbyState) => void;

export interface LobbyOptions {
  /** Stable id for this table; defaults to the game's id. */
  gameId?: string;
  /** The auto-advance max time (ms) the table opens with — the per-seat decision
   *  budget once auto-advance is on. Set from a server flag; default 30_000. */
  autoAdvanceMaxTimeMs?: number;
}

/** One seat's mutable roster row. `bot` is non-null exactly when an LLM pilots
 *  the seat: a `bot` kind, or a `human` kind with autopilot toggled on.
 *  `joinToken` is the seat's stable per-seat secret for building a join link;
 *  it is rotated whenever the seat is (re)opened. */
interface Seat {
  name: string;
  kind: SeatInfo["kind"];
  ready: boolean;
  connected: boolean;
  bot: BotSpec | null;
  joinToken: string;
}

/** Illegal lobby operations (seat out of range, joining a running table) throw
 *  this; the websocket layer reports it to the offending client without crashing
 *  the table. */
export class LobbyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LobbyError";
  }
}

export interface Lobby {
  readonly module: GameModule<unknown, unknown>;
  state(): LobbyState;
  subscribe(fn: LobbyListener): () => void;
  /** Claim a seat as a human. `seat` undefined picks the first open seat. A seat
   *  that someone already claimed requires the matching `token` (its `joinToken`,
   *  delivered via a per-seat join link); an operator "Sit" on an open seat needs
   *  no token. Mid-game (running/finished) the ONLY legal join is a token-proven
   *  RECLAIM of a human seat — how a session survives a reload/reconnect; it marks
   *  the seat connected again and keeps its running state. */
  join(name: string, seat?: number, token?: string): number;
  setReady(seat: number, ready: boolean): void;
  /** Fill a seat with an autopiloted bot on `model` (null = default model). */
  addBot(seat: number, model: string | null): void;
  setGuidance(seat: number, text: string): void;
  setModel(seat: number, model: string): void;
  setAutopilot(seat: number, on: boolean): void;
  /** Choose a per-game rule value (lobby phase only). `key` must be one of the
   *  game's declared ruleOptions and `value` one of that option's choices. */
  setRule(key: string, value: string): void;
  /** The chosen rule values, keyed by option key — seeded from the game's
   *  ruleOptions defaults. Read at start() and handed to `newGame`. */
  rules(): Record<string, string>;
  /** Rename the player in a seat (lobby phase only). The name rides into the game
   *  via the seat-names seam when the table starts. */
  setName(seat: number, name: string): void;
  setConnected(seat: number, connected: boolean): void;
  /** Pin the auto-advance clock on/off, overriding the human-derived default
   *  (which is off once a human is seated, on for an all-bot table). Lobby-phase
   *  config; the in-game toggle goes to the runner instead. */
  setAutoAdvance(on: boolean): void;
  /** Set the auto-advance max time (ms) — the per-seat decision budget. */
  setMaxTime(ms: number): void;
  /** The effective auto-advance config: the pinned value if an operator set one,
   *  else the human-derived default, plus the configured max time. Read at start()
   *  to seed the runner, and surfaced in {@link LobbyState.autoAdvance}. */
  autoAdvance(): { enabled: boolean; maxTimeMs: number };
  /** Live (running-game) seat control: take over a non-human seat to drive it by
   *  hand. Throws if the seat is held by a human (a player's seat can't be taken).
   *  Unlike join(), this is allowed mid-game. */
  takeControlLive(seat: number, name: string): void;
  /** Live (running-game): hand a seat back to an autopilot bot on `model` (null =
   *  default). Returns the bot spec the seat now runs, for building its pilot. */
  botControlLive(seat: number, model: string | null): BotSpec;
  /** Append one open seat with a fresh joinToken. No-op at `game.maxPlayers`. */
  addSeat(): void;
  /** Remove a seat and renumber the rest 0..n-1. No-op at `game.minPlayers`. */
  removeSeat(seat: number): void;
  /** Reset a seat to "open": drop any bot/occupant and rotate its joinToken. This
   *  is how a bot seat becomes joinable by a human, and how an occupant is kicked. */
  clearSeat(seat: number): void;
  /** Lock the roster and move to "running". */
  start(): void;
  /** Mark the run finished (called by the runner when the game ends). */
  finish(): void;
  /** Bump generation, clear the roster's run state, return to "lobby". */
  reset(): void;
  phase(): LobbyPhase;
  /** Per-seat bot specs for the seats an LLM/remote pilot drives, by seat index. */
  botSeats(): Map<number, BotSpec>;
}

export function createLobby(module: GameModule<unknown, unknown>, opts: LobbyOptions = {}): Lobby {
  const { game } = module;
  const gameId = opts.gameId ?? game.id;

  let generation = 0;
  let phase: LobbyPhase = "lobby";
  const listeners = new Set<LobbyListener>();

  // Auto-advance config. `maxTime` is operator/flag-set; `pinned` is the explicit
  // on/off override (null = use the default). The default is ON so the game always
  // keeps moving — a seat that doesn't act within `maxTime` gets a baseline move,
  // including a human's. A player who wants unlimited time toggles it off (pins it).
  let autoAdvanceMaxTimeMs = opts.autoAdvanceMaxTimeMs ?? 30_000;
  let autoAdvancePinned: boolean | null = null;
  const autoAdvanceEnabled = (): boolean => autoAdvancePinned ?? true;

  /** A fresh, empty seat carrying a brand-new per-seat join secret. */
  const openSeat = (): Seat => ({
    name: "",
    kind: "open",
    ready: false,
    connected: false,
    bot: null,
    joinToken: crypto.randomUUID(),
  });

  // The table opens at minPlayers seats; operators grow it toward maxPlayers with
  // addSeat. Each seat carries its own join token from the start.
  const seats: Seat[] = Array.from({ length: game.minPlayers }, openSeat);

  // Per-game rule values, seeded from the game's declared defaults. Like the
  // max-time knob these persist across reset() — an operator's table config.
  const ruleValues: Record<string, string> = {};
  for (const opt of game.ruleOptions ?? []) ruleValues[opt.key] = opt.default;

  const requireSeat = (seat: number): Seat => {
    const row = seats[seat];
    if (!row) throw new LobbyError(`no seat ${seat} (table seats 0..${seats.length - 1})`);
    return row;
  };

  const requireLobbyPhase = (op: string): void => {
    if (phase !== "lobby") throw new LobbyError(`cannot ${op} once the table is ${phase}`);
  };

  const snapshot = (): LobbyState => ({
    gameId,
    generation,
    phase,
    seats: seats.map((s, seat) => ({
      seat,
      name: s.name,
      kind: s.kind,
      ready: s.ready,
      connected: s.connected,
      bot: s.bot,
      joinToken: s.joinToken,
    })),
    autoAdvance: { enabled: autoAdvanceEnabled(), maxTimeMs: autoAdvanceMaxTimeMs },
    rules: { ...ruleValues },
  });

  const notify = (): void => {
    const snap = snapshot();
    for (const fn of listeners) fn(snap);
  };

  /** A default bot spec for a freshly-autopiloted seat. */
  const newBotSpec = (model: string | null): BotSpec => ({ model, guidance: "", autopilot: true });

  return {
    module,

    state: snapshot,

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    join(name, seat, token) {
      const idx = seat ?? seats.findIndex((s) => s.kind === "open");
      if (idx < 0) throw new LobbyError("no open seat");
      const row = requireSeat(idx);

      // Mid-game (running/finished): the only legal join is a RECLAIM of a human
      // seat by its owner, proven by the seat's stable join token — this is what
      // makes a session sticky across a reload/reconnect. The seat keeps its
      // running state (name/ready/pilot); we only mark it connected again and let
      // the caller rebind the socket. A bot/open seat is taken via takeControlLive,
      // never here.
      if (phase !== "lobby") {
        if (row.kind !== "human") throw new LobbyError(`seat ${idx} cannot be joined while ${phase}`);
        if (token !== row.joinToken) throw new LobbyError(`seat ${idx} reclaim requires its join token`);
        row.connected = true;
        notify();
        return idx;
      }

      // Lobby phase: an OPEN or BOT seat is claimable directly — a bot has no owner,
      // so any operator can take it over (the lobby-phase analogue of
      // takeControlLive). Only a HUMAN seat is protected: taking it over requires
      // that seat's join token (a per-seat join link or a sticky-session reclaim).
      if (row.kind === "human") {
        if (token !== row.joinToken) throw new LobbyError(`seat ${idx} is held by a player`);
      }
      row.kind = "human";
      row.name = name;
      // A human who has claimed a seat is ready by default (it's the operator or a
      // join-link arrival actively taking the seat); they can still be toggled.
      row.ready = true;
      row.connected = true;
      row.bot = null;
      notify();
      return idx;
    },

    setReady(seat, ready) {
      const row = requireSeat(seat);
      row.ready = ready;
      notify();
    },

    addBot(seat, model) {
      requireLobbyPhase("add a bot");
      const row = requireSeat(seat);
      row.kind = "bot";
      // A botted seat is a generic bot — it never carries the name of whoever (a
      // moved/kicked/departed human) used to sit there.
      row.name = `Bot ${seat}`;
      row.ready = true;
      row.bot = newBotSpec(model);
      notify();
    },

    setGuidance(seat, text) {
      const row = requireSeat(seat);
      if (!row.bot) throw new LobbyError(`seat ${seat} is not on autopilot`);
      row.bot = { ...row.bot, guidance: text };
      notify();
    },

    setModel(seat, model) {
      const row = requireSeat(seat);
      if (!row.bot) throw new LobbyError(`seat ${seat} is not on autopilot`);
      row.bot = { ...row.bot, model };
      notify();
    },

    setAutopilot(seat, on) {
      const row = requireSeat(seat);
      if (on) {
        // Turn autopilot on for this seat (human keeps its kind; bot stays a bot).
        row.bot = row.bot ? { ...row.bot, autopilot: true } : newBotSpec(null);
      } else {
        if (row.kind === "bot") throw new LobbyError(`seat ${seat} is a bot; it is always piloted`);
        row.bot = null;
      }
      notify();
    },

    setName(seat, name) {
      requireLobbyPhase("rename a seat");
      const row = requireSeat(seat);
      row.name = name;
      notify();
    },

    setRule(key, value) {
      requireLobbyPhase("set a rule");
      const opt = (game.ruleOptions ?? []).find((o) => o.key === key);
      if (!opt) throw new LobbyError(`unknown rule: ${key}`);
      if (!opt.choices.some((c) => c.value === value)) throw new LobbyError(`invalid value for rule ${key}: ${value}`);
      ruleValues[key] = value;
      notify();
    },

    rules() {
      return { ...ruleValues };
    },

    setConnected(seat, connected) {
      const row = requireSeat(seat);
      row.connected = connected;
      notify();
    },

    setAutoAdvance(on) {
      requireLobbyPhase("set auto-advance");
      autoAdvancePinned = on;
      notify();
    },

    setMaxTime(ms) {
      requireLobbyPhase("set the max time");
      autoAdvanceMaxTimeMs = ms;
      notify();
    },

    autoAdvance() {
      return { enabled: autoAdvanceEnabled(), maxTimeMs: autoAdvanceMaxTimeMs };
    },

    takeControlLive(seat, name) {
      const row = requireSeat(seat);
      if (row.kind === "human") throw new LobbyError(`seat ${seat} is held by a human and cannot be taken`);
      row.kind = "human";
      row.name = name;
      row.ready = true;
      row.connected = true;
      row.bot = null;
      notify();
    },

    botControlLive(seat, model) {
      const row = requireSeat(seat);
      const spec = newBotSpec(model);
      row.kind = "bot";
      row.name = row.name || `Bot ${seat}`;
      row.ready = true;
      row.bot = spec;
      notify();
      return spec;
    },

    addSeat() {
      requireLobbyPhase("add a seat");
      if (seats.length >= game.maxPlayers) return; // table is full; nothing to add
      seats.push(openSeat());
      notify();
    },

    removeSeat(seat) {
      requireLobbyPhase("remove a seat");
      if (seats.length <= game.minPlayers) return; // can't drop below the minimum
      requireSeat(seat); // validate the index before splicing
      seats.splice(seat, 1); // the remaining seats renumber 0..n-1 by their array index
      notify();
    },

    clearSeat(seat) {
      requireLobbyPhase("clear a seat");
      const row = requireSeat(seat);
      // Reopen the seat in place (keeping its index): drop any occupant/bot and
      // rotate the token so a stale link can't reclaim it.
      Object.assign(row, openSeat());
      notify();
    },

    start() {
      requireLobbyPhase("start");
      // Same gate the Start button uses (protocol.lobbyCanStart): every seat must
      // be filled (no "open") and ready, with at least minPlayers seats. An empty
      // or partially-filled table can never start.
      const open = seats.filter((s) => s.kind === "open").length;
      const unready = seats.filter((s) => s.kind !== "open" && !s.ready).length;
      if (seats.length < game.minPlayers || open > 0 || unready > 0) {
        throw new LobbyError(
          `cannot start: need ${game.minPlayers}+ seats, all filled and ready ` +
            `(${seats.length} seats, ${open} open, ${unready} not ready)`,
        );
      }
      phase = "running";
      notify();
    },

    finish() {
      phase = "finished";
      notify();
    },

    reset() {
      generation += 1;
      phase = "lobby";
      // New game = a fresh INITIAL lobby: back to minPlayers open seats with new
      // join tokens. The previous game's roster (and any grow/shrink) is cleared.
      seats.length = 0;
      for (let i = 0; i < game.minPlayers; i++) seats.push(openSeat());
      // Drop the auto-advance pin so the human-derived default applies to the fresh
      // table; keep the configured max time (an operator/flag choice that persists).
      autoAdvancePinned = null;
      notify();
    },

    phase() {
      return phase;
    },

    botSeats() {
      const out = new Map<number, BotSpec>();
      seats.forEach((s, seat) => {
        if (s.bot && s.bot.autopilot) out.set(seat, s.bot);
      });
      return out;
    },
  };
}
