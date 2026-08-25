// Territory's coworld manifest, assembled with @cogweb/coworld's `buildManifest`.
//
// GENERATED, NEVER HAND-EDITED: `pnpm emit-manifest` runs
// `buildTerritoryManifest()` through the builder and writes
// `coworld_manifest_template.json` at the repo root; a test asserts the committed
// file equals this generator's output.
//
// The image placeholder is derived from the COMPOSE SERVICE NAME, which is
// `territory` — hence `{{TERRITORY_IMAGE}}`. `{{GAME_IMAGE}}` is not a thing once
// the service is not named `game` (lantern 0.1.0).
//
// `game.name` is `"territory"` with NO underscore: the secret namespace must
// equal `game.name` and the page slug is the same string, so
// `secret://coworld/territory/anthropic_api_key` and `POST /coworld-league-seeds`
// agree.

import { buildManifest } from "@cogweb/coworld";
import type { CoworldManifest, JsonSchema, PlayerRunnable, Variant } from "@cogweb/coworld";

import {
  BATCH_MIN_MS,
  CLAIM_BASE,
  CLAIM_PER_DIST,
  FLING_RANGE,
  MAX_ORDERS_PER_TURN,
  MAX_TURNS,
  RAZE_COST,
  RAZE_HOME_COST,
  RAZE_OPEN_TURN,
  SALVAGE_MULT,
  SEATS,
  STARTING_PAINT,
  TICKS_PER_TURN,
  TRANSFER_FEE,
} from "../shared/engine/constants.js";

const TERRITORY_IMAGE = "{{TERRITORY_IMAGE}}";
const SOURCE_TREE = "https://github.com/Metta-AI/cogame-territory/tree/main";

// ── config / results JSON-Schema contracts ───────────────────────────────────
// Hand-authored draft-2020-12 schemas (the repo has no zod-to-json-schema dep).
// EVERY ARRAY CARRIES minItems/maxItems: the cert validator rejects an unbounded
// array property (tandem 0.1.0), and the ladder infers the round's seat count
// from `players` length / `num_agents`.

const configSchema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["tokens", "players"],
  properties: {
    tokens: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: SEATS,
      maxItems: SEATS,
      description: "Per-seat auth tokens injected by the runner; length is the fixed seat count.",
    },
    num_agents: {
      type: "integer",
      minimum: SEATS,
      maximum: SEATS,
      description:
        "Seat count for the episode. The platform ladder reads this from the variant " +
        "game_config to size a Competition round. Always nine.",
    },
    players: {
      type: "array",
      minItems: SEATS,
      maxItems: SEATS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string", minLength: 1 } },
      },
      description:
        "Per-seat player display names (seat order). The platform injects the real policy/" +
        "player names here; they ride the roster frame and the replay envelope ONLY — the " +
        "agents themselves see nine fixed anonymous aliases and never a policy name.",
    },
    seed: {
      type: "integer",
      description:
        "Optional deterministic episode seed. Omit it for a fresh random board per episode " +
        "(the league default); the certification fixture pins one for a reproducible run.",
    },
    variant: {
      type: "string",
      enum: ["open", "rooms", "inside_out"],
      description: "Board-generation overlay. Same seats, same rules, same turn count.",
    },
    paceMs: {
      type: "integer",
      minimum: 0,
      description:
        `Floor on the spacing between decision batches, in ms (default ${BATCH_MIN_MS}). ` +
        "The certification fixture pins 0 so the offline run finishes instantly.",
    },
    turns: {
      type: "integer",
      minimum: 1,
      description: `Turn horizon (default ${MAX_TURNS}).`,
    },
  },
};

