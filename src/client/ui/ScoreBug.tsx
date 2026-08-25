// #scorebug — the INCOME-PER-TICK LEADERBOARD the idea asks for.
//
// Nine rows, ranked by banked score, each:
//   swatch · alias · policy-name · banked · +N/turn (0.0N/tick) · ▮×walls · state badge
//
// `staggered` pulses amber (one more strike and the seat is gone); `eliminated`
// greys out and strikes through. At < 640px the `/tick` figure and the policy name
// hide and the row degrades to `swatch · alias · banked` — `.plate-name` keeps the
// alias from collapsing to "…" in the ~360px featured-match iframe.
import React from "react";
import type { GameSnapshot } from "../../shared/snapshot";
import { seatColor } from "../colors";
import { perTick, rankedByScore } from "../cg/derive";
import { CGIcon, SeatName, Swatch } from "../cg/atoms";

export function ScoreBug({
  snapshot,
  focus = null,
  onToggleFocus,
}: {
  snapshot: GameSnapshot;
  /** The spotlighted seat, whose territory the board highlights. */
  focus?: number | null;
  onToggleFocus?: (seat: number) => void;
}): React.ReactElement {
  const ranked = rankedByScore(snapshot.cogs);
  return (
    <div className="cg-panel scorebug" id="scorebug" data-testid="scorebug">
      <div className="cg-panel-head">
        <span className="cg-panel-title">Paint banked</span>
        <span className="cg-mono scorebug-pool" data-tip="board income pool at full claim: start → now">
          pool {snapshot.poolStart} → {snapshot.poolEnd}
        </span>
      </div>
      <div className="cg-panel-body cg-scroll scorebug-rows">
        {ranked.map((c, i) => {
          const dead = c.life === "eliminated";
          const active = focus === c.seat;
          return (
            <button
              type="button"
              key={c.seat}
              className={`plate is-${c.life}${active ? " is-focus" : ""}`}
              data-seat={c.seat}
              data-life={c.life}
              data-testid={`plate-${c.seat}`}
              aria-pressed={active}
              onClick={() => onToggleFocus?.(c.seat)}
              style={{ borderLeftColor: seatColor(c.seat) }}
            >
              <span className="cg-num plate-rank">{i + 1}</span>
              <Swatch seat={c.seat} />
              <SeatName seat={c.seat} />
              <span className="cg-num plate-score" style={{ color: seatColor(c.seat) }}>
                {c.banked}
              </span>
              <span className="cg-mono plate-rate" data-tip="income per turn, and the same figure per sim tick">
                +{c.incomeLastTurn}/turn
                <span className="plate-tick"> ({perTick(c.incomeLastTurn, snapshot.ticksPerTurn)}/tick)</span>
              </span>
              <span className="cg-mono plate-walls" data-tip="walls held">
                ▮×{c.walls}
              </span>
              <span className="plate-badge">
                {dead ? (
                  <CGIcon name="skull" size={13} title="eliminated" />
                ) : c.life === "staggered" ? (
                  <span className="badge-staggered">STAGGERED</span>
                ) : (
                  <span className="badge-steady">·</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
