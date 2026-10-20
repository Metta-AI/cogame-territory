# Territory prompt diversity and training

The v3 bank retains the original canonical rules and provides five training
presentations: `canonical`, `plain`, `numbered`, `questions`, and `reordered`.
Alternate presentations paraphrase board, economy, orders, survival, simultaneous
resolution, scoring, and budgets. Each has independently written sections,
with different order and headings.
The reply contract, worked example, doctrine, and strategy guidance remain fixed.

`mixed` requires an independent nonnegative `promptSeed`, choosing one training
presentation once per episode. `heldout-briefing` and `heldout-reference` are
reserved for evaluation. Collection rejects held-out wording for training;
use `split: "validation"` or `split: "test"` for held-out bridge resets.

## Complete-game exports

```sh
pnpm exec tsx tools/export-posttrain.ts /tmp/territory-data 10 open mixed 0
node tools/test-posttrain.mjs
```

The native exporter runs the certified 18-turn, nine-seat game with the
homesteader and raider teachers. All submissions are validated before the
simultaneous turn resolves. Exports contain `train.jsonl`, `validation.jsonl`,
and `manifest.json`. Every fifth seed belongs to validation; mixed wording
cycles separately within each split. Scenario families identify a variant
and seed. Episode IDs also include the selected wording and prompt seed, so
matched exports remain distinct without changing their scenario families.
Exact message hashes accompany every exported decision.
Existing output directories are rejected. Opponents' balances and pending
orders remain private.

Complete-game wording comparisons check mechanics and provenance, not learned
robustness. Learning comparisons must match policies, game seeds, and inference
settings, report failures and fallbacks, and reserve held-out presentations
until training choices are frozen.

## Numeric reinforcement learning

`tools/train-bridge.ts` exposes 908 values from the acting seat's redacted
view and a fixed catalog of 373 choices. The catalog contains hold, the two
scripted multi-order plans, single claim and raze orders for each board tile,
and four transfer amounts for each other seat. The production legality
predicate masks unavailable choices. All living seats choose against one
pre-turn state, then the production simulator advances. The full hosted
observation remains in `semantic_view` and `messages`.
Reset accepts the same `promptVariant`, `promptSeed`, and `split` fields as
the text bridge. Exact message hashes appear in `semantic_view.prompt_template`;
prompt selection does not change the 908 numeric features or action catalog.

```sh
pnpm exec esbuild tools/train-bridge.ts --bundle --platform=node --format=esm --target=node22 --outfile=/tmp/territory-train-bridge.mjs
python3 tools/test-train-bridge.py /tmp/territory-train-bridge.mjs
```

From a Metta checkout with the Coworld training stack, pass the Node bridge
command, absolute manifest path, and certified variant ID to
`recipes.external.coworld.train` for native PufferLib or
`recipes.external.coworld_metta_rl.train` for Metta RL. Use `players=9`,
`max_decisions=162`, and a timestep limit.

## Training proof (2026-09-24)

The bridge completed teacher and random games on all three variants. Local
Metta RL runs reached 512 timesteps per variant. Native PufferLib on one
RTX 4090 reached 4,096 timesteps per variant, then reloaded each checkpoint
for five held-out games at each seed. PufferLib computed the reported scores
and pairwise performance from the engine's terminal results.

| Variant      | Seed 101 score / performance | Seed 102 score / performance |
| ------------ | ---------------------------: | ---------------------------: |
| `open`       |                 10.8 / 0.025 |                 14.4 / 0.000 |
| `rooms`      |                 14.4 / 0.000 |                 14.4 / 0.000 |
| `inside_out` |                140.6 / 0.550 |                171.0 / 0.763 |

These short pilots prove checkpoint training and reload, not competitive
policy quality.
