// @cogweb/coworld — the Softmax coworld upload path: the manifest, the
// game-side remote-player runtime, the player-side runtime, and artifact IO.

// The published manifest model + builder.
export {
  buildManifest,
  CoworldManifest,
  GameSection,
  GameRunnable,
  PlayerRunnable,
  CommissionerRunnable,
  Runnable,
  RunnableResources,
  Variant,
  Certification,
  DocPage,
  ContentRef,
  JsonSchema,
} from "./manifest";
export type { BuildManifestOpts } from "./manifest";

// The player wire protocol shared by both runtimes.
export {
  PROTOCOL,
  GameToPlayer,
  PlayerToGame,
  WelcomeMessage,
  ObservationMessage,
  FinalMessage,
  ReplyMessage,
  InboxMessage,
  TalkLine,
  parseGameToPlayer,
  parsePlayerToGame,
} from "./protocol";

// The game side: a Pilot that drives a slot via an external player.
export { RemotePlayerPilot } from "./remote-pilot";
export type { RemotePlayerPilotOpts } from "./remote-pilot";

// The player side: run a slot policy against the game's /player server.
export { runCoworldPlayer } from "./player-runtime";
export type { RunCoworldPlayerOpts, PlayerDecideContext } from "./player-runtime";

// The standard LLM coworld player: a Bedrock policy driven by the game's
// Autopilot (the player-side counterpart of @cogweb/llm's LlmPilot).
export { runLlmCoworldPlayer, makeLlmCoworldDecide } from "./llm-player";
export type { LlmCoworldPlayerOpts } from "./llm-player";

// Artifact IO via COGAME_*_URI env vars.
export {
  readConfig,
  writeResults,
  writeReplay,
  hasReplayUri,
  CONFIG_URI_ENV,
  RESULTS_URI_ENV,
  REPLAY_URI_ENV,
} from "./artifacts";

// Headless policy-evaluation harness: deterministic local evals, no network.
export { runMatchup, comparePolicies } from "./eval";
export type { PilotFactory, MatchupResult, CompareResult } from "./eval";

// The coworld game-HOST: the generic `/player` bridge + lifecycle every game
// runs on the platform, plus replay-mode serving and the game-cli entrypoint. A
// game supplies its module, slot→seat mapping, results, and console; the host
// owns the rest.
export { runCoworldHost, runCoworldReplay, loadReplayFrames, runCoworldGameCli, findConsoleDir } from "./host";
export type {
  CoworldHostOpts,
  CoworldHostHandle,
  CoworldClient,
  MakeRemotePilot,
  ReplayServerHandle,
  CoworldGameCliOpts,
} from "./host";
