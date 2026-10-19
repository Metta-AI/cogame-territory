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
import { selectedVariant, type PromptSelection } from "./prompt-selection.js";

/** Direct JSON submission contract; parsed by SubmissionSchema. */
export const SUBMISSION_JSON_SCHEMA = {
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
    note: {
      type: "string",
      maxLength: MAX_NOTE_LEN,
      description: "Why you did this (spectators only).",
    },
  },
  required: ["orders"],
} as const;

const REPLY_CONTRACT = `REPLY CONTRACT
- Return one JSON object. \`orders\` is 0..${MAX_ORDERS_PER_TURN} entries; an empty list is a legal hold.
- \`messages\` is 0..${MAX_LINES} lines, each <= ${MAX_SAY_LEN} characters; \`to\` is null for a public
  broadcast or a Cog alias for a private DM. Extra lines are dropped. Talk is free,
  binds nobody, and every other Cog remembers what you promised.
- \`note\` is <= ${MAX_NOTE_LEN} characters and is read by spectators only.
- Your reply MUST begin with \`{\` and
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

${REPLY_CONTRACT}`;

const PRESENTATION_SECTIONS = {
  board: `The board is a radius-7 pointy-top axial hex lattice with 169 addresses written "q,r". Each tile progresses irreversibly from wall to cracked wall to rubble. Its base yield is 0..3: a wall retains that yield, a cracked wall pays floor(yield/2), and rubble pays zero. Even a yield-0 wall provides territory and a projection origin. Each Cog has a permanent ring-5 hearth; that coordinate and its up to six neighbours form the seven-coordinate home ring. Losing ground there can kill you.`,
  money: `Paint is the sole resource; you start with 12. Each turn, dry owned tiles pay their summed effective yield (${TICKS_PER_TURN} ticks times ${INCOME_PER_TICK_PER_YIELD} paint per tick per yield). A newly claimed tile is wet and pays no income this turn. Upkeep dries it; it earns from the next turn and can no longer be claimed by anyone. Only razing removes dry paint, making irreversible destruction the way into rival territory.`,
  orders: `There are three orders, and their cost is spent whether they succeed or fail.
Claim a wall or cracked tile that is unowned and within ${FLING_RANGE} of your nearest owned tile, or your hearth when you own none. Cost is ${CLAIM_BASE} + ${CLAIM_PER_DIST} times distance: 4 at distance 1 and 6 at distance 2.
Raze uses the same reach rule and opens on turn ${RAZE_OPEN_TURN}. It costs ${RAZE_COST}, or ${RAZE_HOME_COST} within one tile of another living Cog's hearth. The first raze cracks a wall, strips its claim, and permanently halves yield for everyone. The second makes unclaimable, zero-yield rubble that cannot conduct adjacency or project reach. A first raze of your own tile earns salvage of ${SALVAGE_MULT} times effective yield, available next turn.
Transfer sends an amount of paint to another living Cog by alias. You pay amount plus the ${TRANSFER_FEE} fee; the recipient can use it next turn.`,
  survival: `A strike occurs when another Cog razes a home-ring tile you owned at the start of the turn. Razing your own home ring does not strike you. One strike changes steady to publicly staggered. A strike on the immediately following turn eliminates a staggered Cog: all claims become unowned, paint becomes zero, and score freezes. A quiet turn instead restores steady.
The counter to a siege is to raze the attacker's nearest foothold: with nothing owned within 2 of your home ring, its second strike cannot land.`,
  simultaneous: `All nine Cogs decide simultaneously from the same board. Razes resolve before claims, and two razes on the same tile in one turn destroy it outright. Two Cogs claiming one free tile smear it: neither receives it and both pay in full. Negotiated borders are worth negotiating. A claim on a tile just razed to rubble is void but still spends paint.`,
  score: `Your score is all paint earned through income plus salvage. Higher is better; it never falls and freezes upon elimination. Spending does not directly lower score: aggression costs forgone future income for you and the board.
Break-even on cashing out a tile you hold is turn 14: before then holding is worth more; after then salvage is.`,
  budget: `Only stored paint counts for affordability. Salvage, incoming transfers, and income are next-turn funds. One illegal or unaffordable order rejects the entire order set. You receive one retry with the reason, then hold. Select tiles only from reach and razeReach.`,
} as const;

