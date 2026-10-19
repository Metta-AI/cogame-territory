// Export complete native Territory games as hosted tool conversations.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { newGame, isFinished, scoreGame, stepTurn, endReason } from "../src/shared/engine/game.js";
import type { GameState, Variant } from "../src/shared/engine/types.js";
import { SubmissionSchema, type Submission } from "../src/shared/engine/orders.js";
import { rejectionReason } from "../src/shared/engine/resolve.js";
import { observe } from "../src/game/redact.js";
import { scriptedDecide } from "../src/game/scripted.js";
import { systemPrompt, renderObservation } from "../src/game/prompt.js";
import {
  promptSelectionSchema,
  selectedVariant,
  selectionMetadata,
} from "../src/game/prompt-selection.js";
import { promptMetadata } from "../src/game/prompt-evidence.js";

const [outputArg, episodesArg, variantArg, wording = "canonical", promptSeed] =
  process.argv.slice(2);
if (!outputArg || !episodesArg || !variantArg) {
  throw new Error(
    "usage: tsx tools/export-posttrain.ts OUTPUT EPISODES VARIANT [PROMPT_VARIANT] [PROMPT_SEED]",
  );
}
const output = resolve(outputArg);
const episodes = Number(episodesArg);
if (!Number.isInteger(episodes) || episodes < 10)
  throw new Error("at least ten games are required");
if (existsSync(output)) throw new Error(`output already exists: ${output}`);
const selection = promptSelectionSchema.parse({
  promptVariant: wording,
  ...(promptSeed !== undefined ? { promptSeed: Number(promptSeed) } : {}),
});
if (selectedVariant(selection).startsWith("heldout-"))
  throw new Error("held-out wording cannot enter training sources");
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim())
  throw new Error("Commit qualified source before exporting private candidates");
const manifest = JSON.parse(readFileSync("coworld_manifest_template.json", "utf8")) as {
  variants: Array<{ id: Variant; game_config: { num_agents: number; turns: number } }>;
};
const variant = variantArg as Variant;
const config = manifest.variants.find((entry) => entry.id === variant)?.game_config;
if (!config || config.num_agents !== 9) throw new Error(`unknown certified variant: ${variantArg}`);
mkdirSync(output, { mode: 0o700 });
const trajectories = resolve(output, "trajectories.jsonl");
writeFileSync(trajectories, "", { flag: "wx", mode: 0o600 });
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const runs: Array<{
  seed: number;
  turns: number;
  decisions: number;
  scores: number[];
  reason: string | null;
}> = [];

for (let seed = 1; seed <= episodes; seed++) {
  let state: GameState = newGame(seed, variant, config.turns);
  const family = `territory-${seed}`;
  const episode = `${family}-${variant}-${selectedVariant(selection)}-${selection.promptSeed}`;
  const rows: Array<Record<string, unknown>> = [];
  const latest = new Map<number, number>();
  while (!isFinished(state)) {
    const submissions: Record<number, Submission> = {};
    for (const seat of state.cogOrder) {
      if (state.cogs[seat]!.life === "eliminated") continue;
      const view = observe(state, seat);
      const baseline = (seed + seat) % 2 === 0 ? "homesteader" : "raider";
      const decision = SubmissionSchema.parse(scriptedDecide(baseline, view));
      if (rejectionReason(state, seat, decision.orders) !== null) {
        throw new Error(
          `scripted decision rejected at seed ${seed}, turn ${state.turn}, seat ${seat}`,
        );
      }
      const system = systemPrompt("", selection);
      const user = renderObservation(view);
      const messages = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
      const attempt = `${rows.length}-teacher`;
      latest.set(seat, rows.length);
      rows.push({
        schema_version: "1",
        event_type: "decision",
        episode_id: episode,
        decision_id: String(rows.length),
        decision_index: rows.length,
        game: "territory",
        game_version: `source-${revision}`,
        source_revision: revision,
        seat: String(seat),
        visibility: "private",
        observation: { ...view, prompt_template: promptMetadata(selection, system, user) },
        prompt: messages,
        attempts: [
          {
            attempt_id: attempt,
            policy: "scripted-homesteader-and-raider",
            origin: "teacher",
            inference_mode: "text_action",
            prompt: messages,
            request: null,
            platform_call_id: null,
            response: JSON.stringify(decision),
            parsed_action: decision,
            accepted: true,
            rejection_reason: null,
            behavior_logprobs: null,
          },
        ],
        selected_attempt_id: attempt,
        executed_action: decision,
        action_status: "accepted",
        fallback_origin: null,
        terminal: false,
      });
      submissions[seat] = decision;
    }
    state = stepTurn(state, submissions);
  }
  for (const index of latest.values()) rows[index]!.terminal = true;
  for (const row of rows) appendFileSync(trajectories, JSON.stringify(row) + "\n");
  const scores = scoreGame(state);
  const outcome = { scores, reason: endReason(state), turns: state.turnsPlayed };
  appendFileSync(
    trajectories,
    JSON.stringify({
      schema_version: "1",
      event_type: "episode",
      episode_id: episode,
      seed_family: family,
      game: "territory",
      game_version: `source-${revision}`,
      source_revision: revision,
      status: "completed",
      outcome,
      participant_outcomes: Object.fromEntries(
        scores.map((score, seat) => [String(seat), { score }]),
      ),
    }) + "\n",
  );
  runs.push({
    seed,
    turns: state.turnsPlayed,
    decisions: rows.length,
    scores: scoreGame(state),
    reason: endReason(state),
  });
}

writeFileSync(
  `${output}/manifest.json`,
  `${JSON.stringify(
    {
      schema_version: 1,
      game: "territory",
      variant,
      source_revision: revision,
      teacher: "homesteader-and-raider",
      prompt_configuration: selectionMetadata(selection),
      split_authority: "shared Coworld SDK and reviewed application importer by seed_family",
      runs,
    },
    null,
    2,
  )}\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(`complete private games=${episodes}`);
