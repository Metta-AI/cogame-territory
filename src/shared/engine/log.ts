// The per-turn record stored in GameState.log: a flattened list of the
// Resolve- and Upkeep-phase events, enough to drive the replay and the viewer.
// Types only (`import type`), so the type-level cycle types.ts <-> log.ts <->
// resolve/upkeep erases at runtime.
//
// EVENT VOCABULARY — this list is the whole vocabulary written to the replay
// (`kind` on every FeedEvent, `data` = the typed event). The viewer draws from
// it and nothing else:
//
//   order · rejected · talk · raze · salvage · struck · claim · smear · voided ·
//   transfer · income · dried · recovered · eliminated · endcard

import type { HexKey, TileState, EndReason } from "./types";
import type { Order } from "./orders";

/** Every `kind` the engine can emit, in declaration order. */
export const EVENT_KINDS = [
  "order",
  "rejected",
  "talk",
  "raze",
  "salvage",
  "struck",
  "claim",
  "smear",
  "voided",
  "transfer",
  "income",
  "dried",
  "recovered",
  "eliminated",
  "endcard",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** Events emitted by steps 2–8 (resolve.ts). */
export type ResolveEvent =
  /** One order exactly as played, ahead of its consequences. */
  | { kind: "order"; seat: number; order: Order; cost: number }
  | { kind: "rejected"; seat: number; reason: string }
  | { kind: "talk"; seat: number; to: number | null; text: string }
  | {
      kind: "raze";
      seat: number;
      tile: HexKey;
      from_state: TileState;
      to_state: TileState;
      /** The seat that owned the tile at the start of Resolve, if any. */
      victim: number | null;
      yield_before: number;
      yield_after: number;
    }
  | { kind: "salvage"; seat: number; tile: HexKey; paint: number }
  | { kind: "struck"; seat: number; by: number[] }
  | { kind: "claim"; seat: number; tile: HexKey; yield: number }
  | { kind: "smear"; tile: HexKey; seats: number[] }
  | { kind: "voided"; seat: number; tile: HexKey; reason: "rubble" | "owned" }
  | { kind: "transfer"; from: number; to: number; amount: number };

/** Events emitted by step 9a–9e (upkeep.ts / life.ts). */
export type UpkeepEvent =
  | { kind: "dried"; tiles: HexKey[] }
  | { kind: "income"; seat: number; paint: number; walls: number }
  | { kind: "recovered"; seat: number }
  | { kind: "eliminated"; seat: number; tilesReverted: number }
  | {
      kind: "endcard";
      reason: EndReason;
      turnsPlayed: number;
      scores: number[];
      walls: number[];
      destroyed: number;
      poolStart: number;
      poolEnd: number;
      warsStarted: number;
    };

/** A single resolve- or upkeep-phase event within a turn. */
export type TurnEvent = ResolveEvent | UpkeepEvent;

/** The record of one completed turn, appended to GameState.log. */
export interface TurnRecord {
  turn: number;
  events: TurnEvent[];
  /** Banked score per seat after the turn (seat-ordered). */
  banked: number[];
}
