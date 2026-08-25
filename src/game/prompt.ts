// The LLM policy's prompt surface: the full rules copy, the `submit_turn` tool
// whose input schema IS the reply schema, and the compact text rendering of the
// observation. Cogherence keeps its prompt under `src/agents/`, which Territory
// deletes, so the prompt moves beside the seam.
//
// STRUCTURED OUTPUT: the autopilot offers exactly one tool, `submit_turn`, whose
// input schema is the reply schema, so `robustDecide` forces the tool call and
// validates its input. The system prompt ALSO states the JSON-first contract,
// because Haiku answers prose-first otherwise.

import {
  CLAIM_BASE,
  CLAIM_PER_DIST,
  FLING_RANGE,
  INCOME_PER_TICK_PER_YIELD,
  MAX_LINES,
  MAX_NOTE_LEN,
  MAX_ORDERS_PER_TURN,
  MAX_SAY_LEN,
  RAZE_COST,
  RAZE_HOME_COST,
  RAZE_OPEN_TURN,
  SALVAGE_MULT,
  TICKS_PER_TURN,
  TRANSFER_FEE,
} from "../shared/engine/constants.js";
import type { TerritoryObservation } from "./redact.js";

/** The one tool the model may call. Its input schema IS the reply schema. */
export const SUBMIT_TURN_TOOL = {
  name: "submit_turn",
  description:
    "Submit this turn's orders and talk lines. An empty `orders` list is a legal hold. " +
    "Any illegal or unaffordable entry rejects the WHOLE set, so only use tiles from " +
    "`reach` / `razeReach` and keep the total cost within your stored paint.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      orders: {
        type: "array",
        maxItems: MAX_ORDERS_PER_TURN,
        description: `At most ${MAX_ORDERS_PER_TURN} orders, applied in this order.`,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["claim", "raze", "transfer"] },
            tile: { type: "string", description: 'A tile address like "3,-2" (claim / raze).' },
            to: { type: "string", description: "Another living cog's alias (transfer)." },
            amount: { type: "integer", minimum: 1, description: "Paint to send (transfer)." },
          },
          required: ["type"],
        },
      },
      messages: {
        type: "array",
        maxItems: MAX_LINES,
        description: `At most ${MAX_LINES} lines; extras are dropped.`,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            to: {
              type: ["string", "null"],
              description: "null for a public broadcast, or a cog alias for a private DM.",
            },
            text: { type: "string", maxLength: MAX_SAY_LEN },
          },
          required: ["text"],
        },
      },
      note: { type: "string", maxLength: MAX_NOTE_LEN, description: "Why you did this (spectators only)." },
    },
    required: ["orders"],
  },
} as const;

