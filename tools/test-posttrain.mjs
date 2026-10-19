// Check complete, seed-separated Territory post-training games.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const variant of ["open", "rooms", "inside_out"]) {
  const temporary = mkdtempSync(join(tmpdir(), "territory-posttrain-"));
  const output = join(temporary, variant);
  const run = spawnSync(
    "pnpm",
    ["exec", "tsx", "tools/export-posttrain.ts", output, "10", variant],
    {
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  const records = readFileSync(join(output, "trajectories.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  const decisions = records.filter((row) => row.event_type === "decision");
  const episodes = records.filter((row) => row.event_type === "episode");
  assert.equal(manifest.runs.length, 10);
  assert.equal(episodes.length, 10);
  assert.deepEqual(
    episodes.map((row) => row.seed_family),
    Array.from({ length: 10 }, (_, i) => `territory-${i + 1}`),
  );
  assert.equal(statSync(join(output, "trajectories.jsonl")).mode & 0o777, 0o600);
  assert(
    manifest.runs.every(
      (run) => run.reason === "complete" && run.turns === 18 && run.scores.length === 9,
    ),
  );
  for (const row of decisions) {
    assert.equal(row.game, "territory");
    assert.deepEqual(
      row.prompt.map((part) => part.role),
      ["system", "user"],
    );
    assert(row.prompt[1].content.startsWith("TURN "));
    const attempt = row.attempts[0];
    assert.equal(attempt.origin, "teacher");
    assert.equal(row.selected_attempt_id, attempt.attempt_id);
    assert.deepEqual(row.executed_action, attempt.parsed_action);
    const decision = JSON.parse(attempt.response);
    assert.deepEqual(row.executed_action, decision);
    for (const message of row.prompt)
      assert.equal(
        row.observation.prompt_template[message.role + "_sha256"],
        createHash("sha256").update(message.content).digest("hex"),
      );
    assert(decision.orders.length <= 8 && Array.isArray(decision.messages));
  }
  for (const episode of episodes) {
    assert.equal(episode.status, "completed");
    assert.equal(episode.outcome.reason, "complete");
    assert.equal(Object.keys(episode.participant_outcomes).length, 9);
    const rows = decisions.filter((row) => row.episode_id === episode.episode_id);
    for (const seat of new Set(rows.map((row) => row.seat)))
      assert.equal(rows.filter((row) => row.seat === seat).at(-1).terminal, true);
  }
  console.log(`${variant}: ${decisions.length} private decisions in ten games; retained ${output}`);
}
