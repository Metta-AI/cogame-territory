// The PLAYER side of the coworld player protocol: the entrypoint a player
// container runs to pilot one slot in an uploaded coworld. It is a websocket
// CLIENT of the game's `/player` server.
//
// It connects to COWORLD_PLAYER_WS_URL (already carrying ?slot=&token=), then:
//   - on `welcome`     records the slot + public config
//   - on `observation` calls the injected `decide(view, seat)` (the game's
//     baseline or an LLM decider) and sends the decision back as a `reply`
//     correlated by id; a re-request (reason set) just runs `decide` again
//   - on `final`       resolves the returned promise with the per-slot scores
//
// `decide` produces a Decision the game will validate; this runtime stays
// game-agnostic and only relays. The game's `GameModule` supplies the baseline
// via `module.game.baselineDecision`, so a no-LLM player is a one-liner.
import { WebSocket } from "ws";
import type { GameModule } from "@cogweb/core";
import { bedrockUsageTotals } from "@cogweb/llm";
import {
  parseGameToPlayer,
  type InboxMessage,
  type ReplyMessage,
  type TalkLine,
  type WelcomeMessage,
} from "./protocol";

/** Context handed to a player `decide` (and `talk`) for each observation. */
export interface PlayerDecideContext<State, Decision, View> {
  /** The seat's redacted view (already parsed from the wire). */
  view: View;
  seat: number;
  turn: number;
  /** The seat's visible inbox (public chatter + DMs to/from it), oldest first. A
   *  policy reads it to react to table talk; empty when the game has no comms. */
  messages: InboxMessage[];
  /** Set when the game rejected the prior decision and re-requested. */
  reason: string | null;
  /** Chess clock: this policy's REMAINING total thinking budget for the whole
   *  episode, in ms (the host decrements it by the time each turn takes). `null`
   *  when no chess clock is configured. A policy reads it to budget its compute; at
   *  0 the host plays random legal moves for the seat, so further thinking is moot. */
  timeLeftMs: number | null;
  /** Public episode config from the welcome frame. */
  config: unknown;
  /** The game module, e.g. for `module.game.baselineDecision`. */
  module: GameModule<State, Decision, View>;
}

export interface RunCoworldPlayerOpts<State, Decision, View> {
  module: GameModule<State, Decision, View>;
  /** Where to connect. Defaults to env COWORLD_PLAYER_WS_URL. */
  connect?: string;
  /** Decide a slot's move from its observation. May be async (LLM). */
  decide: (ctx: PlayerDecideContext<State, Decision, View>) => Decision | Promise<Decision>;
  /** Optional cheap-talk: 0+ lines to post alongside this turn's reply (the host
   *  routes them to the table). The inbox is `ctx.messages`; return [] to stay quiet.
   *  Gate it yourself (e.g. once per round) to avoid spamming every observation. */
  talk?: (ctx: PlayerDecideContext<State, Decision, View>) => TalkLine[] | Promise<TalkLine[]>;
}

/**
 * Run a player slot to completion. Resolves with the final per-slot scores when
 * the game sends `final`. The socket URL must already carry slot/token (the
 * game injects it as COWORLD_PLAYER_WS_URL).
 */
export function runCoworldPlayer<State, Decision, View>(
  opts: RunCoworldPlayerOpts<State, Decision, View>,
): Promise<number[]> {
  const url = opts.connect ?? process.env.COWORLD_PLAYER_WS_URL;
  if (!url) throw new Error("no player socket URL: pass `connect` or set COWORLD_PLAYER_WS_URL");

  return new Promise<number[]>((resolve, reject) => {
    const ws = new WebSocket(url);
    let welcome: WelcomeMessage | null = null;

    ws.on("error", reject);
    ws.on("message", (data: Buffer) => {
      const msg = parseGameToPlayer(JSON.parse(data.toString()));
      switch (msg.type) {
        case "welcome":
          welcome = msg;
          return;
        case "final":
          // Emit this player's own Bedrock token cost as a structured log line so
          // it's recoverable from the player log in the episode bundle (the player
          // process never writes the replay/results — the host does). Zeroed for a
          // scripted/no-LLM policy, which is itself the useful signal.
          console.log(JSON.stringify({ kind: "bedrock_usage", ...bedrockUsageTotals() }));
          resolve(msg.scores);
          ws.close();
          return;
        case "observation": {
          // The game never sends an observation before welcome; the redacted
          // view and config are typed at the game boundary, so cast through.
          const view = msg.view as View;
          const ctx: PlayerDecideContext<State, Decision, View> = {
            view,
            seat: msg.seat,
            turn: msg.turn,
            messages: msg.messages,
            reason: msg.reason,
            timeLeftMs: msg.timeLeftMs,
            config: welcome?.config,
            module: opts.module,
          };
          // Decide and (optionally) talk in parallel; the reply carries both, so a
          // cheap-talk pass never blocks the move past what the player itself takes.
          void Promise.all([
            Promise.resolve(opts.decide(ctx)),
            opts.talk ? Promise.resolve(opts.talk(ctx)) : Promise.resolve<TalkLine[]>([]),
          ]).then(([decision, messages]) => {
            const reply: ReplyMessage = { type: "reply", id: msg.id, decision, messages };
            ws.send(JSON.stringify(reply));
          }, reject);
          return;
        }
      }
    });
  });
}
