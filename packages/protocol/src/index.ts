// @cogweb/protocol — the game-agnostic wire contract shared by every cogame.
//
// The client net-glue, scrubber, feed, and autopilot UI all speak ONLY these
// types. Game-specific state rides inside `Snapshot.state` and `FeedEvent.data`
// as opaque JSON that each game validates at its own boundary. This is what
// lets one `useFeedStore` / `<Scrubber>` / `<EventFeed>` serve every game.

import { z } from "zod";

// The shared seeded PRNG every game deals from. Not a wire type, but it belongs in
// this dependency-light, browser-safe foundation package so every game shares ONE
// generator — its 128-bit state is what keeps a seed-derived deal unguessable. See
// rng.ts for the full security rationale and docs/SEEDING.md.
export * from "./rng";

// ---------------------------------------------------------------------------
// Identifiers & enums
// ---------------------------------------------------------------------------

/** 0-based seat index within a game. */
export type Seat = number;

export const PlayerKind = z.enum(["human", "bot", "open"]);
export type PlayerKind = z.infer<typeof PlayerKind>;

export const LobbyPhase = z.enum(["lobby", "running", "finished"]);
export type LobbyPhase = z.infer<typeof LobbyPhase>;

/** The live, per-seat status every game surfaces (ported from cognames' per-player
 *  tabs). It folds the lobby roster row and the run loop into one enum so a roster
 *  card / lobby seat row can render a single indicator across both phases:
 *  - `open`         — no one is in the seat.
 *  - `disconnected` — a human seat whose socket dropped (still held in the lobby).
 *  - `joined`       — seated in the lobby but not yet ready.
 *  - `ready`        — seated and ready (bots are always ready).
 *  - `waiting`      — a running game, but it is not this seat's turn.
 *  - `acting`       — a running game, this seat is up but its pilot has not begun
 *                     (a human owes input, or a bot is queued behind another seat).
 *  - `thinking`     — a running game, this seat's autopilot is composing its move. */
export const SeatStatus = z.enum([
  "open",
  "disconnected",
  "joined",
  "ready",
  "waiting",
  "acting",
  "thinking",
]);
export type SeatStatus = z.infer<typeof SeatStatus>;

/** Audience for a message/event: everyone, or an explicit list of seats. */
export const Audience = z.union([z.literal("public"), z.array(z.number().int())]);
export type Audience = z.infer<typeof Audience>;

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

export const BotSpec = z.object({
  model: z.string().nullable(),
  guidance: z.string().default(""),
  autopilot: z.boolean().default(true),
});
export type BotSpec = z.infer<typeof BotSpec>;

/** One declarative per-game rule knob: a closed set of string choices with a
 *  default, rendered by the shared configure screen as a <select>. A game
 *  declares its knobs (`Game.ruleOptions`); the lobby owns the CHOSEN values
 *  ({@link LobbyState.rules}) and hands them to `newGame` when the table starts. */
export const RuleOption = z.object({
  key: z.string(),
  label: z.string(),
  choices: z.array(z.object({ value: z.string(), label: z.string() })),
  default: z.string(),
});
export type RuleOption = z.infer<typeof RuleOption>;

export const SeatInfo = z.object({
  seat: z.number().int(),
  name: z.string(),
  kind: PlayerKind,
  ready: z.boolean(),
  connected: z.boolean(),
  /** Present iff this seat is piloted by an LLM (kind === "bot" or human autopilot). */
  bot: BotSpec.nullable(),
  /** Stable per-seat secret used to build a join link for that seat. A human
   *  arriving via `${baseUrl}/?seat=${seat}&token=${joinToken}` presents it on
   *  `join` to claim a seat someone else has already claimed; rotated whenever the
   *  seat is reopened (clearSeat / reset). */
  joinToken: z.string(),
});
export type SeatInfo = z.infer<typeof SeatInfo>;

export const LobbyState = z.object({
  gameId: z.string(),
  /** Bumps on every reset so clients can drop stale frames. */
  generation: z.number().int(),
  phase: LobbyPhase,
  seats: z.array(SeatInfo),
  /** Pre-game auto-advance config the lobby owns: whether the live clock will run
   *  (default off once a human is seated, on for an all-bot table) and the per-seat
   *  max time in ms. Settable in the lobby (or via a server flag); the in-game
   *  on/off toggle rides {@link RunStatus.autoAdvance} once the game is running. */
  autoAdvance: z.object({ enabled: z.boolean(), maxTimeMs: z.number() }),
  /** The chosen per-game rule values, keyed by {@link RuleOption.key} — seeded
   *  from the game's declared defaults, settable in the lobby via `setRule`, and
   *  handed to `newGame` at start. Empty for a game with no rule options. */
  rules: z.record(z.string(), z.string()),
});
export type LobbyState = z.infer<typeof LobbyState>;

// ---------------------------------------------------------------------------
// Feed / replay protocol (game state is opaque)
// ---------------------------------------------------------------------------