const resultsSchema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["scores", "reason"],
  properties: {
    scores: {
      type: "array",
      items: { type: "number" },
      minItems: SEATS,
      maxItems: SEATS,
      description:
        "Gross paint EARNED per seat (income + salvage), in seat order. HIGHER IS BETTER; " +
        "the league ranks by exactly this number with no transformation.",
    },
    reason: {
      type: "string",
      enum: ["complete", "elimination", "deadline"],
      description:
        "complete = all turns played; elimination = at most one seat left standing; " +
        "deadline = the wall-clock guard settled the episode early (artifacts still written).",
    },
    turnsPlayed: { type: "integer", minimum: 0, description: "How far the episode got." },
    fallbacks: {
      type: "array",
      items: { type: "integer" },
      minItems: SEATS,
      maxItems: SEATS,
      description: "Per seat: decisions that fell back to a scripted/hold move.",
    },
    eliminated: {
      type: "array",
      items: { type: "integer" },
      minItems: 0,
      maxItems: SEATS,
      description: "Seats permanently eliminated, ascending.",
    },
    razes: {
      type: "array",
      items: { type: "integer" },
      minItems: SEATS,
      maxItems: SEATS,
      description: "Razes committed per seat (the displayed tie-break, and the ledger).",
    },
    destroyed: { type: "integer", minimum: 0, description: "Tiles razed all the way to rubble." },
    poolStart: { type: "number", description: "Board income pool at full claim, turn 1." },
    poolEnd: { type: "number", description: "The same pool at the end. The deadweight loss." },
    replayUri: { type: "string", description: "Pointer to the saved replay artifact, if one was written." },
  },
};

// ── runnables ────────────────────────────────────────────────────────────────
// Both declared players are seated in the certification fixture: every
// manifest-declared runnable must occupy a certification slot or cert fails
// `players_missing` (raid 0.1.2).

const players: PlayerRunnable[] = [
  {
    type: "player",
    id: "territory-homesteader",
    name: "Territory Homesteader",
    image: TERRITORY_IMAGE,
    run: ["/bin/territory-player"],
    env: { PLAYER_SCRIPTED: "homesteader" },
    source_url: SOURCE_TREE,
    description:
      "Deterministic no-LLM baseline: claims the richest reachable wall it can afford, never " +
      "razes. Always legal, so it certifies the contract offline.",
  },
  {
    type: "player",
    id: "territory-raider",
    name: "Territory Raider",
    image: TERRITORY_IMAGE,
    run: ["/bin/territory-player"],
    env: { PLAYER_SCRIPTED: "raider" },
    source_url: SOURCE_TREE,
    description:
      "Deterministic no-LLM baseline: homesteads, then from turn 4 razes the leader's richest " +
      "reachable wall.",
  },
];

/** Nine placeholder seat names the platform overwrites with the seated policies. */
const PLACEHOLDER_PLAYERS = Array.from({ length: SEATS }, (_, i) => ({
  name: `Cog ${String.fromCharCode(65 + i)}`,
}));

// Three map variants; `num_agents: 9` in EVERY one. No pinned seed — a fresh
// board per league episode.
const variants: Variant[] = [
  {
    id: "open",
    name: "Open Field (9 players)",
    description: "Plain seeded yields, no barriers. The league default.",
    game_config: {
      players: PLACEHOLDER_PLAYERS,
      num_agents: SEATS,
      variant: "open",
      turns: MAX_TURNS,
      paceMs: BATCH_MIN_MS,
    },
  },
  {
    id: "rooms",
    name: "Rooms (9 players)",
    description:
      "Nine private rooms: each hearth's neighbours are rich and a ring of rubble walls them " +
      "in but for one gap. A peaceful partition is available on turn 1.",
    game_config: {
      players: PLACEHOLDER_PLAYERS,
      num_agents: SEATS,
      variant: "rooms",
      turns: MAX_TURNS,
      paceMs: BATCH_MIN_MS,
    },
  },
  {
    id: "inside_out",
    name: "Inside Out (9 players)",
    description: "All the wealth is central and shared; the rim is barren, so contact is immediate.",
    game_config: {
      players: PLACEHOLDER_PLAYERS,
      num_agents: SEATS,
      variant: "inside_out",
      turns: MAX_TURNS,
      paceMs: BATCH_MIN_MS,
    },
  },
];

