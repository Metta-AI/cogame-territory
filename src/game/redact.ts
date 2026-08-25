// Per-seat redaction: the observation handed to seat k. Territory is FULLY
// OBSERVABLE — it is a negotiation game, not a fog game — so the whole board is
// visible. Exactly four things are hidden:
//
//   * every other seat's PAINT BALANCE  (you cannot count a rival's war chest —
//     the one number that makes threats bluffable);
//   * every other seat's PENDING ORDERS (the turn is simultaneous);
//   * DMs you are not party to;
//   * the REAL POLICY NAMES of every seat, including your own. Agents see the
//     nine fixed anonymous aliases and nothing else.
//
// `reach` / `razeReach` are private conveniences, not information: they are
// computed by the SAME predicate the validator applies, which is the escrow-0.1.3
// precomputed-choice-set fix for formal-output fallback storms — the model never
// has to derive the legal set.

import type { GameState, LifeState } from "../shared/engine/types.js";
import { key } from "../shared/engine/hex.js";
import {
  BOARD_RADIUS,
  effYield,
  FLING_RANGE,
  MAX_ORDERS_PER_TURN,
  RAZE_OPEN_TURN,
  SALVAGE_MULT,
  TICKS_PER_TURN,
} from "../shared/engine/constants.js";
import { legalClaimTargets, legalRazeTargets } from "../shared/engine/orders.js";
import { renderEvent } from "../shared/engine/text.js";
import { TERRITORY_VERSION } from "../shared/version.js";

export interface ObsTile {
  /** The tile address, `"q,r"`. */
  t: string;
  state: "wall" | "cracked" | "rubble";
  yield: number;
  /** The owner's ALIAS, or null for unclaimed ground. */
  owner: string | null;
  wet: boolean;
  /** The alias whose permanent home-ring centre this coordinate is, if any. */
  hearthOf: string | null;
}

export interface ObsCog {
  seat: number;
  alias: string;
  state: LifeState;
  walls: number;
  incomeLastTurn: number;
  banked: number;
  razesMade: number;
  alive: boolean;
}

export interface ObsInboxLine {
  from: string;
  scope: "public" | "dm";
  text: string;
  turn: number;
}

export interface TerritoryObservation {
  version: string;
  seed: number;
  turn: number;
  turns: number;
  phase: GameState["phase"];
  variant: GameState["variant"];
  radius: number;
  ticksPerTurn: number;
  razeOpensTurn: number;
  flingRange: number;
  salvageMult: number;
  maxOrders: number;
  you: {
    seat: number;
    alias: string;
    paint: number;
    hearth: string;
    state: LifeState;
    walls: number;
    incomeLastTurn: number;
    banked: number;
  };
  cogs: ObsCog[];
  tiles: ObsTile[];
  reach: string[];
  razeReach: string[];
  lastTurn: {
    rejected: string | null;
    razedAgainstYou: string[];
    smeared: string[];
    struckBy: string[];
    salvage: number;
  };
  inbox: ObsInboxLine[];
  log: string[];
}

/** Build the observation for `seat` from the authoritative state. Pure. */
export function observe(state: GameState, seat: number): TerritoryObservation {
  const me = state.cogs[seat]!;
  const aliasOf = (s: number): string => state.cogs[s]?.alias ?? `seat ${s}`;
  const hearthOwner = new Map<string, number>();
  for (const cog of state.cogs) hearthOwner.set(key(cog.hearth), cog.seat);

  const tiles: ObsTile[] = Object.entries(state.tiles)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, t]) => ({
      t: k,
      state: t.state,
      yield: effYield(t),
      owner: t.owner === null ? null : aliasOf(t.owner),
      wet: t.wet,
      hearthOf: hearthOwner.has(k) ? aliasOf(hearthOwner.get(k)!) : null,
    }));

  const last = state.log[state.log.length - 1];
  const lastTurn: TerritoryObservation["lastTurn"] = {
    rejected: null,
    razedAgainstYou: [],
    smeared: [],
    struckBy: [],
    salvage: 0,
  };
  if (last) {
    for (const ev of last.events) {
      switch (ev.kind) {
        case "rejected":
          if (ev.seat === seat) lastTurn.rejected = ev.reason;
          break;
        case "raze":
          if (ev.victim === seat && ev.seat !== seat) lastTurn.razedAgainstYou.push(ev.tile);
          break;
        case "smear":
          if (ev.seats.includes(seat)) lastTurn.smeared.push(ev.tile);
          break;
        case "struck":
          if (ev.seat === seat) lastTurn.struckBy = ev.by.map(aliasOf);
          break;
        case "salvage":
          if (ev.seat === seat) lastTurn.salvage += ev.paint;
          break;
        default:
          break;
      }
    }
  }

  const inbox: ObsInboxLine[] = state.talk
    .filter((m) => m.to === null || m.to === seat || m.from === seat)
    .slice(-12)
    .map((m) => ({
      from: aliasOf(m.from),
      scope: m.to === null ? "public" : "dm",
      text: m.text,
      turn: m.turn,
    }));

  // The last 12 PUBLIC event one-liners — the shared history every seat reads.
  const log: string[] = [];
  for (const rec of state.log.slice(-3)) {
    for (const ev of rec.events) {
      if (ev.kind === "order" || ev.kind === "talk" || ev.kind === "dried" || ev.kind === "endcard") continue;
      log.push(renderEvent(rec.turn, ev, aliasOf));
    }
  }

  return {
    version: TERRITORY_VERSION,
    seed: state.seed,
    turn: state.turn,
    turns: state.turns,
    phase: state.phase,
    variant: state.variant,
    radius: BOARD_RADIUS,
    ticksPerTurn: TICKS_PER_TURN,
    razeOpensTurn: RAZE_OPEN_TURN,
    flingRange: FLING_RANGE,
    salvageMult: SALVAGE_MULT,
    maxOrders: MAX_ORDERS_PER_TURN,
    you: {
      seat,
      alias: me.alias,
      paint: me.paint,
      hearth: key(me.hearth),
      state: me.life,
      walls: me.wallsHeld,
      incomeLastTurn: me.incomeLastTurn,
      banked: me.banked,
    },
    cogs: state.cogs.map((c) => ({
      seat: c.seat,
      alias: c.alias,
      state: c.life,
      walls: c.wallsHeld,
      incomeLastTurn: c.incomeLastTurn,
      banked: c.banked,
      razesMade: c.razesMade,
      alive: c.life !== "eliminated",
    })),
    tiles,
    reach: legalClaimTargets(state, seat),
    razeReach: legalRazeTargets(state, seat),
    lastTurn,
    inbox,
    log: log.slice(-12),
  };
}