/** One immutable point on the timeline. `state` is the redacted, game-specific view. */
export const Snapshot = z.object({
  turn: z.number().int(),
  generation: z.number().int(),
  state: z.unknown(),
});
export type Snapshot = z.infer<typeof Snapshot>;

/** A message or game event for the feed. `kind` and `data` are game-defined. */
export const FeedEvent = z.object({
  turn: z.number().int(),
  seat: z.number().int().nullable(),
  kind: z.string(),
  text: z.string(),
  to: Audience.default("public"),
  data: z.unknown().optional(),
});
export type FeedEvent = z.infer<typeof FeedEvent>;

// ---------------------------------------------------------------------------
// Autopilot transcript ("what the model saw & decided")
// ---------------------------------------------------------------------------

export const ActAttempt = z.object({
  prompt: z.string(),
  response: z.string(),
  /** Rejection reason if this attempt was illegal/unparseable, else null. */
  error: z.string().nullable(),
});
export type ActAttempt = z.infer<typeof ActAttempt>;

export const ActPromptWire = z.object({
  turn: z.number().int(),
  seat: z.number().int(),
  phase: z.string().nullable(),
  attempts: z.array(ActAttempt),
  usedFallback: z.boolean(),
  model: z.string().nullable(),
});
export type ActPromptWire = z.infer<typeof ActPromptWire>;

// ---------------------------------------------------------------------------
// Run status
// ---------------------------------------------------------------------------

export const RunStatus = z.object({
  phase: LobbyPhase,
  turn: z.number().int(),
  live: z.boolean(),
  /** Seats whose autopilot is currently thinking (drives the UI spinner). */
  thinking: z.array(z.number().int()),
  /** Richer per-seat run status, keyed by seat: `waiting` / `acting` / `thinking`
   *  for an active game, so the roster shows who the table is waiting on. Pre-game
   *  the map is empty and the lobby roster (SeatInfo) drives the indicator. */
  seatStatus: z.record(z.string(), SeatStatus),
  scores: z.record(z.string(), z.number()).nullable(),
  /** Whether the live auto-advance clock is running: a pending seat that does not
   *  decide within `maxTimeMs` is moved on with a baseline move. Defaults off once
   *  a human is seated; an operator can toggle it live. */
  autoAdvance: z.boolean(),
  /** The auto-advance cap in ms (each seat's decision budget while enabled). */
  maxTimeMs: z.number(),
  /** Epoch-ms when the acting seat will be auto-advanced, or null when auto-advance
   *  is off / no seat is currently on the clock. Drives the in-game countdown. */
  deadline: z.number().nullable(),
  /** During a free-form timed phase (a discussion window), the seats that have
   *  marked themselves READY to advance early. Empty otherwise. When every
   *  human-controlled seat is ready the runner ends the window before the timer. */
  ready: z.array(z.number().int()),
});
export type RunStatus = z.infer<typeof RunStatus>;

/** Fold a lobby seat row into its {@link SeatStatus} for the indicator. Used pre-game
 *  (lobby phase) where there is no run status yet; once a game is running the
 *  runner's `seatStatus` map takes over for the seats it drives. */
export function lobbySeatStatus(seat: SeatInfo): SeatStatus {
  if (seat.kind === "open") return "open";
  if (seat.kind === "human" && !seat.connected) return "disconnected";
  return seat.ready ? "ready" : "joined";
}

/** The single indicator a roster card / lobby seat row renders: the runner's live
 *  per-seat status while a game is running, falling back to the lobby roster row
 *  otherwise. This is the game-agnostic "thinking vs ready" surface. */
export function seatStatusOf(seat: SeatInfo, run: RunStatus | null): SeatStatus {
  // An empty seat is never "thinking"/"up": a stale run status must never paint
  // an open seat with the previous game's per-seat state.
  if (seat.kind === "open") return "open";
  const live = run?.seatStatus[String(seat.seat)];
  if (live) return live;
  return lobbySeatStatus(seat);
}

/** Who is really driving a seat, for the SeatBar's human/bot indicator: "open"
 *  (empty), "bot" (an autopilot drives it), or "human" (a connected person is at
 *  it). A seat reads as a bot when it carries an autopilot spec OR when it is a
 *  human seat with NO live player connected — with auto-advance on, an unattended
 *  human seat is auto-piloted by the engine, so showing 🧑 would imply a person is
 *  playing when none is. The single source of truth a game's `pilotOf` should use. */
export function seatPilotKind(seat: SeatInfo): "open" | "human" | "bot" {
  if (seat.kind === "open") return "open";
  if (seat.bot) return "bot";
  if (seat.kind === "human" && !seat.connected) return "bot";
  return "human";
}

/** Whether the table may start: at least `minPlayers` seats, every seat filled
 *  (no "open"), and every seat ready. The single gate shared by the Start
 *  control (`@cogweb/ui`) and the server-side `lobby.start()`, so an empty or
 *  partially-filled table can never start and a full, ready one always can. */
