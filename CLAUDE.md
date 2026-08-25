# AGENTS.md

Guidance for AI assistants working in the Territory repo.

## What this is, and what it was forked from

Territory is a **fork of [`Metta-AI/coworld-cogherence`](https://github.com/Metta-AI/coworld-cogherence)**.
Its repo layout, pnpm workspace, vendored `@cogweb/{protocol,core,coworld,llm,ui}` packages, coworld
game-host (`runCoworldHost`), player wire protocol (`cogweb.player.v1`), replay artifact
(`cogweb.replay.v1`), Dockerfile shape, manifest generator and **static replay viewer (the vite
React console)** all come from that one repo. **Every convention there holds here unless the design
note says otherwise**, and the note says otherwise about exactly four things:

1. the **rules** in `src/shared/engine/*` are Territory's, not Cogherence's;
2. `packages/core/src/runner.ts` gains a **simultaneous batch** mode, so nine seats' decisions go
   out as ONE parallel batch per turn (`Game.simultaneous`), plus a pace floor and an episode
   wall-clock guard (`Game.settleEarly`);
3. `src/client/App.tsx` gains the `data-replay-loaded` / `data-replay-error` load signal;
4. `packages/coworld/src/host.ts` gains the four additive options the note's host-wiring snippet
   passes (`rules`, `runner.simultaneousPaceMs`, `runner.episodeDeadlineMs`, `replayMeta`) and
   `runCoworldGameCli` gains `shutdownGraceMs`.

The full note is [`docs/plans/2026-08-25-territory-design.md`](docs/plans/2026-08-25-territory-design.md)
and it is the source of truth for every number, schema, resolution step, cap and event name.

## Rules of the road

- **The engine is pure.** `src/shared/engine/*` has no clocks, no IO and no randomness beyond the
  seeded `makeRng`. `(seed, variant, submissions)` must keep reproducing a game byte for byte —
  that property is what lets the same module compile into the viewer bundle.
- **The chrome is not ours to edit.** `packages/ui/src/**` is this lineage's `chrome_common.js`.
  Territory reuses it **byte for byte** and APPENDS its game block
  (`src/client/ui/{ScoreBug,WarLedger,BoardPanel}.tsx`) into `.cg-stage`.
  `src/client/chrome-manifest.test.ts` fails the build if a chrome file drifts; regenerate the
  manifest with `pnpm ui-manifest` only when you have *deliberately* rebased the chrome.
- **The manifest is generated.** `coworld_manifest_template.json` is `pnpm emit-manifest` output and
  a test asserts they are equal. Never hand-edit it.
- **`num_agents` is 9, everywhere.** All three variants, the certification fixture, `SMOKE_SEATS`
  and `src/shared/engine/constants.ts` must agree; `tools/ci/docker_smoke.sh` hard-fails if they do
  not.
- **Truncate on rune boundaries.** Every recorded string goes through `capText` / `truncateRunes`
  (`src/shared/engine/text.ts`). A byte-boundary truncation renders fine in a browser and fails a
  strict JSON parser; `text.test.ts` is the gate.
- **Two name spaces, kept apart.** Agents see nine fixed anonymous aliases and NOTHING else;
  `TerritoryGame.newGame` ignores the runner's `seatNames` outright. Real policy/player names ride
  the one-shot `lobby` roster frame and the replay envelope's `players[]`, spectator-side only.
- **Degrade, never hang.** Every wait in the host is bounded (see `src/coworld/server.ts`'s header)
  and every fallback increments `results.fallbacks[seat]`.
- **CI is the verdict.** `.github/workflows/ci.yml` builds the image, runs a real nine-seat episode
  in raw docker, builds the static replay bundle and then EXECUTES it in headless chromium against
  the replay that episode produced. Do not weaken or delete a test to go green.

## Branding & art assets (nano-banana / Gemini image)

Territory's game art — the neon-glass sprite set in [`src/client/icons/`](src/client/icons/) and the
gear-as-**O** `TERRITORY` wordmark in [`src/client/art/`](src/client/art/) — is generated with
**nano-banana** (Google Gemini `gemini-2.5-flash-image`) and post-processed with Python
(Pillow + numpy). The recipe originated in the sibling Cogherence/Agricogla games; Territory reuses
the same pipeline, recoloured to its own vocabulary (paint is cyan, a raze is orange, rubble is
dead grey).

Unlike the ancestor, the pipeline here is **committed and scripted end to end**, so the assets are
reproducible rather than mysterious:

```bash
GEMINI_API_KEY=... python3 scripts/art/gen_territory_art.py          # all nine assets
GEMINI_API_KEY=... python3 scripts/art/gen_territory_art.py hearth   # or just one
python3 scripts/process-icons.py                                     # keys, crops, emits
```

- **The key is never printed, never written to a file, never a URL parameter.** It is the header
  `x-goog-api-key: $GEMINI_API_KEY` and nothing else.
- Raw renders land in `scripts/art/source/<name>.png` and are **committed** — CI does not regenerate
  art. `scripts/process-icons.py`'s `SRC` map pins each `<name>` to its raw filename; update it when
  regenerating.
- Each icon is emitted twice: `src/client/icons/<name>.png` (256 px on pure black) and
  `src/client/icons/transparent/<name>.png` (alpha-keyed). The client imports the transparent ones
  through vite, which **inlines them as data URIs** (`assetsInlineLimit: MAX_SAFE_INTEGER`) — a
  path-served asset 404s under the static-replay-bundle prefix, a data URI renders everywhere.
- **Avoid white backgrounds** in a prompt: they leave a pale halo that the alpha key turns into an
  opaque block. Say "solid near-black charcoal #07070c, corner to corner" explicitly — the first
  `paint-splatter` render came back on a white card and had to be re-rolled for exactly that.
- **Spell the word out letter by letter** in a wordmark prompt (`spelled exactly
  T-E-R-R-I-T-O-R-Y`): Gemini loves to double a letter otherwise.
- Budget ~10 generations per coworld. One call per asset keeps `SRC` one-to-one; one sheet per
  family keeps the style consistent. Territory used nine plus one re-roll.

The sprite set the board draws is `wall`, `wall-rich`, `cracked`, `rubble`, `paint-splatter`,
`hearth`, `skull`, `logo` — and `src/client/icons/_contact-sheet.png` is the labelled preview.
`src/client/Icon.tsx`'s `tileSprite(state, yield)` is the single place a tile picks one.
