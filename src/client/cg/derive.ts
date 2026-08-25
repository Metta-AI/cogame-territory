// Pure data helpers adapting the recorded snapshot / event stream to the
// Territory panels. No React, no DOM.
//
// Frame alignment: a snapshot with turn T shows the board at the START of turn T —
// i.e. AFTER turn (T-1) resolved. So the events that PRODUCED the displayed board
// are stamped `turn = T-1`, which is what `lastResolvedTurn` returns and what the
// Turn Log and the board reveals read.

import type { GameSnapshot, TileSnapshot } from "../../shared/snapshot";
import type { ClientTurnEvent } from "../../shared/protocol";
import type { StampedEvent } from "../net/feed";

const DIRS: ReadonlyArray<[number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

export const tileKey = (q: number, r: number): string => `${q},${r}`;
export const lastResolvedTurn = (snap: GameSnapshot): number => snap.turn - 1;

/** Per-event activity weight for the scrubber's overview density bars: a raze
 *  weighs far more than a routine income line. */
export const EVENT_W: Record<string, number> = {
  eliminated: 6,
  raze: 4,
  struck: 3,
  smear: 2,
  salvage: 1.5,
  voided: 1.5,
  transfer: 1.5,
  claim: 1,
  talk: 0.6,
  rejected: 0.6,
  income: 0.2,
  dried: 0.1,
  order: 0.1,
};

/** The kinds the wars-started ledger shows: aggression only. Talk lives in the
 *  separate Channels panel. */
export const LEDGER_KINDS = new Set(["raze", "struck", "eliminated", "smear", "voided"]);

export type TileMap = Map<string, TileSnapshot>;
export function tileMap(snap: GameSnapshot): TileMap {
  const m: TileMap = new Map();
  for (const t of snap.tiles) m.set(tileKey(t.q, t.r), t);
  return m;
}

export function neighbors(q: number, r: number, map: TileMap): TileSnapshot[] {
  const out: TileSnapshot[] = [];
  for (const [dq, dr] of DIRS) {
    const n = map.get(tileKey(q + dq, r + dr));
    if (n) out.push(n);
  }
  return out;
}

/** The 7 coordinates of a seat's home ring, from the snapshot's hearth markers. */
export function homeRingKeys(snap: GameSnapshot, seat: number): Set<string> {
  const map = tileMap(snap);
  const hearth = snap.tiles.find((t) => t.hearthOf === seat);
  const out = new Set<string>();
  if (!hearth) return out;
  out.add(tileKey(hearth.q, hearth.r));
  for (const n of neighbors(hearth.q, hearth.r, map)) out.add(tileKey(n.q, n.r));
  return out;
}

/** Seats ranked for the scorebug: by banked score, then seat index. */
export const rankedByScore = (cogs: GameSnapshot["cogs"]): GameSnapshot["cogs"] =>
  [...cogs].sort((a, b) => b.banked - a.banked || a.seat - b.seat);

export const leaderSeat = (snap: GameSnapshot): number => rankedByScore(snap.cogs)[0]?.seat ?? 0;

/** Income per TICK for a seat's per-turn income — the idea's "~0.01/tick per held
 *  wall", scaled x4 so the thinnest wall pays exactly 1 whole paint per turn. */
export const perTick = (perTurn: number, ticksPerTurn: number): string =>
  (perTurn / Math.max(1, ticksPerTurn)).toFixed(2);

/** Owned-wall share per seat, for the scrubber rail's stacked territory bar. */
export function wallShare(snap: GameSnapshot): Array<{ seat: number; n: number }> {
  const counts = new Map<number, number>();
  for (const t of snap.tiles) {
    if (t.owner === null) continue;
    counts.set(t.owner, (counts.get(t.owner) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([seat, n]) => ({ seat, n }));
}

/** Events stamped on `turn`, oldest first. */
export const eventsAt = (events: StampedEvent[], turn: number): ClientTurnEvent[] =>
  events.filter((e) => e.turn === turn).map((e) => e.event);

/** Tiles razed on `turn` — the board's destruction reveal. */
export function razedAt(events: StampedEvent[], turn: number): string[] {
  const out: string[] = [];
  for (const e of events) if (e.turn === turn && e.event.kind === "raze") out.push(e.event.tile);
  return out;
}

/** Tiles claimed on `turn` — the wet-paint reveal. */
export function claimedAt(events: StampedEvent[], turn: number): string[] {
  const out: string[] = [];
  for (const e of events) if (e.turn === turn && e.event.kind === "claim") out.push(e.event.tile);
  return out;
}

/** Tiles smeared on `turn` (two claimants, nobody holds it). */
export function smearedAt(events: StampedEvent[], turn: number): string[] {
  const out: string[] = [];
  for (const e of events) if (e.turn === turn && e.event.kind === "smear") out.push(e.event.tile);
  return out;
}

/** Razes on `turn`, per seat — the scrubber rail's ✖N destruction count. */
export function razeCountAt(events: StampedEvent[], turn: number): number {
  let n = 0;
  for (const e of events) if (e.turn === turn && e.event.kind === "raze") n += 1;
  return n;
}

export const eliminationAt = (events: StampedEvent[], turn: number): boolean =>
  events.some((e) => e.turn === turn && e.event.kind === "eliminated");

/** The beat kind for a turn's rail cell, which drives its CSS class. */
export type BeatKind = "elim" | "raze" | "smear" | "quiet";
export function beatKindAt(events: StampedEvent[], turn: number): BeatKind {
  if (eliminationAt(events, turn)) return "elim";
  if (razeCountAt(events, turn) > 0) return "raze";
  if (smearedAt(events, turn).length > 0) return "smear";
  return "quiet";
}

/**
 * WARS STARTED — distinct ordered pairs (attacker, victim) whose FIRST raze on
 * the victim's ground has occurred, up to and including `turn`. The header
 * counter of the `#feed` ledger. A board where nine seats honour their borders
 * reads 0; a free-for-all reads 30+.
 */
export function warsStarted(events: StampedEvent[], turn: number): Set<string> {
  const wars = new Set<string>();
  for (const e of events) {
    if (e.turn > turn) continue;
    const ev = e.event;
    if (ev.kind !== "raze") continue;
    if (ev.victim === null || ev.victim === ev.seat) continue;
    wars.add(`${ev.seat}>${ev.victim}`);
  }
  return wars;
}

/** The endcard payload, if the episode has ended by `turn`. */
export function endcardAt(events: StampedEvent[]): Extract<ClientTurnEvent, { kind: "endcard" }> | null {
  for (const e of events) if (e.event.kind === "endcard") return e.event;
  return null;
}

export interface TileStatus {
  label: string;
  tone: string;
}

/** Classify a tile for the inspector. */
export function tileStatus(t: TileSnapshot, ownerColor: string): TileStatus {
  if (t.state === "rubble") return { label: "RUBBLE \u00b7 gone forever", tone: "var(--rubble-ink)" };
  if (t.owner === null) {
    if (t.state === "cracked") return { label: "CRACKED \u00b7 unclaimed", tone: "var(--raze)" };
    return { label: t.yield === 0 ? "BARE WALL" : "OPEN WALL", tone: "var(--muted)" };
  }
  if (t.wet) return { label: "WET PAINT \u00b7 dries this upkeep", tone: ownerColor };
  if (t.state === "cracked") return { label: "CRACKED \u00b7 half yield", tone: "var(--raze)" };
  return { label: "HELD \u00b7 paying income", tone: ownerColor };
}
