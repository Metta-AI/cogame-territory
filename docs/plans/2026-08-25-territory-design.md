# Territory — design note (cogame-territory, v1)

**Repo:** `Metta-AI/cogame-territory` (public). **Base:** `Metta-AI/coworld-cogherence` @ `main`
(read at 2026-08-25 from a `--depth 1` clone; TypeScript / pnpm workspace, vendored `@cogweb/*`
packages, its own static replay viewer). **Note path in the new repo:**
`docs/plans/2026-08-25-territory-design.md`. **Seats: `num_agents` = 9, everywhere, no exceptions.**

Territory is a **fork of `Metta-AI/coworld-cogherence`** — its repo layout, pnpm workspace, vendored
`@cogweb/{protocol,core,coworld,llm,ui}` packages, coworld game-host (`runCoworldHost`), player wire
protocol (`cogweb.player.v1`), replay artifact (`cogweb.replay.v1`), Dockerfile shape, manifest
generator, and **its static replay viewer (the vite React console) — which is the single source of
every viewer file here**. *Every convention there holds here unless this note says otherwise.* This
note says otherwise about exactly three things, each called out where it appears: (1) the **rules**
in `src/shared/engine/*` are Territory's, not Cogherence's; (2) `packages/core/src/runner.ts` gains a
**simultaneous batch** mode so nine seats' LLM calls go out as one parallel batch per turn; (3)
`src/client/App.tsx` gains the `data-replay-loaded` / `data-replay-error` load signal. Everything
`tools/ci/viewer_smoke.mjs` reads (`#clock`, `#scorebug`, `#feed`, `#scrub`) is injected from the
**game block**, so no chrome file is edited — see "Viewer".

## Source idea (verbatim)

