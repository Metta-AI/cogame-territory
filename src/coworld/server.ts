/**
 * The Territory coworld game-host: a thin wrapper over @cogweb/coworld's
 * `runCoworldHost`. The shared host owns the `/player` bridge (one external
 * `RemotePlayerPilot` per seat), the spectator/replay feeds, artifact IO and the
 * lifecycle; this file supplies only Territory's module, results, `welcome`
 * config, console, and the wall-clock budget.
 *
 * DEGRADE, NEVER HANG. The game container does NOT receive
 * `COWORLD_TIMEOUT_SECONDS`, so every wait is bounded here:
 *   * connectDeadlineMs 45 s  — a player that never connects holds its seat.
 *   * actTimeoutMs      20 s  — that seat holds this turn; the other eight are
 *                               unaffected (the batch is a Promise.all of
 *                               individually-guarded decides).
 *   * simultaneousPaceMs      — the floor on batch spacing (cert pins 0).
 *   * episodeDeadlineMs 660 s — settle early with reason "deadline", artifacts
 *                               always written.
 *   * shutdownGraceMs   20 s  — see game-cli.ts.
 */
import { runCoworldHost, runCoworldReplay as runReplayHost, findConsoleDir } from "@cogweb/coworld";
import type { CoworldClient, CoworldHostHandle, ReplayServerHandle } from "@cogweb/coworld";

import { territoryModule } from "../game/game.js";
import type { TerritoryDecision, TerritorySeamState } from "../game/game.js";
import {
  ACT_TIMEOUT_MS,
  ALIASES,
  CONNECT_DEADLINE_MS,
  EPISODE_DEADLINE_MS,
  FLING_RANGE,
  RAZE_OPEN_TURN,
  SALVAGE_MULT,
  SEATS,
  TICKS_PER_TURN,
} from "../shared/engine/constants.js";
import { buildResults, territoryResultsSchema, type TerritoryResults } from "./results.js";
import { configPaceMs, configTurns, configVariant, type CoworldConfig } from "./config.js";

const client = (): CoworldClient => ({
  distDir: findConsoleDir(import.meta.url),
  title: "Territory",
  playerIndexFile: "index-agent.html",
});

export interface CoworldGameOptions {
  host?: string;
  port?: number;
  config: CoworldConfig;
}

export type CoworldGameHandle = CoworldHostHandle<TerritoryResults>;

/** Boot the Territory coworld game-host. */
export function runCoworldGame(opts: CoworldGameOptions): Promise<CoworldGameHandle> {
  const { config } = opts;
  const variant = configVariant(config);
  const turns = configTurns(config);
  return runCoworldHost<TerritorySeamState, TerritoryDecision, TerritoryResults>({
    module: territoryModule,
    tokens: config.tokens,
    // Roster/replay ONLY. `TerritoryGame.newGame` ignores seatNames outright, so
    // a platform-injected policy name can never reach a prompt.
    playerNames: config.players.map((p) => p.name),
    seed: config.seed,
    rules: { variant, turns: String(turns) },
    host: opts.host,
    port: opts.port,
    connectDeadlineMs: CONNECT_DEADLINE_MS,
    actTimeoutMs: ACT_TIMEOUT_MS,
    runner: {
      autoAdvance: { enabled: true, maxTimeMs: ACT_TIMEOUT_MS },
      simultaneousPaceMs: configPaceMs(config),
      episodeDeadlineMs: EPISODE_DEADLINE_MS,
    },
    welcomeConfig: () => ({
      seats: SEATS,
      turns,
      variant,
      ticksPerTurn: TICKS_PER_TURN,
      razeOpensTurn: RAZE_OPEN_TURN,
      flingRange: FLING_RANGE,
      aliases: ALIASES,
    }),
    results: {
      schema: territoryResultsSchema,
      build: (scores, state) => buildResults(scores, state.engine),
    },
    // The replay bytes are self-sufficient: everything the viewer needs rides in
    // the envelope, so the page contacts nothing but S3 for the file.
    replayMeta: (state, results) => ({
      players: state.engine.cogs.map((cog) => ({
        seat: cog.seat,
        alias: cog.alias,
        policy: config.players[cog.seat]?.name ?? `seat ${cog.seat}`,
        player: null,
      })),
      config: {
        seats: SEATS,
        turns,
        variant,
        seed: state.engine.seed,
        ticksPerTurn: TICKS_PER_TURN,
        razeOpensTurn: RAZE_OPEN_TURN,
        flingRange: FLING_RANGE,
        salvageMult: SALVAGE_MULT,
      },
      results,
    }),
    client: client(),
  });
}

/** Serve a recorded Territory episode (the platform's replay-render check). */
export function runCoworldReplay(opts: {
  loadReplayUri: string;
  host?: string;
  port?: number;
}): Promise<ReplayServerHandle> {
  return runReplayHost({ ...opts, client: client() });
}
