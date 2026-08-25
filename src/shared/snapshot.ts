// A full, serializable view of one turn: every tile plus every seat's PUBLIC
// state. This is what `redact(state, null)` returns, what rides in
// `Snapshot.state` on the wire, and the only thing the replay viewer renders —
// so the viewer re-derives each frame with no server and no interpolation.

import type { EndReason, GameState, LifeState, TileState, Variant } from "./engine/types";
import {
  BOARD_RADIUS,
  effYield,
  FLING_RANGE,
  RAZE_OPEN_TURN,
  SALVAGE_MULT,
  TICKS_PER_TURN,
} from "./engine/constants";
import { incomePool } from "./engine/board";
import { TERRITORY_VERSION } from "./version";

export interface TileSnapshot {
  q: number;
  r: number;
  state: TileState;
  /** The seeded base yield, 0..3 — what the wall was worth before any raze. */
  yield: number;
  /** The yield it actually pays now: wall → yield, cracked → floor/2, rubble → 0. */
  effYield: number;
  owner: number | null;
  wet: boolean;
  /** The seat whose permanent home-ring CENTRE this coordinate is, if any. */
  hearthOf: number | null;
}

export interface CogSnapshot {
  seat: number;
  alias: string;
  life: LifeState;
  /** Spectator-side only: an agent never sees another seat's war chest. */
  paint: number;
  banked: number;
  walls: number;
  incomeLastTurn: number;
  razesMade: number;
  fallbacks: number;
}

export interface GameSnapshot {
  version: string;
  seed: number;
  turn: number;
  turns: number;
  phase: GameState["phase"];
  variant: Variant;
  radius: number;
  ticksPerTurn: number;
  razeOpensTurn: number;
  flingRange: number;
  salvageMult: number;
  poolStart: number;
  poolEnd: number;
  destroyed: number;
  warsStarted: number;
  settled: EndReason | null;
  tiles: TileSnapshot[];
  cogs: CogSnapshot[];
}

/** Project the live GameState into the flat public snapshot. Pure. */
export function toSnapshot(state: GameState): GameSnapshot {
  const hearthOf = new Map<string, number>();
  for (const cog of state.cogs) hearthOf.set(`${cog.hearth.q},${cog.hearth.r}`, cog.seat);
  const tiles: TileSnapshot[] = Object.entries(state.tiles).map(([k, t]) => ({
    q: t.hex.q,
    r: t.hex.r,
    state: t.state,
    yield: t.yield,
    effYield: effYield(t),
    owner: t.owner,
    wet: t.wet,
    hearthOf: hearthOf.get(k) ?? null,
  }));
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
    poolStart: state.poolStart,
    poolEnd: incomePool(state.tiles),
    destroyed: state.destroyed,
    warsStarted: state.wars.length,
    settled: state.settled,
    tiles,
    cogs: state.cogs.map((c) => ({
      seat: c.seat,
      alias: c.alias,
      life: c.life,
      paint: c.paint,
      banked: c.banked,
      walls: c.wallsHeld,
      incomeLastTurn: c.incomeLastTurn,
      razesMade: c.razesMade,
      fallbacks: c.fallbacks,
    })),
  };
}