const RULES = `You are one of nine Cogs painting your claim onto a hex lattice of resource walls.

THE BOARD
- Pointy-top axial hexes, radius 7 => 169 tiles. A tile address is "q,r".
- Every tile is a WALL, a CRACKED wall, or RUBBLE. That order is IRREVERSIBLE.
- Every tile has a yield 0..3. Effective yield: wall = yield, cracked = floor(yield/2),
  rubble = 0. A yield-0 wall is still worth claiming: it is territory and a
  projection origin.
- Each Cog has one permanent HEARTH coordinate on ring 5, plus its <= 6 neighbours:
  together those 7 coordinates are its HOME RING. Losing ground there is what kills you.

MONEY
- Paint is the only resource. You start with 12 and earn income every turn.
- INCOME: each turn you gain the summed effective yield of your DRY owned tiles.
  (${TICKS_PER_TURN} ticks x ${INCOME_PER_TICK_PER_YIELD} paint per tick per yield = exactly
  1 whole paint per turn per point of effective yield.)
- A tile you claim THIS turn is WET: it pays nothing this turn and dries in Upkeep.
  From next turn it pays income and NOBODY can claim it any more. Dry paint comes off
  only by razing. Irreversibility is the only door into a rival's territory.

THE THREE ORDERS (cost is charged win or lose)
1. claim {tile}   - the tile must be wall/cracked, unowned, and within ${FLING_RANGE}
                    of your nearest owned tile (or your hearth if you own nothing).
                    Cost = ${CLAIM_BASE} + ${CLAIM_PER_DIST} x distance -> 4 at distance 1, 6 at distance 2.
2. raze {tile}    - legal from turn ${RAZE_OPEN_TURN}. Same reach rule. Cost ${RAZE_COST} paint,
                    or ${RAZE_HOME_COST} if the tile is within 1 of ANOTHER living Cog's hearth.
                    First raze: wall -> cracked, the claim is stripped and the yield is
                    HALVED FOREVER, for everyone. Second raze: cracked -> rubble, worth
                    nothing for the rest of history, never claimable again, and it stops
                    conducting adjacency - nobody can project from rubble.
                    Razing a tile YOU own pays salvage = ${SALVAGE_MULT} x effective yield as
                    next-turn money, on the first raze only.
3. transfer {to, amount} - move paint to another living Cog by ALIAS. Costs amount +
                    ${TRANSFER_FEE} fee; it lands as their NEXT-turn money.

PERMADEATH
- You are STRUCK in a turn if another Cog's raze lands on a tile inside your home ring
  that you owned at the start of that turn. Razing your own home ring never strikes you.
- steady + struck -> STAGGERED (public). staggered + struck the very next turn ->
  ELIMINATED: gone, every claim reverts to unclaimed ground, paint zeroed, score frozen.
  staggered + a quiet turn -> back to steady.
- The counter to a siege is to raze the attacker's nearest foothold: with nothing owned
  within 2 of your home ring, its second strike cannot land.

SIMULTANEITY AND CONTESTS
- All nine Cogs are asked at the same time and see the identical board. Razes resolve
  before claims. Two razes on one tile in one turn destroy it outright.
- Two Cogs claiming the same free tile SMEAR it: nobody holds it and both pay in full.
  Negotiated borders are worth negotiating.
- Claiming a tile a raze turned to rubble is VOID and the paint is still spent.

SCORING
- score = total paint EARNED (income + salvage). HIGHER IS BETTER. It never falls and it
  freezes if you are eliminated. Spending paint never reduces your score directly:
  aggression is paid for in forgone future income, yours and the board's.
- Break-even on cashing out a tile you hold is turn 14: before then holding is worth
  more; after then salvage is.

BUDGET
- Affordability is checked against your STORED paint only. Salvage, transfers received
  and income are NEXT-turn money.
- Any illegal or unaffordable entry rejects your WHOLE order set: you are asked once
  more with the reason, and then you hold. Use only tiles from \`reach\` and \`razeReach\`.

REPLY CONTRACT
- Call the \`submit_turn\` tool. \`orders\` is 0..${MAX_ORDERS_PER_TURN} entries; an empty list is a legal hold.
- \`messages\` is 0..${MAX_LINES} lines, each <= ${MAX_SAY_LEN} characters; \`to\` is null for a public
  broadcast or a Cog alias for a private DM. Extra lines are dropped. Talk is free,
  binds nobody, and every other Cog remembers what you promised.
- \`note\` is <= ${MAX_NOTE_LEN} characters and is read by spectators only.
- If you answer in text instead of calling the tool, your reply MUST begin with \`{\` and
  contain nothing but the JSON object.

A WORKED TURN
  You are Cobalt with 14 paint, holding 3 tiles. \`reach\` offers "4,-2" (yield 3, distance 1)
  and "3,-1" (yield 1, distance 2). \`razeReach\` offers "3,-2", a yield-3 wall Sable owns.
  Claiming "4,-2" costs 4 and pays 3/turn forever. Razing "3,-2" costs 5, pays nothing, and
  burns 2 yield off the board permanently. A steward claims and proposes a border; a
  condottiere claims, then sells Sable protection. Either way you spend at most 14.
  { "orders": [{"type":"claim","tile":"4,-2"}],
    "messages": [{"to": null, "text": "Cobalt takes 4,-2. Sable, the ridge east of 3,-2 is yours if you leave my hearth alone."}],
    "note": "cheap rich wall, open with a border offer" }`;

/** The full system prompt for a doctrine. The doctrine block is appended last. */
export function systemPrompt(doctrine: string): string {
  const trimmed = doctrine.trim();
  if (!trimmed) return RULES;
  return `${RULES}\n\n--- YOUR DOCTRINE ---\n${trimmed}\n--- END DOCTRINE ---`;
}

