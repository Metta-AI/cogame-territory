# Territory engine

The headless, deterministic sim for **Territory** — nine Cogs painting their claim onto a hex lattice
of resource walls that only ever gets poorer. Pure TypeScript, no IO in the core: every function is a
pure transition over a serializable `GameState`. Full design:
[`docs/plans/2026-08-25-territory-design.md`](../../../docs/plans/2026-08-25-territory-design.md).

## Module map

| Module | Responsibility |
|---|---|
| `constants.ts` | **Every number in the design note**, one exported const each, plus `effYield` and the per-turn income identity |
| `rng.ts` | Seeded mulberry32 PRNG — all randomness is reproducible (kept verbatim from coworld-cogherence) |
| `hex.ts` | Axial hex coordinates: `key`, `neighbors`, `distance`, `hexesInRadius` (kept verbatim) |
| `types.ts` | The serializable core model: `GameState`, `Tile`, `CogState`, `TileState`, `LifeState` |
| `board.ts` | `generateBoard(seed, variant)` — 169 seeded walls, nine hearths, the three variant overlays; plus `homeRing` and `incomePool` |
| `orders.ts` | The zod `Order` union, the legality predicates, and the two exported set builders `legalClaimTargets` / `legalRazeTargets` the observation ships as `reach` / `razeReach` |
| `resolve.ts` | Steps 2–8: validate + budget → talk → raze → strike → claim → transfer → charge |
| `upkeep.ts` | Steps 9a–9d: dry → income → credit → life |
| `life.ts` | The strike machine and the elimination revert (`steady → staggered → eliminated`) |
| `game.ts` | `newGame` / `stepTurn` / `scoreGame` / `endReason` / `settleEarly` and the end conditions |
| `text.ts` | `truncateRunes` / `capText` and the one-line event renderers |
| `log.ts` | `TurnRecord`, `TurnEvent` and `EVENT_KINDS` — the whole event vocabulary |

## Invariants

- **Deterministic.** `(seed, variant, submissionsByTurn)` reproduces a game byte for byte. That is
  what lets the SAME module be compiled into the viewer bundle by vite and re-derive every frame in
  the browser, with no server and no interpolation.
- **Pure.** Every phase returns a new `GameState`; the input is never mutated.
- **Wholesale rejection.** An illegal or unaffordable order set is rejected as a whole, never
  partially applied. The host re-requests once with the reason, then the seat holds.
- **Affordability monotonicity.** Step 2 gates the worst-case spend against STORED paint, so the
  step-8 charge can never underflow — and it throws rather than minting paint if it ever would.
- **Next-turn money.** Salvage and incoming transfers land in `credit` and only become spendable in
  Upkeep 9c, so they cannot fund the turn that earned them.
- **Irreversibility.** `wall → cracked → rubble` is one-way; a raze never heals, and rubble stops
  conducting adjacency, so it destroys option value as well as income.
- **Rune-safe strings.** Every recorded string passes through `capText`, which slices by Unicode
  code point. A byte-boundary truncation renders in a browser and fails a strict parser.
