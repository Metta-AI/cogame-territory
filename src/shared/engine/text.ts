// Rune-safe string handling and the one-line event renderers. Every string that
// reaches the replay passes through here.
//
// TRUNCATION IS ON RUNE BOUNDARIES. `truncateRunes` slices by Unicode code point
// (`Array.from(s).slice(0, cap).join("")`), never by byte and never by UTF-16
// code unit, so no lone surrogate and no partial multi-byte sequence can reach
// the replay. A byte-boundary truncation is what makes replay bytes fail a
// strict JSON parser while still rendering in a browser; text.test.ts asserts the
// round trip under `new TextDecoder("utf-8", { fatal: true })`.

import type { ResolveEvent, UpkeepEvent, TurnEvent } from "./log";

/** The first `cap` Unicode code points of `s`. Never splits a surrogate pair. */
export function truncateRunes(s: string, cap: number): string {
  if (cap <= 0) return "";
  const runes = Array.from(s);
  return runes.length <= cap ? s : runes.slice(0, cap).join("");
}

/** Cap a recorded string at `cap` CODE POINTS, appending `…` when it was cut.
 *  The ellipsis is inside the cap, so the result is never longer than `cap`
 *  runes — the property text.test.ts pins. */
export function capText(s: string, cap: number): string {
  const runes = Array.from(s);
  if (runes.length <= cap) return s;
  return `${truncateRunes(s, Math.max(0, cap - 1))}\u2026`;
}

/** Number of Unicode code points in `s` (what every cap in this game counts). */
export const runeLength = (s: string): number => Array.from(s).length;

const T = (turn: number): string => `T${turn}`;

/** One public line for a resolve-phase event. Aliases only — never a policy name. */
export function renderResolveEvent(ev: ResolveEvent, alias: (seat: number) => string): string {
  switch (ev.kind) {
    case "order":
      return `${alias(ev.seat)} ${ev.order.type}${"tile" in ev.order ? ` ${ev.order.tile}` : ` ${ev.order.amount}→${ev.order.to}`}`;
    case "rejected":
      return `${alias(ev.seat)} rejected: ${ev.reason}`;
    case "talk":
      return ev.to === null ? `${alias(ev.seat)}: ${ev.text}` : `${alias(ev.seat)} → ${alias(ev.to)}: ${ev.text}`;
    case "raze":
      return (
        `${alias(ev.seat)} razed ${ev.tile}` +
        `${ev.victim === null ? "" : ` (${alias(ev.victim)})`} → ${ev.to_state}` +
        ` · yield ${ev.yield_before}→${ev.yield_after}`
      );
    case "salvage":
      return `${alias(ev.seat)} salvaged ${ev.tile} for ${ev.paint} paint`;
    case "struck":
      return `${alias(ev.seat)} struck in its home ring by ${ev.by.map(alias).join(", ")}`;
    case "claim":
      return `${alias(ev.seat)} claimed ${ev.tile} (yield ${ev.yield})`;
    case "smear":
      return `${ev.seats.map(alias).join(" and ")} smeared ${ev.tile} — nobody holds it`;
    case "voided":
      return `${alias(ev.seat)} wasted paint on ${ev.tile} (${ev.reason})`;
    case "transfer":
      return `${alias(ev.from)} sent ${ev.amount} paint to ${alias(ev.to)}`;
  }
}

/** One public line for an upkeep-phase event. */
export function renderUpkeepEvent(ev: UpkeepEvent, alias: (seat: number) => string): string {
  switch (ev.kind) {
    case "dried":
      return `${ev.tiles.length} tile${ev.tiles.length === 1 ? "" : "s"} dried`;
    case "income":
      return `${alias(ev.seat)} earned ${ev.paint} paint from ${ev.walls} wall${ev.walls === 1 ? "" : "s"}`;
    case "recovered":
      return `${alias(ev.seat)} recovered — no strike this turn`;
    case "eliminated":
      return `${alias(ev.seat)} was ELIMINATED; ${ev.tilesReverted} tiles reverted`;
    case "endcard":
      return `episode over (${ev.reason}) after ${ev.turnsPlayed} turns · pool ${ev.poolStart}→${ev.poolEnd}`;
  }
}

/** One public line for any turn event, prefixed with its turn. */
export function renderEvent(turn: number, ev: TurnEvent, alias: (seat: number) => string): string {
  const body = "order" in ev || ev.kind === "rejected" || ev.kind === "talk" || ev.kind === "raze" || ev.kind === "salvage" || ev.kind === "struck" || ev.kind === "claim" || ev.kind === "smear" || ev.kind === "voided" || ev.kind === "transfer"
    ? renderResolveEvent(ev as ResolveEvent, alias)
    : renderUpkeepEvent(ev as UpkeepEvent, alias);
  return `${T(turn)} ${body}`;
}
