// #feed — the WARS-STARTED LEDGER.
//
// A header counter `wars started: N` (N = distinct ordered pairs (attacker,
// victim) whose FIRST raze on the victim's ground has occurred) over a scrolling
// list of the AGGRESSION events only — raze, struck, eliminated, smear, voided —
// each a plain sentence:
//
//   T7 · Ochre razed 3,-2 (Sable) → cracked · yield 3→1
//
// Talk lines live in the separate Channels panel (public and, spectator-side
// only, DMs), so this panel is the violence and nothing else.
import React from "react";
import type { ClientTurnEvent } from "../../shared/protocol";
import type { StampedEvent } from "../net/feed";
import { seatAlias, seatColor } from "../colors";
import { LEDGER_KINDS, warsStarted } from "../cg/derive";
import { publishTileHighlight } from "../cg/tile-highlight";

const alias = (seat: number): string => seatAlias(seat);

/** One plain sentence per aggression event, and the tiles it is about. */
function sentence(ev: ClientTurnEvent): { text: string; tiles: string[]; seat: number | null } | null {
  switch (ev.kind) {
    case "raze":
      return {
        text:
          `${alias(ev.seat)} razed ${ev.tile}` +
          `${ev.victim === null ? "" : ` (${alias(ev.victim)})`} → ${ev.to_state}` +
          ` · yield ${ev.yield_before}→${ev.yield_after}`,
        tiles: [ev.tile],
        seat: ev.seat,
      };
    case "struck":
      return {
        text: `${alias(ev.seat)} was struck in its home ring by ${ev.by.map(alias).join(", ")} — one more and it is gone`,
        tiles: [],
        seat: ev.seat,
      };
    case "eliminated":
      return {
        text: `${alias(ev.seat)} was ELIMINATED — ${ev.tilesReverted} tiles reverted to unclaimed ground`,
        tiles: [],
        seat: ev.seat,
      };
    case "smear":
      return {
        text: `${ev.seats.map(alias).join(" and ")} smeared ${ev.tile} — nobody holds it and both paid in full`,
        tiles: [ev.tile],
        seat: ev.seats[0] ?? null,
      };
    case "voided":
      return {
        text: `${alias(ev.seat)} wasted paint on ${ev.tile} (${ev.reason === "rubble" ? "razed to rubble first" : "already held"})`,
        tiles: [ev.tile],
        seat: ev.seat,
      };
    default:
      return null;
  }
}

export function WarLedger({
  events,
  turn,
}: {
  events: StampedEvent[];
  /** The turn the shown board is at; only events up to here are visible. */
  turn: number;
}): React.ReactElement {
  const wars = warsStarted(events, turn);
  const rows: Array<{ turn: number; text: string; tiles: string[]; seat: number | null }> = [];
  for (const e of events) {
    if (e.turn > turn) continue;
    if (!LEDGER_KINDS.has(e.event.kind)) continue;
    const s = sentence(e.event);
    if (s) rows.push({ turn: e.turn, ...s });
  }
  const shown = rows.slice(-60).reverse();

  return (
    <div className="cg-panel warledger" data-testid="warledger">
      <div className="cg-panel-head">
        <span className="cg-panel-title">Wars started</span>
        <span className="cg-num warledger-count" data-tip="distinct attacker→victim pairs whose first raze has landed">
          {wars.size}
        </span>
      </div>
      <div className="cg-panel-body cg-scroll warledger-rows" id="feed">
        {shown.length === 0 && <div className="cg-mono warledger-quiet">no shot fired yet.</div>}
        {shown.map((r, i) => (
          <div
            key={`${r.turn}-${i}`}
            className="warledger-row"
            onMouseEnter={() => publishTileHighlight(r.tiles)}
            onMouseLeave={() => publishTileHighlight([])}
          >
            <span className="cg-mono warledger-turn">T{String(r.turn).padStart(2, "0")}</span>
            {r.seat !== null && (
              <span className="cg-swatch" style={{ background: seatColor(r.seat) }} />
            )}
            <span className="cg-mono warledger-text">{r.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
