# Territory post-training

`tools/export-posttrain.ts` plays ten complete native games per certified
variant. At each turn it captures the production system prompt and rendered
seat observation. The maintained homesteader and raider policies provide
decisions accepted by the production parser and legality predicate. All nine
seats choose against the same pre-turn state, then the pure simulator advances.
Whole games stay in one split.

```sh
pnpm install --frozen-lockfile
node tools/test-posttrain.mjs
pnpm exec tsx tools/export-posttrain.ts /tmp/territory-data 10 open
```

The other certified variants are `rooms` and `inside_out`. Ten games yielded
1,296 training and 324 validation decisions for `open`, 1,255 and 307 for
`rooms`, and 1,296 and 324 for `inside_out`. The largest examples used 3,508,
2,755, and 3,007 tokens with a local Qwen2.5 tokenizer, within 4,096 tokens.
One CPU optimizer step on a tiny local model reduced validation loss from
5.5555 to 5.4672, 5.5526 to 5.4610, and 5.5555 to 5.4680, respectively.
These short runs verify the training path, not policy quality.

From a Metta checkout with `metta-posttrain` installed:

```sh
uv run --package metta-posttrain --extra train python -m metta_posttrain.train \
  --dataset /tmp/territory-data --output /tmp/territory-adapter \
  --model Qwen/Qwen3-0.6B --max-steps 100 --max-length 4096
```

The exporter uses the same anonymous aliases and redacted observation as
the hosted player. Opponents' paint balances, pending orders, and private
messages to other seats stay hidden.
