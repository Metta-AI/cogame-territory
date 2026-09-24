// Export complete native Territory games as hosted tool conversations.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { newGame, isFinished, scoreGame, stepTurn, endReason } from "../src/shared/engine/game.js";
import type { GameState, Variant } from "../src/shared/engine/types.js";
import { SubmissionSchema, type Submission } from "../src/shared/engine/orders.js";
import { rejectionReason } from "../src/shared/engine/resolve.js";
import { observe } from "../src/game/redact.js";
import { scriptedDecide } from "../src/game/scripted.js";
import { SYSTEM_PROMPT, renderObservation } from "../src/game/prompt.js";

const [outputArg, episodesArg, variantArg] = process.argv.slice(2);
if (!outputArg || !episodesArg || !variantArg) {
  throw new Error("usage: tsx tools/export-posttrain.ts OUTPUT EPISODES VARIANT");
}
const output = resolve(outputArg);
const episodes = Number(episodesArg);
if (!Number.isInteger(episodes) || episodes < 10) throw new Error("at least ten games are required");
if (existsSync(output)) throw new Error(`output already exists: ${output}`);
const manifest = JSON.parse(readFileSync("coworld_manifest_template.json", "utf8")) as {
  variants: Array<{ id: Variant; game_config: { num_agents: number; turns: number } }>;
};
const variant = variantArg as Variant;
const config = manifest.variants.find((entry) => entry.id === variant)?.game_config;
if (!config || config.num_agents !== 9) throw new Error(`unknown certified variant: ${variantArg}`);
mkdirSync(output);
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const trainRows: string[] = [];
const validationRows: string[] = [];
const runs: Array<{ seed: number; turns: number; decisions: number; scores: number[]; reason: string | null }> = [];

for (let seed = 1; seed <= episodes; seed++) {
  let state: GameState = newGame(seed, variant, config.turns);
  const rows: string[] = [];
  while (!isFinished(state)) {
    const submissions: Record<number, Submission> = {};
    for (const seat of state.cogOrder) {
      if (state.cogs[seat]!.life === "eliminated") continue;
      const view = observe(state, seat);
      const baseline = (seed + seat) % 2 === 0 ? "homesteader" : "raider";
      const decision = SubmissionSchema.parse(scriptedDecide(baseline, view));
      if (rejectionReason(state, seat, decision.orders) !== null) {
        throw new Error(`scripted decision rejected at seed ${seed}, turn ${state.turn}, seat ${seat}`);
      }
      rows.push(JSON.stringify({
        episode_id: `territory-${variant}-${seed}`,
        seed: `territory-${variant}-${seed}`,
        decision_id: rows.length,
        prompt: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: renderObservation(view) },
        ],
        completion: [{ role: "assistant", content: JSON.stringify(decision) }],
        game: "territory", action_schema_revision: "territory-submit-v1",
      }));
      submissions[seat] = decision;
    }
    state = stepTurn(state, submissions);
  }
  if (seed % 5 === 0) validationRows.push(...rows);
  else trainRows.push(...rows);
  runs.push({ seed, turns: state.turnsPlayed, decisions: rows.length,
    scores: scoreGame(state), reason: endReason(state) });
}

writeFileSync(`${output}/train.jsonl`, `${trainRows.join("\n")}\n`);
writeFileSync(`${output}/validation.jsonl`, `${validationRows.join("\n")}\n`);
writeFileSync(`${output}/manifest.json`, `${JSON.stringify({
  schema_version: 1, game: "territory", variant, source_revision: revision,
  teacher: "homesteader-and-raider", train_examples: trainRows.length,
  validation_examples: validationRows.length, runs,
}, null, 2)}\n`);
console.log(`train=${trainRows.length} validation=${validationRows.length}`);