> Title: "MP Territory (variant of coworld-cogherence) — permanent wall destruction and permadeath on the existing hex territory game"
>
> Notes: "Candidate EXTENSION of Metta-AI/coworld-cogherence — Cogherence is a live mixed-motive hex-lattice territory + economy + cheap-talk game (0.6.3). Melting Pot's Territory adds the two rules Cogherence lacks and which make it a deadweight-loss experiment: resource walls can be destroyed forever (zap twice: unclaimable, walkable) and players can be eliminated permanently (zapped twice: gone, all their claims revert). Paint-claim mechanics (wet 25 ticks, then income ~0.01/tick per held wall; fling 2 tiles) map onto Cogherence's claim/income loop; the Rooms map (everyone starts in a private room; peaceful partition trivially available) is a Cogherence map variant. If Cogherence's turn structure can't host per-tick zapping, build standalone.
>
> Seats: 9 (original) — Cogherence's seat range otherwise
> Motive: mixed-motive territorial with irreversible destruction
> Integrity: anonymous aliases; seeded spawns.
> Replay plan: drying-paint animation, income-per-tick leaderboard, 'wars started' ledger.
>
> Source: meltingpot territory__{open,rooms,inside_out} (https://youtu.be/F1OO6LFIZHI , https://youtu.be/4URkGR9iv9k); github.com/Metta-AI/coworld-cogherence."

---

## The game

**One breath.** Nine Cogs paint their claim onto a hex lattice of resource walls. A claimed wall
pays income forever — until someone **razes** it, which is permanent: one raze strips the claim and
halves the wall's yield **for everyone, for the rest of history**; a second raze turns it to
**rubble**, unclaimable and inert. Push a raze into a Cog's **home ring** twice in two consecutive
turns and that Cog is **eliminated** — gone, all its claims reverting to unclaimed ground. Talk is
free, public or private, and binds nobody. The board only ever gets poorer. The question the game
asks is whether nine agents can keep it rich.

### Why base = cogherence (one line)

Cogherence is already the live hex-lattice claim/income/cheap-talk game the idea says to extend, with
a certified static replay viewer and a simultaneous turn engine; adapting granularity in a fork beats
a green-field build, and none of the six generic starters supplies a hex board, a talk bus, or this
viewer.

### Board

| Thing | Value |
|---|---|
| Lattice | pointy-top axial hexes, `BOARD_RADIUS = 7` → **169 tiles** (cogherence's `hexesInRadius`, kept verbatim) |
| Tile state | `wall` \| `cracked` \| `rubble` (irreversible, in that order) |
| Tile yield | integer `0..3`, seeded per tile |
| Tile ownership | `owner: seat \| null`, `wet: boolean`, `claimedTurn: number` |
| Hearths | one immutable spawn hex per seat, on ring 5 |
| Turns | `MAX_TURNS = 18`, each turn = `TICKS_PER_TURN = 25` sim ticks (ticks set the income/drying arithmetic; there are no per-tick decisions) |

**Yield seeding** (deterministic from the episode seed via cogherence's `makeRng`): draw `u` uniform
per tile — `u < 0.45 → 0`, `< 0.75 → 1`, `< 0.92 → 2`, else `3`. A yield-0 wall is still claimable
(it is territory and a projection origin) and pays nothing. Expected board income pool at full claim
= 169 × (0.30·1 + 0.17·2 + 0.08·3) ≈ 169 × 0.88 ≈ **149 paint/turn**, i.e. ~16.5/turn/seat if the
board were partitioned nine ways and nothing were ever razed. Every raze permanently subtracts from
that pool: that number falling across the episode *is* the deadweight loss the experiment measures.

**Hearths.** Ring 5 has 30 tiles; in traversal order starting at `(5,0)` and stepping
`(0,-1),(-1,0),(-1,+1),(0,+1),(+1,0),(+1,-1)` five times each, seat *i* takes index
`floor(i·30/9)`. The nine hearths are exactly:

`(5,0) (5,-3) (4,-5) (0,-5) (-3,-2) (-5,1) (-5,5) (-2,5) (1,4)`

Minimum pairwise hex distance = 3. A hearth tile is a normal wall (claimable, razeable, destructible)
but the **coordinate** is permanent: it is seat *i*'s **home ring** centre (the hearth plus its ≤6
neighbours = the 7 tiles whose loss threatens its life) and its projection origin of last resort. At
game start each seat **owns its hearth tile, dry, at whatever yield the seed gave it**, and holds
`STARTING_PAINT = 12` paint.

### Currency and income

Currency is **paint** (integer; the only spendable resource; no minerals, no auction — see "What is
dropped from cogherence" below).

- **Effective yield**: `wall → yield`, `cracked → floor(yield/2)`, `rubble → 0`.
- **Income** (paid in Upkeep, step 9b of the resolution order below): each seat earns `Σ effYield(t)` paint over its **dry** owned
  tiles. A tile claimed this turn is **wet** and pays nothing this turn.
- **Per-tick correspondence** (the idea's "~0.01/tick per held wall"): income is
  `effYield × TICKS_PER_TURN × 0.04` paint/turn = `effYield` paint/turn. MP's 0.01/tick over a
  25-tick turn is 0.25/turn/wall; Territory scales that ×4 so the thinnest wall pays exactly **1
  whole paint per turn** and every number a spectator reads is an integer. The viewer's leaderboard
  shows both (`4 /turn · 0.16 /tick`).
- **Drying**: paint applied in turn *T*'s Resolve is wet for that turn's 25 ticks and dries in turn
  *T*'s Upkeep (step 9a). From turn *T+1* the tile is dry: it pays income, and **it can no longer be
  claimed by anybody**. Dry paint is removed only by razing. This is the whole point of the fork —
  irreversibility is the only door into a rival's territory.

### Orders (the whole vocabulary)

| Order | Legality | Cost (paint, charged win or lose) |
|---|---|---|
| `claim {tile}` | tile state ∈ {`wall`,`cracked`}, `owner == null`, and hex distance ≤ `FLING_RANGE = 2` from the seat's nearest **owned** tile (0 if it owns the tile — impossible here since owner must be null — so effectively 1 or 2), or from its **hearth** if it owns nothing at all | `CLAIM_COST(dist) = 2 + 2·dist` → 4 at dist 1, 6 at dist 2 |
| `raze {tile}` | `turn ≥ RAZE_OPEN_TURN = 4`; tile state ∈ {`wall`,`cracked`}; distance ≤ 2 from the seat's nearest owned tile (hearth only if it owns nothing) | `RAZE_COST = 5`, or `RAZE_HOME_COST = 10` if the tile is within distance 1 of **another living seat's hearth** |
| `transfer {to, amount}` | `to` is another living seat's alias, `amount ≥ 1`, affordable | `amount + TRANSFER_FEE (1)`; the paint lands as the recipient's **next-turn** money |

`MAX_ORDERS_PER_TURN = 8`. An empty order list is a legal hold for any seat, any turn
(`baselineDecision`). **Any illegal or unaffordable entry rejects the whole set** (cogherence's
wholesale-rejection rule, kept): the host re-requests once with the reason, then the seat holds.
Affordability is checked against the seat's **stored paint only**; salvage, transfers received and
income are next-turn money (cogherence's one-turn-lag invariant, kept verbatim in spirit and in the
`resolve()` comment structure).

Razing a tile **you own** is legal from turn 4 and pays **salvage** = `SALVAGE_MULT (4) ×
effYield(tile)` paint as next-turn money, on the first raze only (the second, on your own cracked
tile, pays nothing). Break-even against holding it is `4·y = y·(18 − T)` → turn **14**: before turn
14 holding is worth more, after turn 14 cashing out is — the last-turn strip-mine defection is a real,
priced option, which is exactly the tragedy the idea wants on the board.

### The two Melting Pot rules, mapped

**1. Permanent wall destruction ("zap twice: unclaimable, walkable").**

| Raze # on a tile | Effect | Irreversible? |
|---|---|---|
| 1 | `wall → cracked`. `owner := null`, `wet := false`. Yield permanently becomes `floor(yield/2)` for whoever holds it next. | yes |
| 2 | `cracked → rubble`. Owner (if any) cleared. Income 0 forever, **never claimable again**, and it stops conducting adjacency: rubble is not an owned tile, so nobody may project a claim or a raze **from** it. It is the hole in the lattice — Territory's "walkable floor". | yes |

Two razes on the same tile **in the same turn** (from one seat or two) destroy it outright: razes
apply one step each, in seat order, before any claim resolves.

**2. Permadeath ("zapped twice: gone, all their claims revert").** Per-seat state machine
`steady → staggered → eliminated`, driven by **strikes**:

- A seat is **struck** in turn *T* iff at least one raze committed by **another** seat in turn *T*
  lands on a tile inside that seat's **home ring** (its hearth or one of the ≤6 neighbours) which
  that seat **owned at the start of turn *T*'s Resolve** (wet or dry). Razing your own home ring
  never strikes you.
- `steady` + struck → **`staggered`** (public; the viewer flashes the seat's plate).
- `staggered` + struck **in the immediately following turn** → **`eliminated`**.
- `staggered` + a turn with no strike → back to `steady` at the end of that turn.

On elimination, in Upkeep step 9d: every tile the seat owns reverts to `owner = null, wet = false`
(tile *state* is untouched — a cracked tile stays cracked, rubble stays rubble); its paint is zeroed
and unspendable; its **score freezes** at what it had already banked; it is removed from
`pendingActors` (so it is never asked for another decision and costs no further LLM calls); it still
receives the `final` frame. Events: `struck`, `recovered`, `eliminated`.

**Why this is the right turn-granular equivalent, and the defence it creates.** Per-tick zapping
cannot host in cogherence's turn structure — the engine advances only inside `applyDecision` when the
last seat's orders arrive (`src/game/game.ts`), so "twice within a few ticks" has no representation.
Two strikes in two consecutive turns is the closest faithful reading: it needs sustained presence,
not a snipe. And because a raze needs a projection origin within distance 2, the besieged seat has a
real counter — **raze the attacker's nearest foothold**. That tile becomes cracked and unowned, the
attacker no longer owns anything within 2 of the home ring, and the second strike cannot land. The
destruction rule is simultaneously the weapon and the shield, and 20 paint (2 × `RAZE_HOME_COST`) plus
two turns of public warning is what an assassination costs.

Razes are illegal in turns 1–3 (`RAZE_OPEN_TURN = 4`): the opening is claiming and talking, so a
turn-1 elimination race is impossible and the alliances the ledger tracks have somewhere to form.

### Turn structure and the exact resolution order

Every turn is **one decision point per living seat**, all seats asked **simultaneously as one
parallel batch**, each reply carrying that seat's talk lines *and* its orders (talk is not a separate
round trip — that would double the LLM budget). Phases exposed to the chrome:
`commit → resolve → upkeep`.

1. **Batch** — the host issues one `observation` to every living seat concurrently (see
   "Server, player, protocol"), waits for all, and validates each reply against the **pre-batch
   state**, so all nine seats see the identical board. Timeouts/parse failures resolve to a hold.
2. **Validate + budget, per seat in seat order** — schema, legality (spatial predicates), then
   affordability from stored paint. Violation → `rejected {seat, reason}` event, that seat's whole set
   discarded (it holds), no partial application.
3. **Talk** — every accepted line is posted to the episode `MessageBus`: `to = null` → public (emitted
   as a `talk` FeedEvent into the replay), `to = <alias>` → private to that seat (bus only, revealed
   spectator-side by the replay, never to other seats in-game).
4. **Raze** — all raze orders, ordered by (seat index, order index). Each applies one destruction step
   to its target (`wall→cracked`, `cracked→rubble`), clearing `owner`/`wet`. Emits
   `raze {seat, tile, from_state, to_state, victim}`. Own-tile first razes emit `salvage {seat, tile,
   paint}` (next-turn money).
5. **Strike bookkeeping** — for every seat, compute whether step 4 hit its home ring on a tile it
   owned pre-resolve; set `struckThisTurn`. Emits `struck {seat, by[]}`.
6. **Claim** — all claim orders resolve simultaneously against the **post-raze** board:
   - target now `rubble` → the claim is **void**; the paint is still spent. Emits `voided {seat, tile}`.
   - target still owned (a same-turn claim raced a tile that no raze freed) → **void**, paint spent.
   - exactly one claimant on a free `wall`/`cracked` tile → `owner := seat, wet := true,
     claimedTurn := turn`. Emits `claim {seat, tile, yield}`.
   - two or more claimants → the tile stays/becomes **unclaimed** (`owner := null, wet := false`),
     every claimant pays in full. Emits `smear {tile, seats[]}`. (Wet paint over wet paint smears —
     this is the only same-turn contest, and it makes negotiated borders worth negotiating.)
7. **Transfer** — paint moves between treasuries as next-turn money. Emits
   `transfer {from, to, amount}`.
8. **Charge** — actual spend (claims + razes + transfers + fees) is deducted from stored paint. The
   step-2 budget gate guarantees this never underflows (asserted; an underflow throws, as in
   cogherence's `resolve`).
9. **Upkeep**, in this order:
   a. **Dry** — every tile with `wet == true` and `claimedTurn == turn` → `wet := false`.
   b. **Income** — each living seat gains `Σ effYield` over its **dry** owned tiles (so a tile
      claimed this turn contributes nothing this turn); `banked += income`. Emits
      `income {seat, paint, walls}`.
   c. **Credit** — salvage and incoming transfers land now (next-turn money).
   d. **Life** — apply the strike machine (`staggered`/`recovered`/`eliminated`); an eliminated seat's
      claims revert here. Emits `recovered` / `eliminated {seat, tilesReverted}`.
   e. **Advance** — `turn += 1`, append the `TurnRecord`, emit the snapshot + status frames.
10. **Pace** — sleep until `BATCH_MIN_MS` (22 000 ms; `paceMs` in the episode config) has elapsed
    since this turn's batch began, then check the episode deadline (below) and loop.

### Scoring, sign, and what the league ranks by

```
score(seat) = Σ_{turns} income(seat, turn) + Σ salvage(seat)      // gross paint EARNED, never spent-adjusted
```

**Higher is better.** It is monotone non-decreasing per seat and freezes on elimination. It is
written to `results.scores[]` in **seat order**, and the league ranks by exactly that number (Elo over
per-episode scores; no transformation). Spending paint never reduces the score directly — aggression
is paid for in *forgone future income*, yours and the board's, which is precisely the deadweight-loss
economics the idea asks to measure. `Σ scores` across seats falling relative to the un-razed pool
(~149/turn) is the experiment's read-out and is printed on the endcard.

Displayed winner tie-break (cosmetic; the ladder only sees the number): higher score → **fewer razes
committed** → lower seat index.

### End conditions and `results.reason`

Exactly three legal values, in `results.reason`:

| `reason` | Condition | Healthy? |
|---|---|---|
| `complete` | turn 19 is reached, i.e. all 18 turns played | yes |
| `elimination` | at most one seat remains non-eliminated at the end of a turn — the episode ends immediately, that turn's Upkeep having completed | yes |
| `deadline` | the wall-clock guard trips: at step 10, `elapsed + 2·ACT_TIMEOUT_MS > EPISODE_DEADLINE_MS (660 000 ms)` → stop, score as-is, write artifacts | tolerated, not expected |

`deadline` is a **settle**, never an overrun: results and replay are always written, scores are the
banked totals at the last completed turn, and `results.turnsPlayed` records how far it got. Phase 60
treats `complete` and `elimination` as pass; a `deadline` is accepted (the design declares it) but
must be reported. There is no fourth value — a host crash writes nothing and fails the episode.

### Per-seat observation: exactly what is visible and what is hidden

The redacted view handed to seat *k* (`game.redact(state, k)`, JSON, ~10–14 KB at 169 tiles):

```json
{
  "version": "0.1.0", "seed": 12345, "turn": 7, "turns": 18, "phase": "commit",
  "radius": 7, "ticksPerTurn": 25, "razeOpensTurn": 4, "flingRange": 2,
  "you": { "seat": 3, "alias": "Cobalt", "paint": 14, "hearth": "0,-5",
           "state": "steady", "walls": 6, "incomeLastTurn": 7, "banked": 31 },
  "cogs": [ { "seat": 0, "alias": "Sable", "state": "staggered", "walls": 9,
              "incomeLastTurn": 11, "banked": 52, "razesMade": 3, "alive": true } ],
  "tiles": [ { "t": "3,-2", "state": "wall", "yield": 2, "owner": "Sable",
               "wet": false, "hearthOf": null } ],
  "reach":     ["4,-2", "3,-1"],
  "razeReach": ["3,-2", "2,-1"],
  "lastTurn": { "rejected": null, "razedAgainstYou": ["0,-4"], "smeared": [],
                "struckBy": ["Sable"], "salvage": 0 },
  "inbox": [ { "from": "Sable", "scope": "public", "text": "…", "turn": 6 },
             { "from": "Amber", "scope": "dm", "text": "…", "turn": 6 } ],
  "log": [ "T6 Sable razed 0,-4 (Cobalt) → cracked", "T6 Amber claimed 1,3" ]
}
```

**Visible to every seat:** the whole board (every tile's coordinate, state, yield, owner alias, wet
flag, hearth marker) — Territory is fully observable, it is a negotiation game, not a fog game; every
seat's alias, life state, wall count, last-turn income, banked score and cumulative raze count; the
public talk transcript; the last 12 public event one-liners.

**Hidden:** every other seat's **paint balance** (you cannot count a rival's war chest — the one
number that makes threats bluffable); every other seat's **pending orders** (the turn is
simultaneous); **DMs you are not party to**; and the **real policy names** of every seat, including
your own (aliases only — see "two name spaces"). `reach` / `razeReach` are private conveniences, not
information: they are computed by the *same predicate the validator applies*
(`legalClaimTargets(state, seat)` / `legalRazeTargets(state, seat)`), which is the escrow-0.1.3 fix
for formal-output fallback storms — the model never has to derive the legal set.

---

## Decisions: LLM with scripted fallback

Both policies ship in the **same image** from day one, selected by env on one entrypoint
`/bin/territory-player` (`dist-server/game/player.js`):

| Env | Behaviour |
|---|---|
| `PLAYER_PROMPT=<doctrine text>` (+ `USE_BEDROCK=true`) | LLM policy: Bedrock haiku via `@cogweb/llm`'s `robustDecide`, the doctrine folded into the system prompt |
| `PLAYER_SCRIPTED=homesteader` \| `raider` | that scripted baseline, no model, no network |
| neither set | `homesteader` (so a keyless CI/docker smoke completes and never hangs) |

### LLM policy

- Client: `BedrockLlmClient` with the model **pinned** to `us.anthropic.claude-haiku-4-5-20251001-v1:0`
  (`BEDROCK_MODEL` in the policy env). The `MODEL_CANDIDATES` ladder is **not** used — the
  `us.anthropic.claude-sonnet-4-6` rung times out on every sidecar call and one throttle then
  cascades into scripted fallbacks (raid round 2, 2026-08-23). `maxTokens: 900` (400 truncates:
  "cut off at max_tokens"). No `output_config.effort` (Haiku 4.5 rejects it).
- Structured output: the autopilot offers one tool, `submit_turn`, whose input schema **is** the reply
  schema below, so `robustDecide` forces the tool call and validates its input. The system prompt also
  states: *"If you answer in text instead of calling the tool, your reply MUST begin with `{` and
  contain nothing but the JSON object."* (Haiku answers prose-first otherwise.)
- System prompt = the full rules copy (`SYSTEM_PROMPT` in `src/game/prompt.ts` — cogherence keeps its copy under `src/agents/`, which Territory deletes, so the prompt moves beside the seam): board, the three
  orders with their exact costs, the two irreversibility rules, the strike machine, the scoring
  formula, the turn/deadline budget, the reply contract with its caps, and one worked turn. It ends
  with the doctrine block: `--- YOUR DOCTRINE ---\n<PLAYER_PROMPT>\n--- END DOCTRINE ---`.
- User turn = the rendered observation (a compact text rendering of the JSON above: your line, the
  leaderboard, your tiles, `reach`/`razeReach` as explicit lists, your inbox's last 12 lines, and
  last turn's report), plus, on a retry, `The game rejected your previous move: <reason>. Choose a
  different legal move.`

The two champion doctrines (both `PLAYER_PROMPT`, both LLM — a scripted champion is a failure state):

- **`territory-steward`** (champion #1, daveey): *"You are a steward. Income compounds and destroyed
  walls never come back, so your default is to claim, dry, and hold. Propose explicit borders in
  public and honour them; a border you keep is worth more than a wall you take. Raze only (a) in
  direct retaliation against a seat that razed your ground, or (b) after turn 14, to cash out ground
  you are about to lose. Never open a war you cannot end in two turns. Name the seats you trust and
  say what you will do next turn — then do it."*
- **`territory-condottiere`** (champion #2, daveey-1): *"You are a condottiere. Paint is leverage and
  a raze is a bill you can present to someone else. Claim the richest walls you can reach, then use
  the threat of razing to sell protection: offer a seat safety in exchange for paint transfers or a
  border, and take payment before you deliver. Strike home rings only when a second strike next turn
  is affordable and someone else has already staggered the target. Keep one foothold inside two tiles
  of the leader at all times, and tell them so."*

### Scripted baselines (algorithms, exact)

Both are pure functions of the redacted view — no state, no clock, deterministic, always legal, ≤ 4
orders. They post **no talk lines** (which is why CI replays carry zero LLM text — see the renderer
fixture in "Tests").

**`homesteader`** (the certification baseline and filler #1):
1. `budget := you.paint`; `orders := []`.
2. Candidates = `reach`, keyed by `(−effYield, dist, tileKey)` ascending — richest first, nearest
   first, then lexicographic on `"q,r"` for total determinism.
3. While `orders.length < 3` and a candidate's `CLAIM_COST(dist) ≤ budget`: emit
   `{type:"claim",tile}`, `budget -= cost`, drop that candidate.
4. Never razes, never transfers. If nothing is affordable, return `{orders: [], messages: []}` (hold).

**`raider`** (filler #2):
1. Turns 1–3: exactly `homesteader`.
2. From turn 4: let `leader` = the living seat with the highest `banked` (ties → lowest seat) other
   than you. If any tile in `razeReach` is owned by `leader` with `effYield ≥ 2` and its raze cost
   ≤ `you.paint`, emit one `{type:"raze",tile}` for the highest `(effYield, tileKey)` such tile and
   subtract the cost.
3. Spend the remaining budget exactly as `homesteader` (≤ 3 claims).

### Simultaneous batch and the wall-clock budget (why 9 seats fit)

`packages/core/src/runner.ts` currently drives pending actors **sequentially**
(`for (const seat of pending) await this.#driveSeat(...)`). At nine LLM seats that is nine serial
round trips per turn and the episode cannot fit any budget. **Territory forks the runner**: the
`Game` seam gains `simultaneous?: boolean` (Territory sets it `true`), and `#run()` becomes

1. `pending = pendingActors(state)` (living seats only);
2. `decisions = await Promise.all(pending.map(seat => this.#decideSeat(seat, gen, stateAtTurn)))` —
   **one parallel batch**, every `DecideContext` built against the same pre-batch `stateAtTurn`, so
   all nine dry-run validations see the identical board;
3. apply the gathered decisions **in seat order** via the existing `#apply`; because
   `applyDecision` only buffers a seat's orders (and steps the engine when the last seat's arrive),
   sequential application after a parallel gather is exactly the engine's own simultaneity;
4. emit snapshot + status, emit each seat's `actPrompt` transcript, then the `BATCH_MIN_MS` pace floor
   and the deadline check.

Budget arithmetic, stated out loud (`episodeTimeoutSeconds = 1200`, 60 % = **720 s**):

- `ACT_TIMEOUT_MS = 20 000` per reply, `MAX_ATTEMPTS = 2` (one retry) → worst case **40 s** per batch.
- Observed haiku-4-5 tool-call latency 3–8 s → expected batch **≈ 8 s**.
- `BATCH_MIN_MS = 22 000` is a **floor on the spacing between batch starts** (config `paceMs`), so a
  turn costs `max(batch, 22 s)`.
- **Expected episode**: 45 s connect grace + 18 × 22 s + 20 s shutdown linger = **461 s = 38 % of
  1200 s.** ✅
- **Worst case** if every batch burns the full retry ceiling: 45 + 18 × 40 + 20 = 785 s — over budget,
  which is why the host also enforces `EPISODE_DEADLINE_MS = 660 000`: at step 10, if
  `elapsed + 40 000 > 660 000` the episode settles with `reason: "deadline"`. The episode therefore
  cannot exceed ≈ 700 s, always inside the 720 s pin, and always with artifacts written.
- **Bedrock sidecar rate cap (30 requests/minute per episode)**: 9 requests per 22 s = **24.5 rpm**,
  under the cap. Retries are capped at **one per seat per turn** for this reason, and a seat whose
  retry is throttled falls straight to its scripted move rather than a third call. Seats eliminated
  mid-game shrink the batch, so the late game is further under.
- 9 seats is therefore **provably inside budget** and is what every variant and the cert fixture
  declare. No other number appears anywhere in the repo.

### Degrade, never hang

The game container does **not** receive `COWORLD_TIMEOUT_SECONDS`; every wait is bounded here:

| Failure | Response |
|---|---|
| Reply doesn't parse / fails the schema | The player's own `robustDecide` retries **once** with the parse reason, then plays its **scripted `homesteader` move** (not an empty hold) so the seat still does something; recorded as `fallback` |
| Reply is well-formed but illegal | Host re-requests once with the engine's reason (`RemotePlayerPilot`, `MAX_ATTEMPTS = 2`); on the second failure the runner applies `baselineDecision` (hold) |
| No reply within `ACT_TIMEOUT_MS` (20 s) | That seat holds this turn; the other eight are unaffected (the batch is a `Promise.all` of individually-guarded decides) |
| Three consecutive timeouts on one slot | `RemotePlayerPilot`'s circuit breaker trips: the slot is treated as gone and every later turn resolves instantly to a hold (kept verbatim from cogherence) |
| A player never connects | `CONNECT_DEADLINE_MS = 45 000`, then the episode starts anyway and that slot holds |
| Bedrock unavailable / no credentials | `robustDecide`'s terminal-credentials path → scripted move immediately, no retry storm |
| Wall clock | `EPISODE_DEADLINE_MS = 660 000` → settle early, `reason: "deadline"` |
| Seat eliminated | Removed from `pendingActors`: never asked again, no LLM call, still gets `final` |
| Episode end | `final` frames go out **before** the artifacts are written (so each player's `bedrock_usage` line survives), then results + replay, then a bounded **20 s** shutdown linger during which `/healthz`, `/client/*` and `/global` keep answering (lantern 0.1.3), then `process.exit(0)` |

Every fallback increments `results.fallbacks[seat]` and emits an `actPrompt` frame with
`usedFallback: true`, so phase 60 can read "were the champions actually thinking" out of the replay.

### Two name spaces

- **In-game (what agents see):** nine fixed anonymous aliases, index-ordered —
  `Sable, Ochre, Verdant, Cobalt, Amber, Violet, Teal, Rose, Ash`. They are the *only* names in any
  observation, in any DM address, and in every `text` the engine renders. `TerritoryGame.newGame`
  **ignores** the runner's `seatNames` for cog display names (cogherence lets them through — that is
  one of the three deliberate divergences), so a platform-injected policy name can never reach a
  prompt.
- **Spectator-side (replay only):** the real policy/player names ride in the one-shot `lobby` roster
  frame the host already emits (`SeatPilot.name`, fed from `config.players[].name`) and in the replay
  envelope's `players[]`. The viewer's scorebug shows `Cobalt · daveey-1`; the agents only ever saw
  `Cobalt`.

---

## Sim module

Pure, deterministic, browser-safe TypeScript under `src/shared/engine/` — no clocks, no IO, no
randomness beyond the seeded `makeRng`. `(seed, variant, ordersByTurn)` reproduces a game byte for
byte, which is what lets the **same** module be compiled into the viewer bundle by vite and re-derive
every frame in the browser.

**Kept from cogherence, verbatim:** `hex.ts` (axial hexes, `neighbors`, `hexesInRadius`, `distance`,
`key`), `rng.ts` (`makeRng`, `randInt`), `log.ts`'s `TurnRecord`/`TurnEvent` shape, and the
pure-function discipline of `resolve.ts` (new state returned, input never mutated; the
affordability-monotonicity and next-turn-money invariants restated in the header comment).

**Forked (same file names, Territory's rules):**

| File | Contents |
|---|---|
| `types.ts` | `TileState = "wall"\|"cracked"\|"rubble"`, `Tile {hex, state, yield, owner, wet, claimedTurn}`, `CogState {seat, alias, paint, banked, hearth, life: "steady"\|"staggered"\|"eliminated", struckThisTurn, razesMade, wallsHeld}`, `GameState {turn, phase, seed, variant, tiles, cogs, cogOrder, log}` |
| `constants.ts` | every number in this note, one exported const each: `SEATS=9`, `BOARD_RADIUS=7`, `HEARTHS[9]`, `MAX_TURNS=18`, `TICKS_PER_TURN=25`, `INCOME_PER_TICK_PER_YIELD=0.04`, `STARTING_PAINT=12`, `FLING_RANGE=2`, `CLAIM_BASE=2`, `CLAIM_PER_DIST=2`, `RAZE_COST=5`, `RAZE_HOME_COST=10`, `RAZE_OPEN_TURN=4`, `SALVAGE_MULT=4`, `TRANSFER_FEE=1`, `MAX_ORDERS_PER_TURN=8`, `MAX_SAY_LEN=200`, `MAX_LINES=3`, `MAX_NOTE_LEN=120`, `YIELD_THRESHOLDS=[0.45,0.75,0.92]` |
| `board.ts` | `generateBoard(seed, variant)`: 169 tiles, seeded yields, the nine hearths owned dry, plus the three variant overlays (below) |
| `orders.ts` | the zod `Order` union + the legality predicates `isLegalClaim`, `isLegalRaze`, `claimDistance`, and the two **exported set builders** `legalClaimTargets` / `legalRazeTargets` the observation ships as `reach` / `razeReach` |
| `resolve.ts` | steps 2–8 of the resolution order, in that order, emitting `ResolveEvent` |
| `upkeep.ts` | step 9a–9e, emitting `UpkeepEvent` |
| `life.ts` | **new** — the strike machine and elimination revert |
| `game.ts` | `newGame`, `stepTurn` (resolve → upkeep → life → advance → `TurnRecord`), `scoreGame`, `endReason` |
| `text.ts` | **new** — `truncateRunes(s, cap)` and the one-line event renderers |

**Deleted:** `coherence.ts`, `energy.ts` (no coherence tug-of-war, no minerals), and all of
`src/agents/**` (cogherence's in-process Bedrock agents; here the LLM lives in the player container).

**What is dropped from cogherence, and why:** the coherence tug-of-war, the four minerals/COGS
conversion, the per-tile upkeep bill, and the per-turn Vickrey heart auction. Each of those needs
~100 turns to pay off; Territory's LLM budget affords 18. Dropping them leaves exactly the
claim/income/talk skeleton the idea says to map onto, plus the two new irreversibility rules, and it
keeps nine simultaneous seats legible to a spectator. The auction's collude-or-defect beat is
replaced by the raze decision, which is the same politics with permanent stakes.

**Event vocabulary written to the replay** (`kind` on every `FeedEvent`, `data` = the typed event —
this is the whole vocabulary; the viewer draws from it and nothing else):

`order` · `rejected` · `talk` · `raze` · `salvage` · `struck` · `claim` · `smear` · `voided` ·
`transfer` · `income` · `dried` · `recovered` · `eliminated` · `endcard`

`endcard` is emitted once at the end with `{reason, turnsPlayed, scores, walls, destroyed,
poolStart, poolEnd, warsStarted}` so the final panel needs no derivation.

### Map variants (board generation only; same seats, same rules, same turn count)

| Variant | Generation |
|---|---|
`open` | plain seeded yields, no barriers. The league default.
`rooms` | every hearth's 6 neighbours are forced to `yield 3`; every tile at hex distance exactly 2 from a hearth is seeded **`rubble`** (the room wall) except one **gap** — the tile in that ring nearest the board origin (ties → lowest `tileKey`). Precedence when rings collide (hearths can be 3 apart): being within distance ≤ 1 of *any* hearth wins over being a room wall. Nine private rooms; a peaceful partition is available on turn 1, which is exactly MP's Rooms point.
`inside_out` | every tile within distance 2 of the board origin is forced to `yield 3`; every tile at distance ≥ 6 is forced to `yield 0`. The wealth is all shared and central, so contact is immediate.

---

## Server, player, protocol

Unchanged from cogherence except where named. The game container is `dist-server/coworld/game-cli.js`
(shimmed as `/bin/territory`), a thin binding of `@cogweb/coworld`'s `runCoworldGameCli` →
`runCoworldHost` over the `territoryModule` seam; the player container is
`dist-server/game/player.js` (shimmed as `/bin/territory-player`).

**Kept verbatim:** `packages/coworld/src/{host,artifacts,protocol,remote-pilot,player-runtime,llm-player}.ts`
(the `/player` bridge, token auth, `welcome`/`observation`/`reply`/`final`, the `MessageBus` talk
substrate, the circuit breaker, `COGAME_*` artifact IO, the `/client/{global,player,replay}` +
`/healthz` + `/global` surfaces the certifier probes), and the wire protocol name
**`cogweb.player.v1`**.

**Host wiring (`src/coworld/server.ts`):** `runCoworldHost({module: territoryModule, tokens,
playerNames: config.players.map(p => p.name)  /* roster/replay only */, seed: config.seed,
connectDeadlineMs: 45_000, actTimeoutMs: 20_000, simultaneousPaceMs: config.paceMs ?? 22_000,
episodeDeadlineMs: 660_000, shutdownGraceMs: 20_000, welcomeConfig: () => ({seats: 9, turns: 18,
variant, ticksPerTurn: 25, aliases: ALIASES}), results: {schema, build}})`.

**Episode config** (`src/coworld/config.ts`, zod `.strict()`, mirroring `config_schema`):

```ts
{ tokens: string[9], num_agents?: 9, players: {name: string}[9],
  seed?: number, variant?: "open"|"rooms"|"inside_out", paceMs?: number, turns?: number }
```

`num_agents` is tolerated-and-pinned (the ladder injects it into every league episode; a strict
schema without it crashes the host — cogherence's own comment). `turns` defaults to 18 and exists so
the cert fixture can pin it; `paceMs` defaults to 22 000 and the cert fixture pins `0`.

**Reply schema** (the `submit_turn` tool input, and the `decision` a scripted player sends):

```json
{
  "orders": [ {"type":"claim","tile":"3,-2"},
              {"type":"raze","tile":"0,-4"},
              {"type":"transfer","to":"Cobalt","amount":4} ],
  "messages": [ {"to": null, "text": "public line"},
                {"to": "Amber", "text": "private line"} ],
  "note": "why I did this"
}
```

| Field | Bound | On violation |
|---|---|---|
| `orders` | array, **0–8** entries; `tile` matches `^-?\d{1,2},-?\d{1,2}$`; `amount` int ≥ 1 | schema reject → one re-request → hold |
| `messages` | array, **0–3** entries | entries past the 3rd are **dropped**, not rejected |
| `messages[].text` | **≤ 200 characters** | **truncated** to 200 and `…` appended |
| `messages[].to` | `null` (public) or a living seat's alias | unknown/self/absent alias → treated as **public** (cogherence's `onTalk` rule) |
| `note` | **≤ 120 characters**; free text, spectator-side only (rides the `actPrompt` transcript, never another seat's observation) | **truncated** to 120 and `…` appended |

**Truncation is on rune boundaries.** `truncateRunes` slices by Unicode code point
(`Array.from(s).slice(0, cap).join("")`), never by byte and never by UTF-16 code unit, so no lone
surrogate and no partial multi-byte sequence can reach the replay. A byte-boundary truncation is what
makes replay bytes fail a strict JSON parser while still rendering in a browser; a test asserts the
round trip (see "Tests").

**Protocol docs shipped in the manifest** (both required):

- `game.protocols.player` — `{"type":"text","value": …}` — connect to `/player?slot=&token=`
  (`COWORLD_PLAYER_WS_URL`); on `welcome` record slot + config; on each `observation` reply with the
  object above inside `decision` (plus `messages` as `TalkLine[]`, which the host routes); a rejected
  decision comes back as a fresh `observation` with `reason` set; `final` carries per-slot scores.
- `game.protocols.global` — `{"type":"text","value": …}` — read-only spectator `ServerMessage`
  stream: one `lobby` roster frame, then per turn a `snapshot` plus the event vocabulary listed above;
  the saved replay is `{"protocol":"cogweb.replay.v1", frames, players, config, results, usage}`;
  spectators send nothing.

**Replay bytes are self-sufficient.** The envelope carries everything the viewer needs, so the page
contacts nothing but S3 for the `.replay` file:

```json
{ "protocol": "cogweb.replay.v1",
  "players": [ {"seat":0,"alias":"Sable","policy":"territory-steward","player":"daveey"} ],
  "config":  {"seats":9,"turns":18,"variant":"open","seed":12345,"ticksPerTurn":25,
              "razeOpensTurn":4,"flingRange":2,"salvageMult":4},
  "results": {"scores":[…9…],"reason":"complete","turnsPlayed":18,"fallbacks":[…9…],
              "eliminated":[2],"razes":[…9…],"destroyed":14,"poolStart":149,"poolEnd":121},
  "frames":  [ lobby, snapshot(turn 1), …, event…, snapshot(turn 19) ],
  "usage":   {…bedrock totals…} }
```

`ReplayArtifact` in `packages/protocol` is `.passthrough()`, so `players`/`config`/`results` ride
alongside `frames` without a schema change. Every turn contributes at least one full `snapshot`
(the complete tile array + every seat's public state), so the viewer re-derives each frame with no
server and no interpolation. The seed is in `config` **and** in every snapshot.

---

## Viewer

**Single source for every viewer file: `Metta-AI/coworld-cogherence`.** All of it — the vite React
console (`index.html`, `index-agent.html`, `src/client/main.tsx`, `src/client/App.tsx`,
`src/client/HexBoard.tsx`, `src/client/cg/*`, `src/client/ui/*`, `src/client/styles.css`), the shared
chrome package (`packages/ui/src/{GameTopBar,GameScrubberBar,Scrubber,EventFeed}.tsx` +
`packages/ui/src/styles.css`),
the replay loader (`packages/ui/src/replay.ts`), the frame decoder
(`src/client/net/{cogweb-feed,feed}.ts`), and the build hook
(`tools/build_replay_viewer.sh` → `scripts/build-static-replay-viewer.sh`) — comes from that one repo.
**Nothing is spliced in from any other starter.** (The Nim/emscripten quartet the generic checklist
names — `replay-viewer/config.nims`, a wasm entry `.nim`, `static_replay*.js`, `index.html` — does not
exist in this lineage: cogherence's static bundle is a **vite build of the same TypeScript sim**, which
satisfies the same pin, "the viewer re-derives every frame from the recorded events in the browser",
by compiling the engine to JS instead of wasm. The cogame-lantern deadlock was a *mixed-provenance*
bundle; the rule that prevents it is the one applied here — one repo supplies all of it.)

**Manifest declaration:** `"replay_viewer": {"bundle": "build/static-replay-viewer"}` — cogherence's
proven package-relative path to the `static-replay-viewer` directory (basename exactly
`static-replay-viewer`, the form the checklist names; `scripts/build-static-replay-viewer.sh` refuses
any output path that does not end in `/build/static-replay-viewer`). Certification must report
`Replay liveness: skipped (static replay bundle declared`. **Never** a `/client/replay` pod viewer.

**Build hook:** `tools/build_replay_viewer.sh`, committed **mode 100755** at the repo root (this is
the path `coworld build --project .` and ci.yml's viewer job both require). It runs
`pnpm install --frozen-lockfile` when `node_modules` is absent, `mkdir -p` on the output's parent
(the ecos-2026-08-23 fix — `coworld build` pre-creates it, CI does not), then execs cogherence's
`scripts/build-static-replay-viewer.sh <repo> <out>` verbatim, which is
`pnpm exec vite build --outDir <out>`.

**Load signal (the one addition to the page).** `src/client/App.tsx`'s replay effect, after the
first frame has been applied *and* committed, sets in a `requestAnimationFrame` callback:
`document.documentElement.dataset.replayLoaded = "true"`, and only **then** posts the
`coworld-replay` bridge `{type:"ready"}` to `window.parent` (chorus `3c11c953` — posting `ready`
before the attribute lets the softmax.com embed sample an unpainted shell). On failure it sets
`document.documentElement.dataset.replayError = <message>` and posts `{type:"error"}`; the existing
`loadError` paragraph still renders the text.

**Chrome provenance — byte-for-byte reuse plus an appended game block.** The page is cogherence's
`index.html` (its `<base>`-recovery script byte-for-byte — it is what makes assets resolve under
`/v2/coworlds/replays/static/<cow>/<sha>/index.html`), and **every file under `packages/ui/src/` is
copied unmodified** — that package is this lineage's `client/chrome_common.js`, and nothing in it is
edited. `App.tsx` keeps its structure — `<GameTopBar>` over `<div class="cg-stage">` over
`<GameScrubberBar>` — and Territory **appends** its game block
(`src/client/ui/{ScoreBug,WarLedger,BoardPanel}.tsx`) into the stage. It is not a rewrite that reuses
the ids (cogame-gridlock, 2026-08-23). The two ids the smoke needs from the chrome are injected from
the game side, which is why no chrome edit is required: `#clock` rides `GameTopBar`'s existing
`phaseLine` ReactNode prop (`phaseLine={<span id="clock">Turn 7 / 18 · Resolve</span>}`) and `#scrub`
is a wrapping `<div id="scrub">` around `<GameScrubberBar>`; `#scorebug` and `#feed` are ids on
Territory's own components. A test asserts `packages/ui/src/**` is unchanged from the base commit
(a checked-in SHA-256 manifest).

Removed from the base page, explicitly and exhaustively: the **`AuctionPanel`** (no auction), the
**`mineral` lattice mode** and the mineral gem/`Icon` mineral art (no minerals), the **`heart`**
score glyph and `railExtra`'s heart, the **`ViewSwitcher`/`CogView`/`ConsoleControls` live controls**
in replay mode (already gated on `replayUrl === null` in the base — kept gated, so a replay shows no
operator affordances), the **live `Lobby` handoff** effect, and the `serve-hub`/`?live` code path.
The `TileInspector`, `Channels`, `TurnLog`, `Roster`, `ResizableColumns` and `Tooltip` panels are
kept and re-labelled. `index-agent.html`, `src/client/agent-main.tsx` and `CogView` stay **in the
bundle** (they are simply not reachable from the replay page): the certifier's HTTP contract check
probes `GET /client/player` and `GET /client/global` *before* any player pod starts, and a 404 on
either fails the episode (lantern 0.1.1) — `mountClient` serves them from `dist/`, so both entries
must keep building.

**Zoom decision:** the board (169 hexes) is **larger than the frame** at the 360 px embed width, so
cogherence's `HexBoard` zoom/pan is **kept** — wheel-zoom toward the cursor (1×–8× via the viewBox),
drag-pan, double-click to fit. No separate minimap is added: the SVG's default state is
`preserveAspectRatio="xMidYMid meet"` over the whole lattice, which *is* the fit view, so a minimap
would duplicate it. Because the board is pannable, `viewer_smoke.mjs --strict-text-bounds` is **not**
used (text may legitimately sit off-frame); the DOM-overflow renderer fixture below covers what it
would have covered.

**Readouts** (each with the id `tools/ci/viewer_smoke.mjs` reads, all legible at **360 px** wide):

1. **`#clock`** — in `GameTopBar`'s `phaseLine`: `Turn 7 / 18 · Resolve`. Rendered as digits, never
   notation. This is the string the smoke's scrub readouts (0 % / 50 % / 100 %) and the `--soak`
   advance check compare.
2. **`#scorebug`** — the **income-per-tick leaderboard** the idea asks for: nine rows, ranked by
   `banked`, each `swatch · alias · policy-name · banked · +N/turn (0.0N/tick) · ▮×walls · state
   badge`. `staggered` pulses amber, `eliminated` greys out and strikes through. At < 640 px the
   `/tick` figure and the policy name hide, `.plate-name { flex: 1 1 auto; min-width: 3.2em }` keeps
   names from collapsing to "…" (the featured-match iframe is ~360 px), and the row degrades to
   `swatch · alias · banked`.
3. **`#feed`** — the **wars-started ledger**: a header counter `wars started: N` (N = distinct
   ordered pairs (attacker, victim) whose first `raze` on the victim's ground has occurred) over a
   scrolling list of the aggression events only — `raze`, `struck`, `eliminated`, `smear`, `voided` —
   each a plain sentence: `T7 · Ochre razed 3,-2 (Sable) → cracked · yield 3→1`. Talk lines live in
   the separate `Channels` panel (public and, spectator-side only, DMs).
4. **`#scrub`** — the `<div id="scrub">` wrapper around `GameScrubberBar`. Its per-turn **rail cells are the
   clickable, labelled beats** — real `<button>`s carrying the turn number, phase pips and the
   `renderRailExtra` slot, which Territory fills with a stacked **territory share bar** (per-seat
   owned-wall share) plus a **`✖N` destruction count** and a **`☠` mark** on any turn with an
   elimination. Every beat kind emitted has its own CSS class (`.beat-raze`, `.beat-elim`,
   `.beat-smear`, `.beat-quiet`). The phase strip reads `Commit · Resolve · Upkeep`.
5. **Board** (`BoardPanel` → `HexBoard`) — the **drying-paint animation**: a tile with `wet: true`
   draws an owner-coloured splatter polygon at 0.55 inset under a shrinking ring, animated by the
   `cg-drying` CSS keyframe (1.0 → 0.35 opacity, scale 1.0 → 0.86 over 250 ms, matching the replay's
   one-snapshot-per-250 ms playback), and carries `data-wet="1"` so tests can see it. Dry owned tiles
   are solid owner colour; `cracked` draws a fractured double outline at half fill and a chipped-wall
   sprite; `rubble` is a flat near-black hole with no border and no sprite — visibly walkable, visibly
   gone. Hearth tiles carry a ringed home glyph; a **staggered** seat's home ring pulses red. Yield
   is the wall sprite's size, 1–3.
6. **Endcard** — the existing `FinalScores` panel, mounted **inside `.cg-stage`** (never over the
   transport row, which is the local form of "the endcard stops at `var(--band)`"); because it renders
   only while the playhead is on the synthetic FINAL slot, **every seek dismisses it** by
   construction. It shows final scores, the reason (`complete` / `elimination` / `deadline`), walls
   destroyed, and `income pool 149 → 121 (−19 %)` — the deadweight loss in one line.

**Transport rules, in this stack's terms.** The paintbot chrome's `--band` / `--hudscale` `:root`
variables set by a `relayout()` have **no counterpart in this lineage** — I read
`src/client/styles.css` and `packages/ui/src/styles.css` and neither defines them, so a note claiming
otherwise would be false. The guarantee they exist to provide is structural here instead, and it is
inherited verbatim: `.app { position: fixed; inset: 0; display: flex; flex-direction: column }`
(`src/client/styles.css`) with three flex children — `GameTopBar`, `.cg-stage { flex: 1;
min-height: 0 }`, `GameScrubberBar`. The transport band is therefore a **flex row that cannot be
overlaid**: it owns its own height and nothing can paint into it. The rules Territory must keep, and
the tests that hold them (test 15): every overlay it adds (endcard, tooltip layer, ledger popovers)
mounts **inside `.cg-stage`**, never `position: fixed` at the shell level; the endcard renders only on
the synthetic FINAL slot, so **every seek dismisses it**; the scrubber's rail beats stay real
`<button>`s with a CSS class per emitted kind (`.beat-raze`, `.beat-elim`, `.beat-smear`,
`.beat-quiet`); and the HUD scales by rules Territory **adds** — `src/client/styles.css` as read
carries **no `@media` query and no `clamp()` at all** (cogherence's console was built for desktop
spectating), so Territory writes the `@media (max-width: 640px)` block that hides the `/tick` figure,
the policy name and the rail's phase pips, gives `.plate-name { flex: 1 1 auto; min-width: 3.2em }`,
and drops `ResizableColumns` to a single stacked column. The renderer fixture (test 14) is what holds
it at 360 px.

**Art (real, not placeholders).** Generated with the nano-banana / Gemini pipeline documented in
cogherence's `AGENTS.md` and post-processed by `scripts/process-icons.py` (its `SRC` map updated):
a `TERRITORY` wordmark (gear-as-O lockup, cyan→magenta neon-glass on `#07070c`), and the sprite set
`wall`, `wall-rich`, `cracked`, `rubble`, `paint-splatter`, `hearth`, `skull`, `logo` — each emitted
as a 256 px black-bg PNG plus an alpha-keyed variant, **inlined as data URIs** by the existing
`assetsInlineLimit: MAX_SAFE_INTEGER` vite setting (path-served art 404s under the static-bundle
prefix). The nine seat colours: `#ff2e63 #36e07f #4d7cff #ff9838 #c061ff #42d4f4 #ffe14d #ff6ec7
#9fb2c4`.

---

## Packaging

Repo layout follows the **coworld-builder templates** (which is where `ci.yml` and
`coworld-release.yml` come from), i.e. the manifest template and compose file sit at the **repo
root**, not in cogherence's `coworld/` subdirectory:

- **`compose.yaml`** (root): one service **`territory`**, `image: territory-coworld:latest`,
  `platform: linux/amd64`, `build: {context: ., dockerfile: Dockerfile, network: host}`. The manifest
  image placeholder is derived from the **compose service name** → **`{{TERRITORY_IMAGE}}`**
  (lantern 0.1.0: `{{GAME_IMAGE}}` is not a thing once the service is not named `game`).
- **`Dockerfile`**: cogherence's, plus two entrypoint shims so the standard smoke/cert/policy specs
  all name the same binaries — `/bin/territory` → `node /app/dist-server/coworld/game-cli.js`,
  `/bin/territory-player` → `node /app/dist-server/game/player.js`, both `chmod +x`. `FROM
  node:20-slim`, `COPY dist-server`, `COPY dist`, no CMD.
- **`coworld_manifest_template.json`** (root) — **generated**, never hand-edited:
  `pnpm emit-manifest` runs `buildTerritoryManifest()` in `src/game/coworld.ts` through
  `@cogweb/coworld`'s `buildManifest`. A test asserts the committed file equals the generator's
  output. It carries: `$schema`, **4 tags** (`board`, `territory`, `mixed-motive`, `negotiation`),
  `game.name: "territory"` (**no underscore** — the secret namespace must equal `game.name`, and the
  page slug is the same string, so `secret://coworld/territory/anthropic_api_key` and
  `POST /coworld-league-seeds` agree), `game.runnable.type: "game"`,
  `episode_timeout_minutes: 20` (top level), `game.replay_viewer.bundle:
  "build/static-replay-viewer"`, `config_schema` as a real draft-2020-12 schema with
  **`minItems`/`maxItems` on every array** (`tokens` 9/9, `players` 9/9 — tandem 0.1.0),
  `results_schema`, both protocol docs, `game.docs`, `player[]`, `variants[]`, `certification`.
- **`results_schema`** (draft 2020-12, `additionalProperties: false`, `required: ["scores","reason"]`):
  `scores` (array of number, `minItems`/`maxItems` **9**), `reason` (enum
  `["complete","elimination","deadline"]`), `turnsPlayed` (integer), `fallbacks` (array of integer,
  9/9), `eliminated` (array of integer, 0/9), `razes` (array of integer, 9/9), `destroyed` (integer),
  `poolStart` / `poolEnd` (number), `replayUri` (string). Every array carries `minItems`/`maxItems` —
  the cert validator rejects an unbounded array property (tandem 0.1.0).
- **`.github/workflows/{ci.yml,coworld-release.yml}`** from `templates/`, with `SLUG=territory`,
  `IMAGE=territory-coworld`, `<SEATS>=9`, and the Nim toolchain steps replaced by
  `pnpm install --frozen-lockfile` / `pnpm typecheck` / `pnpm test` / `pnpm build`.

**Bundled players** (`player[]`, both `image: {{TERRITORY_IMAGE}}`):

| id | name | run | description |
|---|---|---|---|
| `territory-homesteader` | Territory Homesteader | `["/bin/territory-player"]` + env `PLAYER_SCRIPTED=homesteader` | Deterministic no-LLM baseline: claims the richest reachable wall it can afford, never razes. Always legal, so it certifies the contract offline. |
| `territory-raider` | Territory Raider | `["/bin/territory-player"]` + env `PLAYER_SCRIPTED=raider` | Deterministic no-LLM baseline: homesteads, then from turn 4 razes the leader's richest reachable wall. |

Both declared players are seated in the cert fixture — every manifest-declared runnable must occupy a
certification slot or cert fails `players_missing` (raid 0.1.2).

**Variants** (three; **`num_agents: 9` in every one**, `description` required on each):

| id | name | `game_config` |
|---|---|---|
| `open` | Open Field (9 players) | `{players: PLACEHOLDER_9, num_agents: 9, variant: "open", turns: 18, paceMs: 22000}` |
| `rooms` | Rooms (9 players) | `{players: PLACEHOLDER_9, num_agents: 9, variant: "rooms", turns: 18, paceMs: 22000}` |
| `inside_out` | Inside Out (9 players) | `{players: PLACEHOLDER_9, num_agents: 9, variant: "inside_out", turns: 18, paceMs: 22000}` |

No pinned seed in any variant (a fresh board per league episode). `PLACEHOLDER_9` is nine
`{name: "Cog A".."Cog I"}` entries the platform overwrites with the seated policy names.

**Certification fixture** — `num_agents: 9` again, plus a pinned seed and no pacing so the run
finishes well inside `coworld certify`'s 60 s default:

```json
"certification": {
  "game_config": { "seed": 7, "variant": "open", "turns": 18, "paceMs": 0,
                   "num_agents": 9, "players": [ …9 placeholders… ] },
  "players": [ homesteader ×5, raider ×4 ]
}
```

Timing check: connect (~2 s, all nine local) + 18 instant scripted turns (< 2 s) + `final` + artifacts
+ the 20 s shutdown linger ≈ **25–30 s** < 50 s. ✅ The resulting replay is 19 snapshots ≈ 4.75 s of
playback that **loops** in replay mode, so it outlasts the 15 s viewer soak (ecos, 2026-08-23).

**`game.docs`** — `readme` = `{"type":"uri","value":".../cogame-territory/tree/main/README.md"}`;
`pages` = three: `rules.md` (the full rule text from "The game"), `strategy.md` (back your frontier
in blobs; dry paint is safe, wet paint smears; a raze is negative-sum — it costs you 5 and the board
forever; hold your neighbour's foothold hostage instead of their home; after turn 14 salvage beats
holding), `deadweight.md` (what the experiment measures: `poolStart → poolEnd`, wars started,
eliminations, and how to read the endcard).

**`tools/ci/policies.json`** — four distinct versions (identical content dedupes, so the prompts and
baseline names differ):

```json
[{"name":"territory-steward","run":"/bin/territory-player",
  "env":{"PLAYER_PROMPT":"<steward doctrine>","USE_BEDROCK":"true",
         "BEDROCK_MODEL":"us.anthropic.claude-haiku-4-5-20251001-v1:0"}},
 {"name":"territory-condottiere","run":"/bin/territory-player",
  "env":{"PLAYER_PROMPT":"<condottiere doctrine>","USE_BEDROCK":"true",
         "BEDROCK_MODEL":"us.anthropic.claude-haiku-4-5-20251001-v1:0"},
  "player":"ply_bac48eb1-662e-44f8-973d-f3e016dccf5d"},
 {"name":"territory-homesteader","run":"/bin/territory-player","env":{"PLAYER_SCRIPTED":"homesteader"}},
 {"name":"territory-raider","run":"/bin/territory-player","env":{"PLAYER_SCRIPTED":"raider"}}]
```

`USE_BEDROCK: "true"` is **not optional**: the platform gates the player pod's Bedrock sidecar on it,
and without it a `PLAYER_PROMPT` seat silently plays scripted, invisibly to `results.fallbacks`
(cogolf, 2026-08-24). Both champions are `PLAYER_PROMPT`; the two scripted policies are the fillers,
and their versions must differ from the champions'.

---

## Tests

Everything runs in `ci.yml` (the sandbox runs none of it). `pnpm test` = vitest. Cogherence's
`vitest.config.ts` includes only `src/**/*.test.{ts,tsx}` — so its vendored `packages/*/tests` never
run. Territory **extends** that glob to
`["src/**/*.test.{ts,tsx}", "packages/**/tests/**/*.test.ts"]`, because the forked runner's batch
test (10) lives there and a test that is not collected is not a test. `environmentMatchGlobs`
(`src/client/**` → jsdom) is kept as is.

**Sim unit tests**

1. `board.test.ts` — same seed → identical board; 169 tiles; the nine hearth coordinates are exactly
   the list in this note and are pairwise ≥ 3 apart and owned dry at turn 1; yield histogram within
   3 σ of `[0.45,0.30,0.17,0.08]`; each variant's overlay matches its spec (rooms: exactly one gap per
   room, no gap tile is rubble, hearth-adjacency precedence honoured).
2. `orders.test.ts` — claim rejected at distance 3, on `rubble`, on an owned tile, and when
   unaffordable; raze rejected on turn 3 and accepted on turn 4; `RAZE_HOME_COST` applied iff the
   target is within 1 of another living seat's hearth. **Invariant:** `legalClaimTargets` /
   `legalRazeTargets` equal exactly the sets the validator accepts, over 200 seeded states (the
   escrow-0.1.3 precomputed-choice-set guarantee).
3. `resolve.test.ts` — the numbered order: raze precedes claim (a partner razes, you claim the freed
   tile in the same turn — succeeds); two razes in one turn → `rubble` and any same-turn claim on it
   is `voided` **with the paint still spent**; two claimants → `smear`, both charged, tile unclaimed;
   wholesale rejection on one illegal entry; charge never underflows.
4. `life.test.ts` — a raze outside the home ring never strikes; inside it does; strikes in turns 5
   and 6 eliminate, strikes in 5 and 7 do not (recovery in 6); on elimination all claims revert with
   tile state preserved, paint zeroed, score frozen, seat absent from `pendingActors`, `final` still
   delivered.
5. `income.test.ts` — a tile claimed in turn T pays 0 in T and `effYield` from T+1; `cracked` pays
   `floor(y/2)`; `rubble` pays 0; salvage = `4 × effYield` and lands as next-turn money; the per-tick
   identity `effYield × 25 × 0.04 === effYield`.
6. `score.test.ts` — `score = Σ income + Σ salvage`, monotone non-decreasing, higher-is-better, tie
   order (score → fewer razes → seat index); `results.scores` is seat-ordered.
7. `game.test.ts` — a full 9-seat 18-turn scripted game is byte-identical across two runs for one
   seed, ends `reason: "complete"`, `turnsPlayed: 18`; a scripted fixture that eliminates eight seats
   ends `reason: "elimination"` at that turn; a stubbed clock past `EPISODE_DEADLINE_MS` ends
   `reason: "deadline"` **with artifacts written**.
8. `text.test.ts` — **strict-UTF-8 / rune truncation**: a 300-emoji `text` truncates to 200 code
   points; the serialized replay (`Buffer.from(JSON.stringify(replay),"utf8")`) decodes under
   `new TextDecoder("utf-8",{fatal:true})` **without throwing** and `JSON.parse` of the result
   round-trips to the same object; no lone surrogate and no partial multi-byte sequence survives
   truncation. (A byte-boundary truncation renders fine in a browser and fails a strict parser — this
   is the test that catches it.)

**Scripted-baseline bounded-orders / legality assertion**

9. `scripted.test.ts` — for both `homesteader` and `raider`, over **200 seeded random mid-game
   views** (varying turn, paint, ownership, damage, elimination): every emitted set has
   `orders.length ≤ MAX_ORDERS_PER_TURN`, `messages.length === 0`, passes the engine's legality
   predicates *and* the affordability gate, and is accepted by `resolve()` without a `rejected`
   event. Determinism: the same view twice → the identical order list.

**Runner / batch**

10. `packages/core/tests/runner-batch.test.ts` — nine stub pilots: all are invoked before any
    resolves (a barrier proves genuine concurrency), all receive the identical pre-batch state, the
    decisions are applied in seat order, exactly one engine step happens per turn; a pilot that
    throws and a pilot that never resolves both degrade to `baselineDecision` while the other seven
    are applied normally; the `paceMs` floor is honoured under fake timers and skipped when the batch
    already exceeded it; `paceMs: 0` adds no delay.

**End-to-end episode that writes a replay**

11. `docker-smoke` job → `tools/ci/docker_smoke.sh` (from `templates/`, `chmod +x`, `<SEATS>` = **9**):
    builds the image with `docker compose -f compose.yaml build`, starts one game container plus
    **nine** player containers on a private network driven by the **certification fixture**, and
    asserts: the game exits 0; **every player container exits 0** (raid 0.1.3 — the starter smoke only
    checked the game); `results.json` validates against `results_schema` with nine scores and
    `reason: "complete"`; the replay exists and parses as **strict JSON**
    (`SMOKE_REQUIRE_REPLAY_JSON=1`); the four `SEAT-COUNT` invariants agree at 9. It copies the
    replay to `dist/smoke/replay.json`, uploaded as the `smoke-replay` artifact. Run with **no**
    `ANTHROPIC_API_KEY`, so this also proves the keyless path plays scripted and still completes.
12. `replay.test.ts` — the recorded envelope parses under `ReplayArtifact`, and independently asserts
    `players[]` (alias + policy + player), `config` (seed, variant, seats, turns), `results` (reason,
    scores, fallbacks, pool start/end), and **one snapshot per turn** plus a terminal snapshot; every
    `kind` in a frame is a member of the declared event vocabulary.

**Viewer**

13. `wasm-viewer` job (name kept from the template; here it builds a vite bundle) — asserts
    `tools/build_replay_viewer.sh` exists **and is executable** (`coworld build` hard-requires
    `os.X_OK`), runs it, then **executes** the bundle:
    `node tools/ci/viewer_smoke.mjs --bundle build/static-replay-viewer --replay dist/smoke/replay.json
    --timeout 90 --soak 15`. It must report `loaded: true` (via `data-replay-loaded`), `#clock` text
    differing across the 0 % / 50 % / 100 % scrub readouts, and an advancing soak. This is the gate
    the bundle cannot pass by merely building.
14. Renderer fixture — `tools/ci/renderer_fixture.html` mounts the **real** `ScoreBug`, `WarLedger`
    and `Channels` components with nine seats, full-cap (200-rune, CJK + emoji) talk lines on every
    seat, and long policy names, at **360 / 720 / 1280 px**, and self-checks DOM legibility:
    `scrollWidth <= clientWidth` on every row and no zero-height text node. It runs as its own
    ci.yml step via `viewer_smoke.mjs --bundle`-style page load. This is the substitute for
    `--strict-text-bounds`: cogherence's viewer draws text in **SVG/DOM**, not canvas, so
    `viewer_smoke`'s `canvas_text` counters read 0 here and prove nothing — stated so nobody reads
    that zero as a pass. It exists because `docker_smoke` runs keyless, so **every replay CI produces
    carries zero LLM text** and nothing else would ever exercise the talk chrome (cogchemists,
    2026-08-24).
15. `client` unit tests (vitest + jsdom, cogherence's existing setup) — `HexBoard` renders 169
    `g.cg-tile`; a wet tile carries `data-wet="1"` and the `cg-drying` class; `data-state` is one of
    `wall|cracked|rubble`; `ScoreBug` renders nine rows with alias **and** policy name and the
    `/turn` + `/tick` figures; `WarLedger`'s `wars started` counter equals the distinct
    attacker→victim pairs in a fixture; `GameScrubberBar` rail cells are `<button>`s and a seek
    dismisses the endcard; **no alias leak**: `redact(state, seat)` output, stringified, contains no
    string from `config.players[].name`.

---

## Out of scope (v1)

- **Movement and bodies.** No per-tick agent locomotion, no zap beams in flight, no line-of-sight.
  Territory is turn-granular by decision (see "Why this is the right turn-granular equivalent"); MP's
  egocentric RGB observation and continuous action space are not ported.
- **Cogherence's dropped layers.** Coherence tug-of-war, the four minerals and COGS conversion,
  per-tile upkeep bills, and the per-turn Vickrey heart auction stay out; so does `abandon` (razing
  your own tile with salvage covers the orderly retreat).
- **Fog of war.** The board is fully observable in v1; only paint balances, pending orders and
  foreign DMs are hidden.
- **Binding agreements.** No escrow, no enforced treaty object, no contract primitive — talk is cheap
  talk, and `transfer` is the only substance.
- **Live play.** No human seats, no lobby, no `?live` hub path, no `serve-hub.ts`; the repo ships the
  coworld host and the static replay viewer only.
- **More than one decision per seat per turn.** No separate negotiate round trip, no multi-round
  bargaining inside a turn — the LLM budget does not afford it at nine seats.
- **Variant tuning as a league dimension.** Three map variants ship, but the league runs `open`;
  balancing `rooms` / `inside_out` against it is a later pass.
- **Wasm.** The static bundle is JS (vite) because the sim is TypeScript; no emscripten path is added.
- **RL/vector policies.** Both policy kinds here are container policies (LLM prompt, scripted); no
  observation tensor, no training harness.
