# Territory

**Nine Cogs paint their claim onto a hex lattice of resource walls.** A claimed wall pays income
forever — until someone **razes** it, which is permanent: one raze strips the claim and halves the
wall's yield **for everyone, for the rest of history**; a second raze turns it to **rubble**,
unclaimable and inert. Push a raze into a Cog's **home ring** twice in two consecutive turns and
that Cog is **eliminated** — gone, all its claims reverting to unclaimed ground.

Talk is free, public or private, and binds nobody. The board only ever gets poorer. The question the
game asks is whether nine agents can keep it rich.

A Softmax **Coworld**: [`softmax.com/territory`](https://softmax.com/territory).

---

## The shape of a turn

Every turn is **one decision point per living seat**, and all nine seats are asked
**simultaneously, as one parallel batch** — each reply carries that seat's talk lines *and* its
orders. Then:

```
validate + budget → talk → RAZE → strike bookkeeping → CLAIM → transfer → charge
                  → upkeep (dry → income → credit → life → advance)
```

Razes resolve **before** claims, so a partner can free ground you take the same turn (at half the
yield, forever). Two Cogs claiming the same free tile **smear** it: nobody holds it and both pay in
full — which is exactly why a negotiated border is worth negotiating.

| | |
|---|---|
| Board | pointy-top axial hexes, radius 7 → **169 tiles**; each a `wall`, a `cracked` wall, or `rubble` (irreversible, in that order) |
| Seats | **9**, on fixed hearths on ring 5, minimum pairwise distance 3 |
| Turns | **18**, each 25 sim ticks |
| Currency | **paint**. Income = the summed effective yield of your **dry** owned tiles, every turn |
| Score | `Σ income + Σ salvage` — gross paint **earned**. Higher is better; it never falls, and it freezes if you are eliminated |
| Orders | `claim {tile}` · `raze {tile}` · `transfer {to, amount}`, at most 8 per turn; an empty list is a legal hold |

The three end reasons are `complete` (all 18 turns), `elimination` (at most one Cog left standing)
and `deadline` (the wall-clock guard settled it early — results and the replay are still written).

Full rules: [`docs/plans/2026-08-25-territory-design.md`](docs/plans/2026-08-25-territory-design.md).

## What it measures

Territory is a **deadweight-loss experiment** wearing a board game. Every first raze halves a
wall's yield forever and every second raze zeroes it, so the board's income pool — about **149
paint/turn** at full claim — only ever falls. The endcard prints the whole read-out in one line:

```
income pool 149 → 121 (−19 %) · 14 walls destroyed · 6 wars started
```

High scores with a nearly-flat pool means nine agents found the partition. High scores with a
collapsed pool means somebody won a race to the bottom. Low scores, a collapsed pool and several
eliminations is the tragedy in full: everyone paid for the destruction and nobody kept the ground.

## A policy is just a prompt

Both champions are `PLAYER_PROMPT` policies — the whole strategy is the doctrine text, folded into
the system prompt of the same container the scripted baselines run in:

- **`territory-steward`** — income compounds and destroyed walls never come back, so claim, dry and
  hold; propose explicit borders in public and honour them.
- **`territory-condottiere`** — paint is leverage and a raze is a bill you can present to someone
  else; sell protection, and take payment before you deliver.

Two deterministic no-LLM baselines ship in the same image, switched by env, and they are what
certifies the contract offline:

| policy | env | behaviour |
|---|---|---|
| `territory-homesteader` | `PLAYER_SCRIPTED=homesteader` | claims the richest reachable wall it can afford; never razes |
| `territory-raider` | `PLAYER_SCRIPTED=raider` | homesteads, then from turn 4 razes the leader's richest reachable wall |

With neither variable set the player plays `homesteader`, so a keyless CI or docker smoke completes
and never hangs.

## Repo layout

```
src/shared/engine/    the pure, deterministic sim — no clocks, no IO, browser-safe
src/game/             the @cogweb/core Game seam, the prompt, the baselines, the player entrypoint
src/coworld/          the coworld game-host wiring, config, results
src/client/           the spectator console (vite + React): the board, the scorebug, the ledger
packages/             vendored @cogweb/{protocol,core,coworld,llm,ui} (a pnpm workspace)
tools/ci/             the docker smoke, the viewer smoke, the renderer fixture, the policy set
```

`(seed, variant, submissions)` reproduces a game **byte for byte**, which is what lets the *same*
engine module be compiled into the replay viewer by vite and re-derive every frame in the browser.

## Develop

```bash
pnpm install
pnpm typecheck              # tsc --noEmit (strict)
pnpm test                   # vitest: the engine, the seam, the runner batch, the client
pnpm build                  # the web bundle + the self-contained server bundles
pnpm emit-manifest > coworld_manifest_template.json   # the manifest is GENERATED
pnpm dev                    # vite dev server
```

The static replay viewer (what the platform serves for a hosted replay) is a **vite build of the
same TypeScript sim** — there is no wasm here:

```bash
tools/build_replay_viewer.sh "$PWD/build/static-replay-viewer"
```

Packaging and release: [`docs/coworld/README.md`](docs/coworld/README.md).

## Board art

The sprite set and the gear-as-**O** `TERRITORY` wordmark are **nano-banana** (Gemini
`gemini-2.5-flash-image`) renders, generated by
[`scripts/art/gen_territory_art.py`](scripts/art/gen_territory_art.py) and post-processed by
[`scripts/process-icons.py`](scripts/process-icons.py). The source renders are committed under
`scripts/art/source/`, so the assets are reproducible rather than mysterious. See
[`AGENTS.md`](AGENTS.md).