const HELDOUT_SECTIONS: Record<keyof typeof PRESENTATION_SECTIONS, string> = {
  board: `Play takes place on 169 pointy-top axial hexes within radius 7, addressed as "q,r". Wall, cracked wall, and rubble are successive irreversible states. Base yield ranges from 0 to 3; walls pay the full value, cracked walls pay its halved value rounded down, and rubble pays nothing. A zero-yield wall still provides territory and a projection origin. A Cog's permanent hearth is on ring 5; it and its up to six adjacent coordinates constitute the seven-coordinate home ring, where losing ground threatens survival.`,
  money: `Begin with 12 paint, the only currency. Each owned dry tile contributes its effective yield each turn: ${TICKS_PER_TURN} ticks at ${INCOME_PER_TICK_PER_YIELD} paint per yield per tick. Newly claimed wet tiles contribute nothing this turn and dry during Upkeep. Starting next turn they produce income and cannot be claimed again. Dry ownership is removed only through razing, so entering rival territory requires irreversible destruction.`,
  orders: `Order charges apply regardless of success. To claim, choose an unowned wall or cracked wall within ${FLING_RANGE} of your nearest owned tile, using your hearth when you own no tiles. Pay ${CLAIM_BASE} plus ${CLAIM_PER_DIST} per distance, hence 4 at distance 1 or 6 at distance 2.
Razing becomes available at turn ${RAZE_OPEN_TURN}, within the same reach. Pay ${RAZE_COST}, except within one of another living Cog's hearth, where the cost is ${RAZE_HOME_COST}. A wall's first raze removes ownership and permanently halves its yield for everybody. A cracked tile's next raze produces rubble: no yield, no claiming, no adjacency conduction, and no reach projection. First razing your own wall produces next-turn salvage of ${SALVAGE_MULT} times effective yield.
A transfer names a living recipient by alias. Sending an amount costs that amount plus ${TRANSFER_FEE}; it becomes the recipient's next-turn funds.`,
  survival: `An enemy raze strikes you only when it hits a home-ring tile you owned at turn start. Self-razing never strikes you. A steady Cog becomes visibly staggered after a strike. Another strike on the next turn eliminates it, releases every claim, zeros its paint, and freezes its score. Without a strike on that next turn it returns to steady.
The counter to a siege is to raze the attacker's nearest foothold: with nothing owned within 2 of your home ring, its second strike cannot land.`,
  simultaneous: `The nine decisions share a board snapshot and occur simultaneously. Resolve razes ahead of claims. Two razes of one tile in a turn fully destroy it. Competing claims smear a free tile, leaving it unowned while charging both claimants. Negotiated borders are worth negotiating. A claim made void by new rubble still costs paint.`,
  score: `Income and salvage accumulate into score: maximize this total earned paint. It cannot decrease and stops changing if you are eliminated. Expenditure itself does not subtract score; aggression sacrifices future income for you and the board.
Break-even on cashing out a tile you hold is turn 14: before then holding is worth more; after then salvage is.`,
  budget: `Use only paint already stored to fund orders. Income, salvage, and received transfers become spendable next turn. Any illegal or unaffordable entry invalidates the whole set. After one retry explaining the rejection, failure becomes a hold. Choose claim and raze tiles from reach and razeReach respectively.`,
};

const PRESENTATIONS = {
  plain: ["board", "money", "orders", "survival", "simultaneous", "score", "budget"],
  numbered: ["score", "board", "money", "orders", "budget", "simultaneous", "survival"],
  questions: ["board", "score", "money", "budget", "orders", "survival", "simultaneous"],
  reordered: ["survival", "simultaneous", "budget", "orders", "money", "score", "board"],
  "heldout-briefing": ["budget", "survival", "money", "score", "board", "orders", "simultaneous"],
  "heldout-reference": ["orders", "simultaneous", "board", "score", "survival", "budget", "money"],
} as const;
const QUESTIONS = {
  board: "Where are you and what can happen to a tile?",
  money: "How does paint become available?",
  orders: "Which orders can you issue and what do they cost?",
  survival: "What causes a strike or elimination?",
  simultaneous: "How are simultaneous conflicts resolved?",
  score: "What increases your score?",
  budget: "What can you afford and what happens after rejection?",
} as const;

/** The full system prompt for a doctrine. The doctrine block is appended last. */
export function systemPrompt(doctrine: string, selection: PromptSelection): string {
  const variant = selectedVariant(selection);
  let rules = RULES;
  if (variant !== "canonical") {
    const sections = PRESENTATIONS[variant].map((key, index) => {
      const heading = variant === "questions" ? QUESTIONS[key] :
        variant === "numbered" ? `${index + 1}. ${key.toUpperCase()}` : key.toUpperCase();
      const body = variant.startsWith("heldout-") ? HELDOUT_SECTIONS[key] : PRESENTATION_SECTIONS[key];
      return `${heading}\n${body}`;
    });
    rules = "You control one of nine Cogs claiming resource walls on a hex lattice.\n\n" +
      sections.join("\n\n") + "\n\n" + REPLY_CONTRACT;
  }
  const trimmed = doctrine.trim();
  if (!trimmed) return rules;
  return `${rules}\n\n--- YOUR DOCTRINE ---\n${trimmed}\n--- END DOCTRINE ---`;
}

/** The rules copy alone, for tests and the manifest docs. */
export const SYSTEM_PROMPT = RULES;

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

/** A compact text rendering of the observation: your line, the leaderboard, your
 *  tiles, `reach`/`razeReach` as explicit lists, your inbox and last turn's report. */
export function renderObservation(view: TerritoryObservation): string {
  const lines: string[] = [];
  lines.push(
    `TURN ${view.turn} of ${view.turns} — variant ${view.variant}, board radius ${view.radius}.`,
  );
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
      (mine.map((t) => `${t.t}[${t.state[0]}${t.yield}${t.wet ? " wet" : ""}]`).join(" ") ||
        "(none)"),
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
  lines.push(`Return JSON with at most ${view.maxOrders} orders. An empty list holds.`);
  return lines.join("\n");
}

/** Exact ordinary player messages, also consumed by the text-action training bridge. */
export function renderPlayerMessages(
  view: TerritoryObservation,
  doctrine: string,
  reason: string | null,
  selection: PromptSelection,
) {
  const host = reason
    ? `\n\nThe game rejected your previous move: ${reason}. Choose a different legal move.`
    : "";
  return [
    {
      role: "system" as const,
      content:
        systemPrompt(doctrine, selection) +
        `\nReturn JSON matching this schema: ${JSON.stringify(SUBMISSION_JSON_SCHEMA)}`,
    },
    { role: "user" as const, content: renderObservation(view) + host },
  ];
}