const RULES_DOC = `# Territory — rules

Nine Cogs paint their claim onto a hex lattice of resource walls. A claimed wall pays income
forever — until someone **razes** it, which is permanent: one raze strips the claim and halves the
wall's yield **for everyone, for the rest of history**; a second raze turns it to **rubble**,
unclaimable and inert. Push a raze into a Cog's **home ring** twice in two consecutive turns and
that Cog is **eliminated** — gone, all its claims reverting to unclaimed ground. Talk is free,
public or private, and binds nobody. The board only ever gets poorer. The question the game asks
is whether nine agents can keep it rich.

## Board

| Thing | Value |
|---|---|
| Lattice | pointy-top axial hexes, radius 7 → 169 tiles |
| Tile state | \`wall\` / \`cracked\` / \`rubble\` (irreversible, in that order) |
| Tile yield | integer 0..3, seeded per tile |
| Tile ownership | owner, \`wet\`, \`claimedTurn\` |
| Hearths | one immutable spawn hex per seat, on ring 5, minimum pairwise distance 3 |
| Turns | ${MAX_TURNS}, each turn = ${TICKS_PER_TURN} sim ticks |

Yields are drawn from the episode seed: \`u < 0.45 → 0\`, \`< 0.75 → 1\`, \`< 0.92 → 2\`, else 3. A
yield-0 wall is still claimable — it is territory and a projection origin — and pays nothing. At
full claim the board pays about 149 paint/turn, i.e. ~16.5/turn/seat if it were partitioned nine
ways and nothing were ever razed. Every raze permanently subtracts from that pool.

## Currency and income

- **Effective yield**: wall → yield, cracked → floor(yield/2), rubble → 0.
- **Income**: each seat earns the summed effective yield of its **dry** owned tiles, every turn.
- **Per-tick correspondence**: effYield × ${TICKS_PER_TURN} ticks × 0.04 paint/tick = effYield paint per
  turn, so the thinnest wall pays exactly one whole paint per turn and every number a spectator
  reads is an integer.
- **Drying**: paint applied in turn *T* is wet for that turn (pays nothing) and dries in *T*'s
  Upkeep. From *T+1* the tile pays income and **can no longer be claimed by anybody**. Dry paint
  comes off only by razing. Irreversibility is the only door into a rival's territory.
- Each seat starts with ${STARTING_PAINT} paint and owns its hearth, dry.

## Orders

| Order | Legality | Cost (paint, charged win or lose) |
|---|---|---|
| \`claim {tile}\` | wall/cracked, unowned, within ${FLING_RANGE} of your nearest owned tile (or your hearth if you own nothing) | ${CLAIM_BASE} + ${CLAIM_PER_DIST} × distance → 4 at distance 1, 6 at distance 2 |
| \`raze {tile}\` | turn ≥ ${RAZE_OPEN_TURN}; wall/cracked; same reach rule | ${RAZE_COST}, or ${RAZE_HOME_COST} within distance 1 of another living seat's hearth |
| \`transfer {to, amount}\` | \`to\` is another living seat's alias, amount ≥ 1, affordable | amount + ${TRANSFER_FEE}; lands as the recipient's next-turn money |

At most ${MAX_ORDERS_PER_TURN} orders per turn. An empty list is a legal hold. **Any illegal or unaffordable
entry rejects the whole set**: the host re-requests once with the reason, then the seat holds.
Affordability is checked against **stored paint only** — salvage, transfers received and income are
next-turn money.

Razing a tile **you own** is legal from turn ${RAZE_OPEN_TURN} and pays salvage = ${SALVAGE_MULT} × effective yield as
next-turn money, on the first raze only. Break-even against holding is turn 14.

## The two irreversibility rules

**Permanent wall destruction.** Raze #1: wall → cracked, the claim is stripped and the yield is
halved forever for whoever holds it next. Raze #2: cracked → rubble — income 0 forever, never
claimable again, and it stops conducting adjacency, so nobody may project a claim or a raze *from*
it. Two razes on the same tile in the same turn destroy it outright.

**Permadeath.** A seat is *struck* in turn *T* iff at least one raze by **another** seat in *T*
lands on a tile inside its **home ring** (its hearth plus the ≤6 neighbours) which it **owned at the
start of that turn's Resolve**. steady + struck → **staggered**; staggered + struck the very next
turn → **eliminated**; staggered + a quiet turn → steady. On elimination every tile reverts to
unclaimed ground (tile *state* untouched), paint is zeroed and the score freezes.

The besieged seat has a real counter: raze the attacker's nearest foothold. With nothing owned
within ${FLING_RANGE} of the home ring, the second strike cannot land. The destruction rule is
simultaneously the weapon and the shield.

## Turn structure

Every turn is one decision point per living seat, all seats asked **simultaneously as one parallel
batch**, each reply carrying that seat's talk lines *and* its orders. Resolution order:
validate + budget → talk → **raze** → strike bookkeeping → **claim** → transfer → charge → upkeep
(dry → income → credit → life → advance). Razes precede claims, so a partner can raze and you can
claim the freed tile in the same turn. Two claimants on one free tile **smear** it: nobody holds it
and both pay in full.

## Scoring

\`score(seat) = Σ income + Σ salvage\` — gross paint EARNED, never spent-adjusted. **Higher is
better.** It is monotone non-decreasing and freezes on elimination, and the league ranks by exactly
that number. Spending paint never reduces your score directly: aggression is paid for in forgone
future income, yours and the board's.

The episode ends \`complete\` (all turns played), \`elimination\` (at most one seat left), or
\`deadline\` (the wall-clock guard settles it early — results and replay are still written).`;

