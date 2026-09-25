import { env } from "node:process";

import { JevClient, type JevSystemOneRequest } from "@cogweb/llm";
import type { PlayerDecideContext } from "@cogweb/coworld";

import { CLAIM_COST } from "../shared/engine/constants.js";
import { SubmissionSchema, type Submission } from "../shared/engine/orders.js";
import type { TerritoryDecision, TerritorySeamState, TerritoryView } from "./game.js";
import type { TerritoryObservation } from "./redact.js";
import { homesteader, raider, razeCostOf, reachDistance, scriptedDecide } from "./scripted.js";

type Ctx = PlayerDecideContext<TerritorySeamState, TerritoryDecision, TerritoryView>;

/** Jev chooses complete ordinary order sets, then a separate public or private talk line. */
export function makeJevDecide(baseline: string, suppliedClient?: Pick<JevClient, "systemOne">) {
  const credentialsAvailable = Boolean(env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME || env.TYPESAFE_API_KEY);
  const client = suppliedClient ?? (credentialsAvailable ? new JevClient({ timeoutMs: 10_000 }) : null);
  return async (ctx: Ctx): Promise<TerritoryDecision> => {
    const view = ctx.view as TerritoryObservation;
    if (!client) {
      console.log(JSON.stringify({ kind: "jev_no_credentials", seat: ctx.seat, turn: ctx.turn }));
      return { ...scriptedDecide(baseline, view), fallback: true };
    }

    const plans: Submission["orders"][] = [];
    const seen = new Set<string>();
    for (const orders of [[], homesteader(view).orders, raider(view).orders]) {
      const key = JSON.stringify(orders);
      if (!seen.has(key)) {
        plans.push(orders);
        seen.add(key);
      }
    }

    const tiles = new Map(view.tiles.map((tile) => [tile.t, tile]));
    for (const tile of [...view.reach]
      .sort((a, b) => (tiles.get(b)?.yield ?? 0) - (tiles.get(a)?.yield ?? 0) || a.localeCompare(b))
      .slice(0, 12)) {
      if (CLAIM_COST(reachDistance(view, tile)) > view.you.paint) continue;
      const orders: Submission["orders"] = [{ type: "claim", tile }];
      const key = JSON.stringify(orders);
      if (!seen.has(key)) {
        plans.push(orders);
        seen.add(key);
      }
    }
    for (const tile of [...view.razeReach]
      .filter((tile) => tiles.get(tile)?.owner !== null)
      .sort((a, b) => (tiles.get(b)?.yield ?? 0) - (tiles.get(a)?.yield ?? 0) || a.localeCompare(b))
      .slice(0, 12)) {
      if (razeCostOf(view, tile) > view.you.paint) continue;
      const orders: Submission["orders"] = [{ type: "raze", tile }];
      const key = JSON.stringify(orders);
      if (!seen.has(key)) {
        plans.push(orders);
        seen.add(key);
      }
    }
    if (view.you.paint > 2) {
      for (const cog of view.cogs.filter((cog) => cog.alive && cog.seat !== view.you.seat)) {
        plans.push([{ type: "transfer", to: cog.alias, amount: Math.max(1, Math.floor((view.you.paint - 1) / 4)) }]);
      }
    }

    const messages: Submission["messages"][] = [
      [],
      [{ to: null, text: "I favor claims over razes. Let us keep the board productive." }],
      [{ to: null, text: "I will defend my claims. Please respect our borders." }],
    ];
    const leader = view.cogs
      .filter((cog) => cog.alive && cog.seat !== view.you.seat)
      .sort((a, b) => b.banked - a.banked || a.seat - b.seat)[0];
    if (leader) messages.push([{ to: leader.alias, text: "I can avoid your claims if you avoid mine." }]);

    const planById = Object.fromEntries(plans.map((orders, index) => [`p${index}`, orders]));
    const messageById = Object.fromEntries(messages.map((lines, index) => [`m${index}`, lines]));
    const request: JevSystemOneRequest = {
      state: JSON.stringify({
        rules: "Nine seats choose simultaneous orders. Claim productive walls for income. Razing permanently reduces shared yield. Transfers can support allies. Select a legal full turn from the offered choices.",
        view,
        rejected: ctx.reason,
      }),
      questions: {
        plan: {
          type: "choice",
          instructions: "Which complete order set best serves this seat this turn?",
          criteria: Object.fromEntries(Object.entries(planById).map(([id, orders]) => [id, JSON.stringify(orders)])),
        },
        talk: {
          type: "choice",
          instructions: "Which public or private message, if any, should accompany the orders?",
          criteria: Object.fromEntries(Object.entries(messageById).map(([id, lines]) => [id, JSON.stringify(lines)])),
        },
      },
    };
    const result = await client.systemOne(request, ctx.seat).catch((error: unknown) => {
      console.error(JSON.stringify({ kind: "jev_inference_error", seat: ctx.seat, turn: ctx.turn, cause: error instanceof Error ? error.name : "unknown" }));
      return null;
    });
    if (result === null) return { ...scriptedDecide(baseline, view), fallback: true };
    const plan = result.answers.plan;
    const talk = result.answers.talk;
    if (plan?.type !== "choice" || talk?.type !== "choice") throw new Error("Jev returned non-choice answers");
    if (!(plan.choice in planById) || !(talk.choice in messageById)) throw new Error("Jev returned an unknown choice");
    const decision = SubmissionSchema.parse({ orders: planById[plan.choice], messages: messageById[talk.choice] });
    console.log(JSON.stringify({ kind: "jev_decision", seat: ctx.seat, turn: ctx.turn, orders: decision.orders.length, messages: decision.messages.length, usage: result.usage }));
    return decision;
  };
}
