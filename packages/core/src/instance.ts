// Building one running game instance from a descriptor: lobby + per-instance
// wiring + websocket + seat-token gate. Shared by createGameServer (one pinned
// instance) and createHub (many), so the single- and multi-game servers can
// never drift in how they spin a game up.

import { createLobby } from "./lobby";
import type { Lobby } from "./lobby";
import { attachWebSocket } from "./websocket";
import type { MakeBotPilot, AttachedWebSocket } from "./websocket";
import type { GameModule } from "./game";
import type { ServerMessage } from "@cogweb/protocol";

/** The per-instance wiring a descriptor builds for each game it spins up: the
 *  bot-pilot factory and an optional server-message tap. Both may close over
 *  per-instance state (e.g. cogsul's MessageBus + talk cursor). */
export interface InstanceWiring<State = unknown, Decision = unknown> {
  /** Build a Pilot for each autopiloted/bot seat (LLM or remote). */
  makeBotPilot: MakeBotPilot<State, Decision>;
  /** Server-side tap on every outbound frame (e.g. to feed a MessageBus). */
  onServerMessage?: (m: ServerMessage) => void;
}

/** Handed to a descriptor's createWiring so its closures can reach the instance's
 *  lobby and (deferred) websocket — e.g. to say() on a seat's behalf at frame
 *  time, the multi-instance analog of the `let server` ref a single-game
 *  cli-serve.ts uses today. */
export interface InstanceContext {
  lobby: Lobby;
  /** The instance's attached ws. Assigned after the wiring is built, so only call
   *  it inside a frame-time closure (onServerMessage), never synchronously. */
  getWs: () => AttachedWebSocket;
}

/** A game type the hub (or a single-game server) can spin up instances of. This
 *  is the wiring that once lived inline in each game's cli-serve.ts, lifted out so
 *  the hub can host many games — and many instances of each — at once. */
export interface GameDescriptor<State = unknown, Decision = unknown> {
  /** URL/path segment + module identity, e.g. "cognames". */
  id: string;
  module: GameModule<State, Decision>;
  /** Build the per-instance wiring. Called once per instance, so per-game state
   *  (a MessageBus, a talk cursor) is isolated between concurrent games. */
  createWiring: (ctx: InstanceContext) => InstanceWiring<State, Decision>;
  runnerOptions?: { seed?: string; maxTimeMs?: number; stepDelayMs?: number };
  /** Gate per-seat state for an instance; defaults to deny-all. */
  verifySeatToken?: (lobby: Lobby, seat: number, token: string | undefined) => boolean;
  /** Built client dir for this game; served per-instance by the hub. */
  clientDir?: string;
}

/** One live game: its lobby, its websocket hub, and its seat-token gate. */
export interface RunningGameInstance {
  lobby: Lobby;
  ws: AttachedWebSocket;
  /** Seat-token gate bound to this instance's lobby (deny-all if the descriptor
   *  set none). */
  verifySeatToken: (seat: number, token: string | undefined) => boolean;
}

/** Spin up one game instance from a descriptor under the given lobby/game id. */
export function createInstance(descriptor: GameDescriptor, gameId: string): RunningGameInstance {
  const lobby = createLobby(descriptor.module as GameModule<unknown, unknown>, {
    gameId,
    autoAdvanceMaxTimeMs: descriptor.runnerOptions?.maxTimeMs,
  });
  // Deferred ws ref: the wiring's onServerMessage may say() on the just-built
  // socket — the multi-instance form of the `let server` ref a single-game
  // cli-serve uses.
  let ws!: AttachedWebSocket;
  const wiring = (descriptor.createWiring as (ctx: InstanceContext) => InstanceWiring<unknown, unknown>)({
    lobby,
    getWs: () => ws,
  });
  ws = attachWebSocket({
    lobby,
    makeBotPilot: wiring.makeBotPilot,
    runnerOptions: { seed: descriptor.runnerOptions?.seed, stepDelayMs: descriptor.runnerOptions?.stepDelayMs },
    onServerMessage: wiring.onServerMessage,
  });
  const verify = descriptor.verifySeatToken;
  return {
    lobby,
    ws,
    verifySeatToken: verify ? (seat, token) => verify(lobby, seat, token) : () => false,
  };
}
