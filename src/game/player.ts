// The ONE player entrypoint, shipped in the SAME image as the game and selected
// by env — `dist-server/game/player.js`, shimmed as `/bin/territory-player`:
//
//   PLAYER_PROMPT=<doctrine>  (+ USE_BEDROCK=true)  LLM policy (Bedrock haiku)
//   PLAYER_SCRIPTED=homesteader | raider            that scripted baseline
//   PLAYER_JEV=1                                    Jev System One policy
//   neither set                                     homesteader
//
// The keyless default is deliberate: a CI/docker smoke with no credentials at all
// completes on the scripted baselines and never hangs.
//
// MODEL PINNING. The model is pinned to BEDROCK_MODEL exactly; the client's
// MODEL_CANDIDATES ladder is NOT used, because the sonnet rung times out on every
// sidecar call and one throttle then cascades into scripted fallbacks (raid round
// 2, 2026-08-23). Pinning is done by injecting a one-element profile lister, so
// discovery never runs and no other id is ever attempted.

import { argv, env } from "node:process";
import { fileURLToPath } from "node:url";

import { BedrockLlmClient, robustDecide } from "@cogweb/llm";
import { runCoworldPlayer } from "@cogweb/coworld";
import type { PlayerDecideContext } from "@cogweb/coworld";

import { SubmissionSchema } from "../shared/engine/orders.js";
import { makeJevDecide } from "./jev.js";
import { territoryModule } from "./game.js";
import type { TerritoryDecision, TerritorySeamState, TerritoryView } from "./game.js";
import type { TerritoryObservation } from "./redact.js";
import { renderObservation, SUBMIT_TURN_TOOL, systemPrompt } from "./prompt.js";
import { scriptedDecide } from "./scripted.js";

type Ctx = PlayerDecideContext<TerritorySeamState, TerritoryDecision, TerritoryView>;

/** Haiku 4.5. `maxTokens: 900` — 400 truncates ("cut off at max_tokens"). */
const DEFAULT_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const MAX_TOKENS = 900;
/** One retry, then the scripted move. Capped at one per seat per turn so nine
 *  seats stay under the Bedrock sidecar's 30 requests/minute per-episode cap. */
const MAX_ATTEMPTS = 2;

/** The scripted move for this seat, flagged so `results.fallbacks[seat]` counts it. */
const fallbackMove = (baseline: string, view: TerritoryObservation): TerritoryDecision => ({
  ...scriptedDecide(baseline, view),
  fallback: true,
});

/** The LLM policy: Bedrock haiku via `robustDecide`, the doctrine folded into the
 *  system prompt, the scripted baseline as the terminal fallback. */
export function makeLlmDecide(doctrine: string, baseline: string): (ctx: Ctx) => Promise<TerritoryDecision> {
  const model = env.BEDROCK_MODEL?.trim() || DEFAULT_MODEL;
  const client = new BedrockLlmClient({
    model,
    maxTokens: MAX_TOKENS,
    // Pin the model: one candidate, no discovery, no ladder.
    lister: () => Promise.resolve([model]),
  });
  const system = systemPrompt(doctrine);
  return async (ctx) => {
    const view = ctx.view as TerritoryObservation;
    let usedFallback = true;
    const decision = await robustDecide<TerritoryDecision>({
      client,
      system,
      renderUser: (rejection) => {
        const host = ctx.reason
          ? `\n\nThe game rejected your previous move: ${ctx.reason}. Choose a different legal move.`
          : "";
        return renderObservation(view) + host + (rejection ? `\n\n${rejection}` : "");
      },
      validate: (candidate) => {
        const parsed = SubmissionSchema.parse(candidate);
        usedFallback = false;
        return parsed;
      },
      baseline: () => fallbackMove(baseline, view),
      tool: SUBMIT_TURN_TOOL,
      recordAttempt: () => {},
      maxAttempts: MAX_ATTEMPTS,
    });
    if (usedFallback) {
      console.log(
        JSON.stringify({ kind: "player_fallback", seat: ctx.seat, turn: ctx.turn, baseline }),
      );
    }
    return decision;
  };
}

/** The scripted policy: a pure function of the view, no model, no network. */
export const makeScriptedDecide = (baseline: string) => (ctx: Ctx): TerritoryDecision =>
  scriptedDecide(baseline, ctx.view as TerritoryObservation);

/** Choose the policy from the environment and play the slot to `final`. */
export function run(): Promise<number[]> {
  const scripted = env.PLAYER_SCRIPTED?.trim();
  const prompt = env.PLAYER_PROMPT?.trim();
  // `USE_BEDROCK` gates the player pod's Bedrock sidecar on the platform; without
  // it a PLAYER_PROMPT seat would silently play scripted, invisibly to
  // results.fallbacks (cogolf, 2026-08-24). We honour a doctrine either way and
  // let robustDecide's terminal-credentials path degrade if there is no sidecar.
  const baseline = scripted && scripted !== "" ? scripted : "homesteader";
  if (env.PLAYER_JEV === "1") {
    console.log(`[territory-player] Jev policy (fallback ${baseline})`);
    return runCoworldPlayer<TerritorySeamState, TerritoryDecision, TerritoryView>({
      module: territoryModule,
      decide: makeJevDecide(baseline),
    });
  }
  if (prompt && !scripted) {
    console.log(`[territory-player] LLM policy (model ${env.BEDROCK_MODEL ?? DEFAULT_MODEL}, fallback ${baseline})`);
    return runCoworldPlayer<TerritorySeamState, TerritoryDecision, TerritoryView>({
      module: territoryModule,
      decide: makeLlmDecide(prompt, baseline),
    });
  }
  console.log(`[territory-player] scripted policy "${baseline}"`);
  return runCoworldPlayer<TerritorySeamState, TerritoryDecision, TerritoryView>({
    module: territoryModule,
    decide: makeScriptedDecide(baseline),
  });
}

// Run only when invoked as the entrypoint, not when imported by a test.
if (argv[1] === fileURLToPath(import.meta.url)) {
  await run();
}
