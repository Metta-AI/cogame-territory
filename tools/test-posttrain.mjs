// Check complete, seed-separated Territory post-training games.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const variant of ["open", "rooms", "inside_out"]) {
  const temporary = mkdtempSync(join(tmpdir(), "territory-posttrain-"));
  const output = join(temporary, variant);
  const run = spawnSync("pnpm", ["exec", "tsx", "tools/export-posttrain.ts", output, "10", variant], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  const train = readFileSync(join(output, "train.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const validation = readFileSync(join(output, "validation.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(manifest.runs.length, 10);
  assert.equal(manifest.train_examples, train.length);
  assert.equal(manifest.validation_examples, validation.length);
  assert(train.length > 0 && validation.length > 0);
  assert([...new Set(train.map((row) => row.seed))].every((seed) => !validation.some((row) => row.seed === seed)));
  assert(manifest.runs.every((run) => run.reason === "complete" && run.turns === 18 && run.scores.length === 9));
  for (const row of [...train, ...validation]) {
    assert.equal(row.game, "territory");
    assert.deepEqual(row.prompt.map((part) => part.role), ["system", "user"]);
    assert(row.prompt[1].content.startsWith("TURN "));
    const decision = JSON.parse(row.completion[0].content);
    assert(decision.orders.length <= 8 && Array.isArray(decision.messages));
  }
  console.log(`${variant}: ${train.length} train, ${validation.length} validation decisions`);
  rmSync(temporary, { recursive: true });
}
