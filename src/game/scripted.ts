// The two scripted baselines, exactly as the design note specifies them. Both are
// PURE FUNCTIONS of the redacted observation — no state, no clock, deterministic,
// always legal, <= 4 orders. They post NO talk lines, which is why every replay
// CI produces carries zero LLM text (hence the renderer fixture, test 14).
//
// They also double as the LLM policy's fallback move: a seat whose model cannot
// be reached still DOES something rather than holding.

import { distance } from "../shared/engine/hex.js";
import { CLAIM_COST, RAZE_COST, RAZE_HOME_COST } from "../shared/engine/constants.js";
import type { Submission } from "../shared/engine/orders.js";
import type { ObsTile, TerritoryObservation } from "./redact.js";

export const SCRIPTED_NAMES = ["homesteader", "raider"] as const;
export type ScriptedName = (typeof SCRIPTED_NAMES)[number];

export const isScriptedName = (s: string): s is ScriptedName =>
  (SCRIPTED_NAMES as readonly string[]).includes(s);

const parse = (t: string): { q: number; r: number } => {
  const [q, r] = t.split(",");
  return { q: Number(q), r: Number(r) };
};

/** Hex distance from `tile` to the seat's nearest OWNED tile, or — when it owns
 *  nothing — from its hearth. The same predicate the engine's validator uses,
 *  recomputed from the view (which is all a player container has). */
function reachDistance(view: TerritoryObservation, tile: string): number {
  const target = parse(tile);
  const mine = view.tiles.filter((t) => t.owner === view.you.alias);
  const origins = mine.length > 0 ? mine.map((t) => parse(t.t)) : [parse(view.you.hearth)];
  return origins.reduce((best, o) => Math.min(best, distance(o, target)), Infinity);
}

/** Living seats' hearth coordinates — what makes a raze cost RAZE_HOME_COST. */
function foreignHearths(view: TerritoryObservation): Array<{ q: number; r: number }> {
  const alive = new Set(view.cogs.filter((c) => c.alive && c.seat !== view.you.seat).map((c) => c.alias));
  return view.tiles.filter((t) => t.hearthOf !== null && alive.has(t.hearthOf)).map((t) => parse(t.t));
}

/** The paint a raze on `tile` costs this seat, recomputed from the view. */
function razeCostOf(view: TerritoryObservation, tile: string): number {
  const target = parse(tile);
  return foreignHearths(view).some((h) => distance(h, target) <= 1) ? RAZE_HOME_COST : RAZE_COST;
}

const tileOf = (view: TerritoryObservation, key: string): ObsTile | undefined =>
  view.tiles.find((t) => t.t === key);

/**
 * Claim the richest reachable walls affordable, at most `max` of them: candidates
 * keyed by `(−effYield, dist, tileKey)` ASCENDING — richest first, nearest first,
 * then lexicographic on `"q,r"` for total determinism.
 */
function claimPlan(view: TerritoryObservation, budget: number, max: number): { tiles: string[]; spent: number } {
  const ranked = view.reach
    .map((t) => ({ t, y: tileOf(view, t)?.yield ?? 0, d: reachDistance(view, t) }))
    .filter((c) => Number.isFinite(c.d))
    .sort((a, b) => b.y - a.y || a.d - b.d || (a.t < b.t ? -1 : 1));
  const tiles: string[] = [];
  let left = budget;
  let spent = 0;
  for (const c of ranked) {
    if (tiles.length >= max) break;
    const cost = CLAIM_COST(c.d);
    if (cost > left) continue;
    tiles.push(c.t);
    left -= cost;
    spent += cost;
  }
  return { tiles, spent };
}

/** `homesteader` — the certification baseline and filler #1. Claims the richest
 *  reachable wall it can afford, never razes, never transfers. */
export function homesteader(view: TerritoryObservation): Submission {
  const plan = claimPlan(view, view.you.paint, 3);
  return { orders: plan.tiles.map((tile) => ({ type: "claim" as const, tile })), messages: [] };
}

/** `raider` — filler #2. Homesteads through turn 3, then from turn 4 razes the
 *  leader's richest reachable wall before spending the rest like a homesteader. */
export function raider(view: TerritoryObservation): Submission {
  if (view.turn < view.razeOpensTurn) return homesteader(view);

  const rivals = view.cogs.filter((c) => c.alive && c.seat !== view.you.seat);
  const leader = [...rivals].sort((a, b) => b.banked - a.banked || a.seat - b.seat)[0];
  let budget = view.you.paint;
  const orders: Submission["orders"] = [];

  if (leader) {
    const target = view.razeReach
      .map((t) => ({ t, tile: tileOf(view, t) }))
      .filter((c) => c.tile !== undefined && c.tile.owner === leader.alias && c.tile.yield >= 2)
      .sort((a, b) => (b.tile!.yield - a.tile!.yield) || (a.t < b.t ? -1 : 1))[0];
    if (target) {
      const cost = razeCostOf(view, target.t);
      if (cost <= budget) {
        orders.push({ type: "raze", tile: target.t });
        budget -= cost;
      }
    }
  }

  const plan = claimPlan(view, budget, 3);
  for (const tile of plan.tiles) orders.push({ type: "claim", tile });
  return { orders, messages: [] };
}

/** Dispatch a scripted baseline by name. Unknown names fall back to homesteader,
 *  so a typo in a policy env var still plays a legal game. */
export function scriptedDecide(name: string, view: TerritoryObservation): Submission {
  return name === "raider" ? raider(view) : homesteader(view);
}