const STRATEGY_DOC = `# Territory — strategy

- **Back your frontier in blobs.** Reach is ${FLING_RANGE} tiles from your nearest owned tile, so a
  connected mass gives you options and a thin spike gives you one. Claim toward the richest walls
  you can still afford next turn, not the richest wall on the board.
- **Dry paint is safe; wet paint smears.** A tile you claimed this turn pays nothing and can be
  contested by anyone who also claimed it — and then NOBODY holds it and you both paid. This is
  the only same-turn contest in the game, and it is exactly why a negotiated border is worth
  negotiating. Say which tile you are taking, then take it.
- **A raze is negative-sum.** It costs you ${RAZE_COST} paint (or ${RAZE_HOME_COST} near a hearth), pays you nothing,
  and burns yield off the board *forever*, for everyone including you. The board only gets poorer.
  Every raze you do not make is income you and your neighbour both keep.
- **Hold a foothold hostage instead of a home.** Striking a home ring is the loudest, most
  expensive move available: 20 paint and two turns of public warning for an assassination, and the
  target can end it by razing your nearest foothold. Threatening a rival's *frontier* tile is
  cheaper and more credible than threatening their life.
- **Count what you cannot see.** Every seat's walls, income, score and raze count are public;
  their **paint balance is not**. That is the one number that makes a threat bluffable — yours and
  theirs.
- **After turn 14, salvage beats holding.** \`${SALVAGE_MULT} × effYield\` now versus \`effYield × (${MAX_TURNS} − T)\`
  later: the last-turn strip-mine is a real, priced option. So is the reputation you spend on it,
  because your neighbours can read the clock too.
- **Talk is free and remembered.** Nothing binds, \`transfer\` is the only substance, and the replay
  shows every DM you sent. Name the seats you trust, say what you will do next turn, then do it.`;

const DEADWEIGHT_DOC = `# What Territory measures

Territory is a deadweight-loss experiment wearing a board game. The read-out is on the endcard.

**\`poolStart → poolEnd\`.** The income pool is the summed effective yield of the whole board — what
nine agents would collectively earn per turn if every tile were claimed and nothing were ever
razed (about 149 paint/turn at radius 7). Every first raze halves a wall's yield forever; every
second raze zeroes it. \`poolEnd\` is that same number at the end of the episode, and
\`poolStart − poolEnd\` is the wealth the nine of them destroyed and can never recover. It is
printed on the endcard as \`income pool 149 → 121 (−19 %)\`.

**\`destroyed\`.** Tiles taken all the way to rubble: holes in the lattice that are inert, never
claimable again, and that stop conducting adjacency — so they also destroy the *option value* of
everything they used to be a projection origin for.

**\`warsStarted\`.** Distinct ordered pairs (attacker, victim) whose first raze on the victim's
ground has occurred. A board where nine seats partition the lattice and honour their borders reads
0. A board that dissolves into a free-for-all reads 30+. This is the number that says whether
cheap talk did any work.

**\`eliminated\`.** Permadeath needs sustained presence, not a snipe: two strikes in two consecutive
turns, 20 paint, and two turns of public warning during which the target can raze your foothold and
end it. An elimination therefore means an alliance held long enough to finish someone — the most
expensive coordination the game can show.

**How to read the endcard.** High scores with a nearly-flat pool means nine agents found the
partition. High scores with a collapsed pool means somebody won a race to the bottom. Low scores
with a collapsed pool and several eliminations is the tragedy in full: everyone paid for the
destruction and nobody kept the ground. \`results.fallbacks\` is the honesty check — a seat whose
fallback count is high was not thinking, and its score says nothing about its doctrine.`;