export function lobbyCanStart(lobby: LobbyState, minPlayers: number): boolean {
  return (
    lobby.seats.length >= minPlayers &&
    lobby.seats.every((s) => s.kind !== "open" && s.ready)
  );
}

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot: Snapshot }),
  z.object({ type: z.literal("event"), event: FeedEvent }),
  z.object({ type: z.literal("status"), status: RunStatus }),
  z.object({ type: z.literal("actPrompt"), actPrompt: ActPromptWire }),
  z.object({ type: z.literal("lobby"), lobby: LobbyState }),
  z.object({ type: z.literal("reset"), generation: z.number().int() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** The versioned replay artifact written by the coworld host. It contains the
 *  exact public frame stream consumed by the live browser, so replay viewers can
 *  validate and reduce it without reimplementing game behavior. */
export const ReplayArtifact = z
  .object({
    protocol: z.literal("cogweb.replay.v1"),
    frames: z.array(ServerMessage).min(1),
  })
  .passthrough();
export type ReplayArtifact = z.infer<typeof ReplayArtifact>;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const ClientMessage = z.discriminatedUnion("type", [
  // A human claims a seat. `seat` null picks the first open seat. `token` is the
  // seat's `joinToken`, presented when arriving via a per-seat join link to claim
  // a seat someone else already holds; an operator "Sit" on an open seat omits it.
  z.object({
    type: z.literal("join"),
    name: z.string(),
    seat: z.number().int().nullable(),
    token: z.string().optional(),
  }),
  z.object({ type: z.literal("setReady"), ready: z.boolean() }),
  z.object({ type: z.literal("addBot"), seat: z.number().int(), model: z.string().nullable() }),
  z.object({ type: z.literal("setGuidance"), seat: z.number().int(), guidance: z.string() }),
  z.object({ type: z.literal("setModel"), seat: z.number().int(), model: z.string() }),
  z.object({ type: z.literal("setAutopilot"), seat: z.number().int(), on: z.boolean() }),
  // Rename the player in a seat (lobby phase). Edits the roster's display name for
  // a human or bot seat; the name rides into the game via the seat-names seam.
  z.object({ type: z.literal("setName"), seat: z.number().int(), name: z.string() }),
  // Toggle the live auto-advance clock. Pre-game it pins the lobby's default
  // (overriding the human-derived off); mid-game it arms/disarms the runner so the
  // table can switch between "wait for me" and "keep moving" without a reset.
  z.object({ type: z.literal("setAutoAdvance"), on: z.boolean() }),
  // Set the auto-advance max time (ms) before a seat is moved on. Lobby-only —
  // configured pre-game (or via a server flag); it is not changed mid-game.
  z.object({ type: z.literal("setMaxTime"), ms: z.number().int().positive() }),
  // Live seat control during a RUNNING game: take over a bot (or open) seat to
  // drive it by hand, or hand a seat back to an autopilot. A seat another human
  // holds can never be taken. `name` is the taker's display name (the client
  // sources it from the persisted viewer identity); it labels the seat while held.
  z.object({ type: z.literal("takeControl"), seat: z.number().int(), name: z.string() }),
  z.object({ type: z.literal("releaseControl"), seat: z.number().int() }),
  // Dynamic seat management (lobby phase only): grow/shrink the roster and reopen
  // a seat. `clearSeat` empties a seat back to "open" — turning a bot seat into a
  // joinable human one, or kicking an occupant.
  z.object({ type: z.literal("addSeat") }),
  z.object({ type: z.literal("removeSeat"), seat: z.number().int() }),
  z.object({ type: z.literal("clearSeat"), seat: z.number().int() }),
  // Choose a per-game rule value (lobby phase only). `key` must be one of the
  // game's declared RuleOption keys and `value` one of that option's choices.
  z.object({ type: z.literal("setRule"), key: z.string(), value: z.string() }),
  z.object({ type: z.literal("start") }),
  // Return the table to the lobby (tears down the running game; clients on the
  // shared portal redirect back to it).
  z.object({ type: z.literal("reset") }),
  // Replay the SAME table in place: re-deal a fresh game with the same seats and
  // keep running, without bouncing players back to the lobby. The post-game
  // "Play again" / "New game" button.
  z.object({ type: z.literal("rematch") }),
  // Game-specific decision payload, validated by the game's decisionSchema.
  z.object({ type: z.literal("decision"), decision: z.unknown() }),
  // Async cheap-talk: a seated player posts a chat message at ANY time, not as a
  // turn decision (so a game can drop a discrete "talk" phase and let players talk
  // freely). `to` is "public" (everyone) or a seat list for a DM; the server posts
  // it as a `talk` FeedEvent the instant it arrives, redacted to the audience.
  z.object({ type: z.literal("say"), text: z.string().min(1).max(2000), to: Audience.default("public") }),
  // A seated player toggles READY during a free-form timed phase (a discussion
  // window). When every human-controlled seat is ready the runner ends the window
  // early instead of waiting out the clock.
  z.object({ type: z.literal("ready"), ready: z.boolean() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export function parseServerMessage(raw: unknown): ServerMessage {
  return ServerMessage.parse(raw);
}

export function parseClientMessage(raw: unknown): ClientMessage {
  return ClientMessage.parse(raw);
}
