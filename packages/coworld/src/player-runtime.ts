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
import type { ActAttempt } from "@cogweb/protocol";
import { WebSocket } from "ws";
import { recordAttemptSnapshot, type GameModule } from "@cogweb/core";
import { writePlayerTraceArtifact, type PlayerTraceRecord } from "./player-artifact";
import { llmUsageTotals } from "@cogweb/llm";
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
  signal: AbortSignal;
  playerSlot: number;
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
  recordAttempt(attempt: ActAttempt): void;
  markFallback(): void;
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
    const playerUrl = new URL(url);
    playerUrl.searchParams.set("artifact_ack", "1");
    playerUrl.searchParams.set("decision_cancel", "1");
    const ws = new WebSocket(playerUrl);
    let welcome: WelcomeMessage | null = null;
    const episodeController = new AbortController();
    let observationController = new AbortController();
    let activeObservationId: number | null = null;
    let sealed = false;
    let finishing = false;
    const pending = new Set<Promise<unknown>>();
    const trace: PlayerTraceRecord[] = [];
    const artifactUri = process.env.COWORLD_PLAYER_ARTIFACT_UPLOAD_URL;

    ws.on("error", reject);
    ws.on("message", (data: Buffer) => {
      const msg = parseGameToPlayer(JSON.parse(data.toString()));
      switch (msg.type) {
        case "cancel":
          if (msg.id === activeObservationId)
            observationController.abort(new Error("Game cancelled decision"));
          return;
        case "welcome":
          welcome = msg;
          return;
        case "final":
          // Emit this player's own Bedrock token cost as a structured log line so
          // it's recoverable from the player log in the episode bundle (the player
          // process never writes the replay/results — the host does). Zeroed for a
          // scripted/no-LLM policy, which is itself the useful signal.
          console.log(JSON.stringify({ kind: "llm_usage", ...llmUsageTotals() }));
          finishing = true;
          episodeController.abort(new Error("Episode finished"));
          void Promise.race([
            Promise.allSettled(pending),
            new Promise<void>((done) =>
              AbortSignal.timeout(1000).addEventListener("abort", () => done(), { once: true }),
            ),
          ])
            .then(() => {
              sealed = true;
              return artifactUri
                ? writePlayerTraceArtifact(artifactUri, welcome!.slot, trace, msg.scores)
                : Promise.resolve();
            })
            .then(
              () =>
                ws.send(JSON.stringify({ type: "artifact_complete" }), (error) => {
                  if (error) reject(error);
                  else resolve(msg.scores);
                  ws.close();
                }),
              reject,
            );
          return;
        case "observation": {
          observationController.abort(new Error("Observation superseded"));
          observationController = new AbortController();
          activeObservationId = msg.id;
          // The game never sends an observation before welcome; the redacted
          // view and config are typed at the game boundary, so cast through.
          const view = msg.view as View;
          const attempts: ActAttempt[] = [];
          const speechAttempts: ActAttempt[] = [];
          let usedFallback = false;
          const record: PlayerTraceRecord = {
            request: msg,
            response: {
              type: "failure",
              id: msg.id,
              error: "No applied action recorded",
              attempts: [],
              speechAttempts: [],
            },
          };
          if (artifactUri) trace.push(record);
          const assertOpen = () => {
            if (sealed) throw new Error("Player evidence is sealed");
          };
          const capture = (target: ActAttempt[], attempt: ActAttempt) => {
            assertOpen();
            recordAttemptSnapshot(target, attempt);
            record.response = {
              type: "failure",
              id: msg.id,
              error: "No applied action recorded",
              attempts: structuredClone(attempts),
              speechAttempts: structuredClone(speechAttempts),
            };
          };
          const sendRecorded = (response: ReplyMessage | import("./protocol").FailureMessage) => {
            assertOpen();
            record.response = structuredClone(response);
            if (!finishing) ws.send(JSON.stringify(response));
          };
          const ctx: PlayerDecideContext<State, Decision, View> = {
            signal: AbortSignal.any([
              episodeController.signal,
              observationController.signal,
              AbortSignal.timeout(30_000),
            ]),
            playerSlot: welcome!.slot,
            view,
            seat: msg.seat,
            turn: msg.turn,
            messages: msg.messages,
            reason: msg.reason,
            timeLeftMs: msg.timeLeftMs,
            config: welcome?.config,
            module: opts.module,
            recordAttempt: (attempt) => {
              capture(attempts, attempt);
            },
            markFallback: () => {
              assertOpen();
              usedFallback = true;
            },
          };
          // Decide and (optionally) talk in parallel; the reply carries both, so a
          // cheap-talk pass never blocks the move past what the player itself takes.
          const work = Promise.allSettled([
            Promise.resolve().then(() => opts.decide(ctx)),
            opts.talk
              ? Promise.resolve().then(() =>
                  opts.talk!({
                    ...ctx,
                    markFallback: () => {},
                    recordAttempt: (attempt) => {
                      capture(speechAttempts, attempt);
                    },
                  }),
                )
              : Promise.resolve<TalkLine[]>([]),
          ]).then(([action, speech]) => {
            if (ctx.signal.aborted) {
              sendRecorded({
                type: "failure",
                id: msg.id,
                error: String(ctx.signal.reason),
                attempts,
                speechAttempts,
              });
              return;
            }
            if (action.status === "rejected" || speech.status === "rejected") {
              const failure =
                action.status === "rejected"
                  ? action.reason
                  : speech.status === "rejected"
                    ? speech.reason
                    : undefined;
              sendRecorded({
                type: "failure",
                id: msg.id,
                error: String(failure),
                attempts,
                speechAttempts,
              });
              return;
            }
            const reply: ReplyMessage = {
              type: "reply",
              id: msg.id,
              decision: action.value,
              messages: speech.value,
              attempts,
              speechAttempts,
              usedFallback,
            };
            sendRecorded(reply);
          }, reject);
          pending.add(work);
          void work.then(
            () => pending.delete(work),
            () => pending.delete(work),
          );
          return;
        }
      }
    });
  });
}