/** The rules copy alone, for tests and the manifest docs. */
export const SYSTEM_PROMPT = RULES;

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

/** A compact text rendering of the observation: your line, the leaderboard, your
 *  tiles, `reach`/`razeReach` as explicit lists, your inbox and last turn's report. */
export function renderObservation(view: TerritoryObservation): string {
  const lines: string[] = [];
  lines.push(`TURN ${view.turn} of ${view.turns} — variant ${view.variant}, board radius ${view.radius}.`);
  lines.push(
    `YOU are ${view.you.alias} (seat ${view.you.seat}), ${view.you.state}. ` +
      `paint ${view.you.paint} · walls ${view.you.walls} · income last turn ${view.you.incomeLastTurn} · ` +
      `score ${view.you.banked} · hearth ${view.you.hearth}`,
  );
  lines.push("");
  lines.push("LEADERBOARD (score · walls · income/turn · razes · state)");
  for (const c of [...view.cogs].sort((a, b) => b.banked - a.banked || a.seat - b.seat)) {
    lines.push(
      `  ${pad(c.alias, 8)} ${pad(String(c.banked), 5)} ${pad(String(c.walls), 4)} ` +
        `${pad(String(c.incomeLastTurn), 4)} ${pad(String(c.razesMade), 3)} ${c.alive ? c.state : "ELIMINATED"}`,
    );
  }

  const mine = view.tiles.filter((t) => t.owner === view.you.alias);
  lines.push("");
  lines.push(
    `YOUR TILES (${mine.length}): ` +
      (mine.map((t) => `${t.t}[${t.state[0]}${t.yield}${t.wet ? " wet" : ""}]`).join(" ") || "(none)"),
  );

  const rivalHome = view.tiles.filter((t) => t.hearthOf !== null && t.hearthOf !== view.you.alias);
  lines.push(
    `HEARTHS: ` +
      rivalHome.map((t) => `${t.hearthOf}@${t.t}`).join(" ") +
      ` · yours ${view.you.hearth}`,
  );

  lines.push("");
  lines.push(`REACH — every tile you may CLAIM this turn (${view.reach.length}):`);
  lines.push(
    "  " +
      (view.reach
        .map((k) => {
          const t = view.tiles.find((x) => x.t === k);
          return `${k}(y${t?.yield ?? 0}${t?.state === "cracked" ? " cracked" : ""})`;
        })
        .join(" ") || "(none)"),
  );
  lines.push(
    `RAZEREACH — every tile you may RAZE this turn (${view.razeReach.length}${
      view.turn < view.razeOpensTurn ? `; razing opens on turn ${view.razeOpensTurn}` : ""
    }):`,
  );
  lines.push(
    "  " +
      (view.razeReach
        .map((k) => {
          const t = view.tiles.find((x) => x.t === k);
          return `${k}(y${t?.yield ?? 0}${t?.owner ? ` ${t.owner}` : " free"})`;
        })
        .join(" ") || "(none)"),
  );

  lines.push("");
  lines.push("LAST TURN");
  lines.push(`  rejected: ${view.lastTurn.rejected ?? "no"}`);
  lines.push(`  razed against you: ${view.lastTurn.razedAgainstYou.join(" ") || "none"}`);
  lines.push(`  smeared: ${view.lastTurn.smeared.join(" ") || "none"}`);
  lines.push(`  struck by: ${view.lastTurn.struckBy.join(" ") || "nobody"}`);
  lines.push(`  salvage banked: ${view.lastTurn.salvage}`);

  lines.push("");
  lines.push("INBOX (last 12)");
  if (view.inbox.length === 0) lines.push("  (silence on the wire)");
  for (const m of view.inbox) {
    lines.push(`  T${m.turn} ${m.from} ${m.scope === "dm" ? "(to you)" : "(public)"}: ${m.text}`);
  }

  if (view.log.length > 0) {
    lines.push("");
    lines.push("RECENT BOARD EVENTS");
    for (const l of view.log) lines.push(`  ${l}`);
  }

  lines.push("");
  lines.push(`Call submit_turn with at most ${view.maxOrders} orders. An empty list holds.`);
  return lines.join("\n");
}
