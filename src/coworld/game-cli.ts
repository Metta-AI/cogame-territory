/**
 * Coworld game-host entry. The platform launches this (manifest `gameRun`:
 * `node dist-server/coworld/game-cli.js`, shimmed as `/bin/territory`) with the
 * artifact URIs in the environment. The episode/replay dispatch and the frozen
 * platform env contract live in @cogweb/coworld's `runCoworldGameCli`; this file
 * binds Territory's config + host and the bounded shutdown linger.
 */
import { runCoworldGameCli } from "@cogweb/coworld";

import { SHUTDOWN_GRACE_MS } from "../shared/engine/constants.js";
import { coworldConfigSchema } from "./config.js";
import { runCoworldGame, runCoworldReplay } from "./server.js";

await runCoworldGameCli({
  name: "territory",
  configSchema: coworldConfigSchema,
  runGame: runCoworldGame,
  runReplay: runCoworldReplay,
  // `final` frames go out BEFORE the artifacts are written (so each player's
  // bedrock_usage line survives), then results + replay, then this bounded linger
  // during which /healthz, /client/* and /global keep answering, then exit 0.
  shutdownGraceMs: SHUTDOWN_GRACE_MS,
});