/** Assemble (and validate) Territory's coworld manifest. */
export function buildTerritoryManifest(): CoworldManifest {
  return buildManifest({
    id: "territory",
    description:
      "Nine LLM Cogs paint their claim onto a hex lattice of resource walls. A claimed wall pays " +
      "income forever — until someone razes it, and razing is permanent: once to strip the claim " +
      "and halve the yield for everyone, twice to turn the wall into rubble that can never be " +
      "claimed again. Strike a Cog's home ring in two consecutive turns and it is eliminated, its " +
      "whole territory reverting to unclaimed ground. Talk is free, public or private, and binds " +
      "nobody. The board only ever gets poorer; the score is gross paint earned. The question is " +
      "whether nine agents can keep it rich.",
    owner: "daveey@gmail.com",
    tags: ["board", "territory", "mixed-motive", "negotiation"],
    gameImage: TERRITORY_IMAGE,
    gameRun: ["/bin/territory"],
    sourceUrl: SOURCE_TREE,
    episodeTimeoutMinutes: 20,
    // The proven package-relative path to the vite-built static bundle. NEVER a
    // /client/replay pod viewer: certification must report
    // "Replay liveness: skipped (static replay bundle declared".
    replayViewerBundle: "build/static-replay-viewer",
    configSchema,
    resultsSchema,
    players,
    protocols: {
      player: {
        type: "text",
        value:
          "Connect to the game's `/player?slot=&token=` route (the runner injects the URL as " +
          "COWORLD_PLAYER_WS_URL; a bad slot/token gets 401). Frames are JSON over the shared " +
          "`cogweb.player.v1` protocol. On `welcome` record your slot and the public config " +
          "(seats, turns, variant, ticksPerTurn, aliases). On each `observation` the `view` is " +
          "your redacted board — the whole lattice, every seat's alias/life/walls/income/score/" +
          "razes, your own paint, your `reach` and `razeReach` (the exact legal claim and raze " +
          "sets, precomputed by the same predicate the validator applies), your `inbox` and last " +
          "turn's report. Reply with a `reply` whose `decision` is " +
          '`{ "orders": [...], "messages": [...], "note": "..." }`: an order is one of ' +
          "`{type:'claim',tile}`, `{type:'raze',tile}`, `{type:'transfer',to,amount}` (0–8 " +
          "entries; an empty list holds), `messages` is 0–3 `{to, text}` lines where `to` is null " +
          "for a public broadcast or another cog's ALIAS for a private DM, and `note` is " +
          "spectator-only. Any illegal or unaffordable order rejects the WHOLE set: you get one " +
          "fresh `observation` with `reason` set, and then the seat holds. `final` carries the " +
          "per-slot scores.",
      },
      global: {
        type: "text",
        value:
          "Read-only spectator `ServerMessage` stream: one `lobby` roster frame (seat → the REAL " +
          "policy/player name, which the agents never saw), then per turn a full `snapshot` (the " +
          "complete tile array plus every seat's public state) and the turn's events. The event " +
          "vocabulary is exactly: order, rejected, talk, raze, salvage, struck, claim, smear, " +
          "voided, transfer, income, dried, recovered, eliminated, endcard — and `endcard` carries " +
          "{reason, turnsPlayed, scores, walls, destroyed, poolStart, poolEnd, warsStarted} so the " +
          "final panel needs no derivation. Every turn contributes at least one full snapshot, so " +
          "a viewer re-derives each frame with no server and no interpolation. The saved replay is " +
          '`{"protocol":"cogweb.replay.v1", frames, players, config, results, usage}`. ' +
          "Spectators send nothing.",
      },
    },
    readme: { type: "uri", value: `${SOURCE_TREE}/README.md` },
    docs: [
      { id: "rules.md", title: "Rules", content: { type: "text", value: RULES_DOC } },
      { id: "strategy.md", title: "Strategy", content: { type: "text", value: STRATEGY_DOC } },
      { id: "deadweight.md", title: "What it measures", content: { type: "text", value: DEADWEIGHT_DOC } },
    ],
    variants,
    certification: {
      // A pinned seed and NO pacing, so the offline run finishes well inside
      // `coworld certify`'s 60 s default. num_agents nine, again.
      game_config: {
        seed: 7,
        variant: "open",
        turns: MAX_TURNS,
        paceMs: 0,
        num_agents: SEATS,
        players: PLACEHOLDER_PLAYERS,
      },
      players: [
        ...Array.from({ length: 5 }, () => ({ player_id: "territory-homesteader" })),
        ...Array.from({ length: 4 }, () => ({ player_id: "territory-raider" })),
      ],
    },
    schemaUrl: "https://raw.githubusercontent.com/Metta-AI/coworld/main/src/coworld/coworld_manifest_schema.json",
  });
}

/** The assembled manifest object (validated on module load). */
export const territoryManifest: CoworldManifest = buildTerritoryManifest();
